/**
 * cdpPipeBrowser - Starts the pinned headless shell for the life of the scope
 * and speaks the Chrome DevTools Protocol with it over
 * `--remote-debugging-pipe` (fd 3 in, fd 4 out, NUL-delimited JSON): never a
 * TCP port another process could attach to. Scope close kills the process
 * group.
 *
 * HTML previews (`headlessChrome.ts`) and node browser tabs share it; each
 * brings its own flags and handles its own events.
 *
 * @module cdpPipeBrowser
 */
import { Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type CdpFrameLimits, makeCdpFrameReader } from "./cdpFrameReader.ts";

/** An event Chrome sent, for a page's session or for the browser itself. */
export interface CdpEvent {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly params: unknown;
}

/** What went wrong, for the caller's own error. */
export interface CdpBrowserFailure {
  readonly reason: string;
  readonly cause?: unknown;
  /** The end of the browser's stderr when it exited, for diagnosing host setup. */
  readonly output?: string;
}

export interface CdpPipeBrowserOptions<E> {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly limits: CdpFrameLimits;
  readonly failure: (input: CdpBrowserFailure) => E;
  /** Runs on the raw text of each event before it is parsed; `true` drops it unread. */
  readonly skipEvent?: (raw: string) => boolean;
  /**
   * Every event, in order, on the one fiber reading the pipe. It must not wait
   * on a command's reply, which only this fiber can deliver: fork that work.
   */
  readonly onEvent: (event: CdpEvent) => Effect.Effect<void>;
  /** An event past its limit, known only by its start and end. */
  readonly onOversizedEvent?: (head: string, tail: string) => Effect.Effect<void>;
  /** Runs once when the browser exits on its own, after every waiting command failed. */
  readonly onExit?: (error: E) => Effect.Effect<void>;
}

export interface CdpPipeBrowser<E> {
  /** Sends a command and decodes its reply. */
  readonly send: <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ) => Effect.Effect<A, E>;
  /** A command whose reply nobody awaits; replies without a waiter are dropped. */
  readonly post: (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => Effect.Effect<void>;
  /**
   * A command written in parts, queued together, so a large body between two
   * small JSON halves is never copied. `parts` gets the command's id.
   */
  readonly postParts: (parts: (id: number) => ReadonlyArray<Uint8Array>) => Effect.Effect<void>;
  /**
   * Fails every command still waiting on the session: Chrome never answers a
   * session whose target closed. Done on its own when the session detaches or
   * its page crashes.
   */
  readonly failSession: (sessionId: string) => Effect.Effect<void>;
  /** Fails with the reason once the browser has exited on its own. */
  readonly exited: Effect.Effect<never, E>;
}

const CdpMessage = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    method: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Unknown),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);
const decodeCdpMessage = Schema.decodeUnknownOption(CdpMessage);
const decodeDetached = Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }));
const encodeCdpCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const textEncoder = new TextEncoder();
const STDERR_TAIL_CHARS = 4_096;

