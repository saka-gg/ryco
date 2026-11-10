import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Stream } from "effect";
import {
  type TerminalEvent,
  type TerminalSessionSnapshot,
  type TerminalSubscribeEventsInput,
  WS_METHODS,
} from "@ryco/contracts";

import { makeConnectionVisibility } from "./connectionVisibility.ts";
import type { WsRpcContext } from "./context.ts";
import { makeTerminalBackgroundHold } from "./terminalOutputScope.ts";
import { makeTerminalHandlers, terminalEventBytes } from "./terminalRpc.ts";

const generation = "gen";
let sequence = 10;
const at = () => ({ generation, sequence: ++sequence });

const output = (terminalId: string, data: string): TerminalEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId,
  createdAt: "2026-11-10T00:00:00.000Z",
  cursor: at(),
  data,
});

const activity = (terminalId: string, hasRunningSubprocess: boolean): TerminalEvent => ({
  type: "activity",
  threadId: "thread-1",
  terminalId,
  createdAt: "2026-11-10T00:00:00.000Z",
  cursor: at(),
  hasRunningSubprocess,
});

const exited = (terminalId: string): TerminalEvent => ({
  type: "exited",
  threadId: "thread-1",
  terminalId,
  createdAt: "2026-11-10T00:00:00.000Z",
  cursor: at(),
  exitCode: 0,
  exitSignal: null,
});

const snapshot = (terminalId: string): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/tmp",
  worktreePath: null,
  status: "running",
  pid: 1,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-10T00:00:00.000Z",
  cursor: { generation, sequence: 1 },
});

/** One connection: its handlers share attachments and visibility, as a socket's do. */
const connection = () => {
  let listener: (event: TerminalEvent) => Effect.Effect<void> = () => Effect.void;
  const visibility = makeConnectionVisibility();
  const handlers = makeTerminalHandlers({
    ownerEffect: (_method: string, effect: Effect.Effect<unknown>) => effect,
    ownerStream: (_method: string, stream: Stream.Stream<unknown>) => stream,
    connectionVisibility: visibility,
    terminalManager: {
      subscribe: (next: typeof listener) =>
        Effect.sync(() => {
          listener = next;
          return () => undefined;
        }),
      listSessions: Effect.succeed([]),
      listDiagnostics: Effect.succeed([]),
      // Output the PTY prints while the open is answered reaches an attached connection.
      open: (input: { terminalId: string }) =>
        Effect.gen(function* () {
          yield* listener(output(input.terminalId, "during open"));
          return snapshot(input.terminalId);
        }),
    },
  } as unknown as WsRpcContext);
  return {
    handlers,
    visibility,
    emit: (event: TerminalEvent) => listener(event),
    subscribe: (input: TerminalSubscribeEventsInput) =>
      handlers[WS_METHODS.subscribeTerminalEvents](input),
  };
};

/** Collects stream items in the background; `take` waits until `count` arrived. */
const collect = (stream: Stream.Stream<unknown, unknown>) =>
  Effect.gen(function* () {
    const items: unknown[] = [];
    const fiber = yield* stream.pipe(
      Stream.runForEach((item) => Effect.sync(() => items.push(item))),
      Effect.forkScoped,
    );
    const settle = Effect.gen(function* () {
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    });
    return { items, fiber, settle };
  });

const typesOf = (items: ReadonlyArray<unknown>) =>
  items.map((item) => {
    const event = item as { type: string; terminalId?: string; data?: string };
    return event.type === "output"
      ? `output:${event.terminalId}:${event.data}`
      : event.terminalId
        ? `${event.type}:${event.terminalId}`
        : event.type;
  });