export const launchCdpPipeBrowser = Effect.fnUntraced(function* <E>(
  options: CdpPipeBrowserOptions<E>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(options.executable, [...options.args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        forceKillAfter: "2 seconds",
        additionalFds: {
          fd3: { type: "input", stream: Stream.fromQueue(outgoing) },
          fd4: { type: "output" },
        },
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        options.failure({ reason: "the browser could not be started", cause }),
      ),
    );

  let stderrTail = "";
  const stderrReader = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const pending = new Map<
    number,
    {
      readonly method: string;
      readonly sessionId: string | undefined;
      readonly reply: Deferred.Deferred<unknown, E>;
    }
  >();
  const exited = yield* Deferred.make<never, E>();
  let disconnected: E | undefined;
  let nextId = 0;

  const command = (id: number, method: string, params: unknown, sessionId?: string) =>
    textEncoder.encode(
      `${encodeCdpCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
    );

  const post = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    Queue.offer(outgoing, command(++nextId, method, params, sessionId)).pipe(Effect.asVoid);

  const postParts = (parts: (id: number) => ReadonlyArray<Uint8Array>) =>
    Queue.offerAll(outgoing, parts(++nextId)).pipe(Effect.asVoid);

  const failSession = (sessionId: string) =>
    Effect.suspend(() => {
      const waiting = [...pending].filter(([, waiter]) => waiter.sessionId === sessionId);
      for (const [id] of waiting) pending.delete(id);
      return Effect.forEach(
        waiting,
        ([, waiter]) =>
          Deferred.fail(
            waiter.reply,
            options.failure({ reason: `${waiter.method} ended with its session` }),
          ),
        { discard: true },
      );
    });

  const receive = (raw: string) => {
    if (options.skipEvent && !raw.startsWith('{"id":') && options.skipEvent(raw)) {
      return Effect.void;
    }
    const message = Option.getOrUndefined(decodeCdpMessage(raw));
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return Effect.void;
      return message.error
        ? Deferred.fail(
            waiter.reply,
            options.failure({ reason: `${waiter.method} failed`, cause: message.error.message }),
          )
        : Deferred.succeed(waiter.reply, message.result);
    }
    if (!message?.method) return Effect.void;
    const event = { method: message.method, sessionId: message.sessionId, params: message.params };
    // A session that is gone, or whose page crashed, answers nothing more.
    const ended =
      event.method === "Target.detachedFromTarget"
        ? Option.getOrUndefined(decodeDetached(event.params))?.sessionId
        : event.method === "Inspector.targetCrashed"
          ? event.sessionId
          : undefined;
    return ended === undefined
      ? options.onEvent(event)
      : Effect.andThen(failSession(ended), options.onEvent(event));
  };

  /** A message past its limit, known only by its start and end. */
  const receiveOversized = (head: string, tail: string) => {
    const id = /^\{"id":(\d+)/.exec(head)?.[1];
    if (id === undefined) return options.onOversizedEvent?.(head, tail) ?? Effect.void;
    const waiter = pending.get(Number(id));
    pending.delete(Number(id));
    return waiter
      ? Deferred.fail(
          waiter.reply,
          options.failure({ reason: `${waiter.method} replied with too much data` }),
        )
      : Effect.void;
  };

  // The pipe closes when the browser exits. A startup abort, such as a missing
  // sandbox or shared library, says why on stderr, which may still be
  // draining, so give it a moment.
  const disconnect = Effect.gen(function* () {
    yield* Fiber.await(stderrReader).pipe(Effect.timeout("1 second"), Effect.ignore);
    const error = options.failure({
      reason: "the browser exited unexpectedly",
      output: stderrTail,
    });
    disconnected = error;
    const waiters = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiters, ({ reply }) => Deferred.fail(reply, error), { discard: true });
    yield* Deferred.fail(exited, error);
    if (options.onExit) yield* options.onExit(error);
  });

  // Decoded text chunks may split a message anywhere, and a large reply spans many.
  const frames = makeCdpFrameReader(options.limits);
  yield* child.getOutputFd(4).pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.forEach(
        frames.push(text),
        (frame) =>
          frame._tag === "Message" ? receive(frame.text) : receiveOversized(frame.head, frame.tail),
        { discard: true },
      ),
    ),
    Effect.ignore,
    // Interruption means the scope is closing on purpose; only an exit disconnects.
    Effect.andThen(disconnect),
    Effect.forkScoped,
  );

  const send = <A>(
    method: string,
    params: Record<string, unknown>,
    result: Schema.Decoder<A>,
    sessionId?: string,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      if (disconnected !== undefined) return yield* Effect.fail(disconnected);
      const id = ++nextId;
      const reply = yield* Deferred.make<unknown, E>();
      pending.set(id, { method, sessionId, reply });
      yield* Queue.offer(outgoing, command(id, method, params, sessionId));
      // A caller that stops waiting (a timeout) leaves nothing behind.
      const value = yield* Deferred.await(reply).pipe(
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      return yield* Schema.decodeUnknownEffect(result)(value).pipe(
        Effect.mapError((cause) =>
          options.failure({ reason: `${method} returned an unexpected result`, cause }),
        ),
      );
    });

  return {
    send,
    post,
    postParts,
    failSession,
    exited: Deferred.await(exited),
  } satisfies CdpPipeBrowser<E>;
});