describe("scoped terminal output", () => {
  it.effect("acknowledges first and sends output only for attached terminals", () =>
    Effect.gen(function* () {
      const node = connection();
      const stream = yield* collect(
        node.subscribe({
          replay: "metadata",
          output: { attached: [{ threadId: "thread-1", terminalId: "shown" }] },
        }),
      );
      yield* stream.settle;
      yield* node.emit(output("hidden", "a"));
      yield* node.emit(output("shown", "b"));
      yield* node.emit(activity("hidden", true));
      yield* node.emit(exited("hidden"));
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), [
        "outputScope",
        "output:shown:b",
        "activity:hidden",
        "exited:hidden",
      ]);
    }),
  );

  it.effect(
    "keeps today's stream for clients that do not ask: every output, no acknowledgement",
    () =>
      Effect.gen(function* () {
        const node = connection();
        const stream = yield* collect(node.subscribe({ replay: "metadata" }));
        yield* stream.settle;
        yield* node.emit(output("hidden", "a"));
        yield* node.emit(output("shown", "b"));
        yield* stream.settle;
        assert.deepEqual(typesOf(stream.items), ["output:hidden:a", "output:shown:b"]);
      }),
  );

  it.effect("attaches on open before the snapshot, and detaches", () =>
    Effect.gen(function* () {
      const node = connection();
      const stream = yield* collect(
        node.subscribe({ replay: "metadata", output: { attached: [] } }),
      );
      yield* stream.settle;
      yield* node.handlers[WS_METHODS.terminalOpen]({
        threadId: "thread-1",
        terminalId: "t",
        cwd: "/tmp",
        attachOutput: true,
      });
      yield* node.emit(output("t", "live"));
      yield* node.handlers[WS_METHODS.terminalDetachOutput]({
        threadId: "thread-1",
        terminalId: "t",
      });
      yield* node.emit(output("t", "after detach"));
      // An open without `attachOutput` does not attach.
      yield* node.handlers[WS_METHODS.terminalOpen]({
        threadId: "thread-1",
        terminalId: "u",
        cwd: "/tmp",
      });
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), [
        "outputScope",
        "output:t:during open",
        "output:t:live",
      ]);
    }),
  );

  it.effect("holds events in the background and releases them merged on return", () =>
    Effect.gen(function* () {
      const node = connection();
      const stream = yield* collect(
        node.subscribe({
          replay: "metadata",
          output: { attached: [{ threadId: "thread-1", terminalId: "t" }] },
        }),
      );
      yield* stream.settle;
      node.visibility.set("background");
      yield* node.emit(output("t", "a"));
      yield* node.emit(output("t", "b"));
      yield* node.emit(activity("t", true));
      yield* node.emit(activity("t", false));
      yield* node.emit(output("t", "c"));
      yield* node.emit(exited("t"));
      yield* node.emit(output("other", "never"));
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), ["outputScope"]);
      node.visibility.set("foreground");
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), [
        "outputScope",
        "output:t:ab",
        "activity:t",
        "output:t:c",
        "exited:t",
      ]);
      const merged = stream.items[1] as Extract<TerminalEvent, { type: "output" }>;
      const activityEvent = stream.items[2] as Extract<TerminalEvent, { type: "activity" }>;
      // The merged event carries the cursor of its last part; activity keeps the newest state.
      assert.equal(activityEvent.hasRunningSubprocess, false);
      assert.isTrue((merged.cursor?.sequence ?? 0) < (activityEvent.cursor?.sequence ?? 0));
      yield* node.emit(output("t", "live again"));
      yield* stream.settle;
      assert.equal(typesOf(stream.items).at(-1), "output:t:live again");
    }),
  );

  it.effect("ends with the resync error on return when the background outgrew its budget", () =>
    Effect.gen(function* () {
      const node = connection();
      const stream = yield* collect(
        node.subscribe({
          replay: "metadata",
          output: { attached: [{ threadId: "thread-1", terminalId: "t" }] },
        }),
      );
      yield* stream.settle;
      node.visibility.set("background");
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 20; i++) yield* node.emit(output("t", chunk));
      node.visibility.set("foreground");
      const exit = yield* Fiber.await(stream.fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.match(exit.cause.toString(), /resynchronize/);
      assert.deepEqual(typesOf(stream.items), ["outputScope"]);
    }),
  );

  it.effect("starts holding when it subscribes while the client is already in the background", () =>
    Effect.gen(function* () {
      const node = connection();
      node.visibility.set("background");
      const stream = yield* collect(
        node.subscribe({
          replay: "metadata",
          output: { attached: [{ threadId: "thread-1", terminalId: "t" }] },
        }),
      );
      yield* stream.settle;
      yield* node.emit(output("t", "a"));
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), ["outputScope"]);
      node.visibility.set("foreground");
      yield* stream.settle;
      assert.deepEqual(typesOf(stream.items), ["outputScope", "output:t:a"]);
    }),
  );
});

describe("terminal background hold", () => {
  it("keeps per-terminal order and merges only adjacent output of one terminal", () => {
    const hold = makeTerminalBackgroundHold({ sizeOf: terminalEventBytes });
    hold.hold(output("a", "1"));
    hold.hold(output("b", "2"));
    hold.hold(output("a", "3"));
    hold.hold(exited("a"));
    hold.hold(output("b", "4"));
    const released = hold.release();
    assert.deepEqual(typesOf(released ?? []), ["output:a:13", "output:b:24", "exited:a"]);
    assert.deepEqual(hold.release(), []);
  });

  it("drops everything past its budget and reports it once", () => {
    const hold = makeTerminalBackgroundHold({ sizeOf: terminalEventBytes, maxBytes: 1000 });
    hold.hold(output("a", "x".repeat(2000)));
    hold.hold(output("a", "y"));
    assert.isNull(hold.release());
    hold.hold(output("a", "z"));
    assert.deepEqual(typesOf(hold.release() ?? []), ["output:a:z"]);
  });
});
