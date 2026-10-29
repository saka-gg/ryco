// Partly adapted from pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts
// (91992bd5d464d6a01b2a5c1e7926e68ad09ea40e). Copyright (c) 2026 T3 Tools Inc. MIT; see
// THIRD_PARTY_NOTICES.md.
/**
 * Replayed Claude Agent SDK queries for `ClaudeAdapterLiveOptions.createQuery`: each query the
 * adapter opens plays the next transcript segment (segments are split at `spawn` entries), so the
 * real adapter, ProviderService, ingestion and projections run against recorded SDK messages
 * without a Claude Code CLI.
 *
 * The replayed protocol is the SDK query, not the CLI's stream-json wire, which moves with every
 * SDK release. Frames (`claude-agent-sdk.query`):
 *
 * - Outbound, what the adapter does to the query: `query.open { options }` (normalized by
 *   `normalizeClaudeOutbound`), `prompt.offer { message }` for each prompt message the query
 *   reads, `permission.response { result }` for each `canUseTool` answer, and the methods
 *   `query.interrupt { args }`, `query.set_model { model }`, `query.set_permission_mode { mode }`,
 *   `query.set_max_thinking_tokens { maxThinkingTokens }`, `query.stop_task { taskId }` and
 *   `query.close`.
 * - Inbound, what the CLI answers: `sdk.message { message }`, yielded by the query;
 *   `permission.request { toolName, input, options }`, which calls the query's `canUseTool`
 *   (`options.requestId` defaults to `toolUseID`); and `interrupt.result { value }`, which
 *   resolves the oldest pending `interrupt()` with `value`, so messages recorded before it reach
 *   the adapter ahead of the receipt. Every `query.interrupt` needs one, as the CLI answers
 *   every interrupt control request; a CLI without receipts answers with no `value`.
 *
 * Session ids and prompt uuids the adapter generates are bound recorded→actual
 * (`claudeQueryBindingRules`), across queries, so a resume references the session an earlier
 * query opened. Method promises resolve once the replay matched their frame, `interrupt()` once
 * its receipt is emitted. A `runtime_exit` ends the query's messages (`error` and `cancelled`
 * throw the recorded error); it is a scenario, not a replay failure.
 *
 * Each query runs on `runReplayCursor` (`replayDriver.ts`), the driver the line-JSON peer runs on.
 *
 * @module provider/testUtils/replay/claudeReplayQuery
 */
import type { Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Fiber, Option, Queue, Scope, Stream } from "effect";

import type { ClaudeAdapterLiveOptions } from "../../Layers/ClaudeAdapter.ts";
import { runReplayCursor, type ReplayEmitStep, type ReplayExitStep } from "./replayDriver.ts";
import { openReplayGate, type ReplayGate } from "./replayGate.ts";
import {
  claudeQueryBindingRules,
  makeReplayCursor,
  normalizeClaudeOutbound,
  ReplayIncompleteError,
  ReplayInvalidInboundError,
  ReplayUnexpectedOutboundError,
  ReplayUnexpectedSpawnError,
  type ReplayError,
} from "./replayMatch.ts";
import { splitReplaySegments } from "./replaySpawner.ts";
import type { ReplayRuntimeExit, ReplayTranscript } from "./replayTranscript.ts";

export type ClaudeCreateQuery = NonNullable<ClaudeAdapterLiveOptions["createQuery"]>;
/** The adapter's query interface (not exported by `ClaudeAdapter.ts`). */
export type ClaudeQueryRuntime = ReturnType<ClaudeCreateQuery>;
type ClaudeQueryInput = Parameters<ClaudeCreateQuery>[0];

export interface ClaudeReplayQueryOptions {
  readonly gate?: ReplayGate;
}

export type ClaudeReplayQueryState = "running" | "closed" | "exited" | "failed";

/** One query the adapter opened. */
export interface ClaudeReplayQuery {
  /** 1-based, in opening order: the transcript segment it plays. */
  readonly number: number;
  /** The options the adapter opened it with, unnormalized. */
  readonly options: ClaudeQueryOptions;
  readonly state: () => ClaudeReplayQueryState;
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  readonly describePosition: () => string;
}

export interface ClaudeReplayQueryFactory {
  /** Opens the next query; its replay lives in the scope the factory was made in. */
  readonly createQuery: ClaudeCreateQuery;
  /**
   * A `createQuery` whose queries live in the current scope: one replay played by the adapters
   * of several harnesses (a restart) gives each adapter its own.
   */
  readonly createQueryInScope: Effect.Effect<ClaudeCreateQuery, never, Scope.Scope>;
  readonly queries: ReadonlyArray<ClaudeReplayQuery>;
  /** Completed with the first failure of any query, or a query the transcript has no segment for. */
  readonly failure: Deferred.Deferred<ReplayError>;
  /** Fails with that failure, or when a segment was not fully played or never opened. */
  readonly assertConsumed: Effect.Effect<void, ReplayError>;
  readonly describePosition: () => string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The error a recorded `runtime_exit` makes the query throw, as the SDK would. */
function recordedExitError(exit: ReplayRuntimeExit): Error {
  const recorded = exit.error;
  const message =
    typeof recorded === "string"
      ? recorded
      : isRecord(recorded) && typeof recorded.message === "string"
        ? recorded.message
        : exit.status === "cancelled"
          ? "Claude Code process aborted by user"
          : `Claude Code process exited with code ${exit.code ?? 1}`;
  return Object.assign(new Error(message), isRecord(recorded) ? recorded : {});
}

/** The query's SDK messages, buffered until the adapter pulls them, as the SDK buffers stdout. */
class SdkMessageChannel implements AsyncIterable<SDKMessage> {
  private readonly buffer: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<SDKMessage>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  private ended = false;
  private failure: { readonly cause: unknown } | undefined;

  push(message: SDKMessage): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: message });
    else this.buffer.push(message);
  }

  /** Ends the messages after the buffered ones; with `cause`, the next read throws it once. */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (cause !== undefined) this.failure = { cause };
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) {
        const failure = this.failure;
        this.failure = undefined;
        waiter.reject(failure.cause);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      // An already-buffered message is an already-resolved promise.
      next: () => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ done: false, value: buffered });
        if (this.failure) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure.cause);
        }
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: () => Promise.resolve({ done: true, value: undefined }),
    };
  }
}

interface Settle {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

interface OutboundItem {
  readonly frame: unknown;
  /** Settled once the replay matched the frame. */
  readonly settle?: Settle;
}

interface ReplayShared {
  readonly scenario: string;
  readonly segments: ReadonlyArray<ReplayTranscript>;
  readonly gate: ReplayGate;
  readonly failure: Deferred.Deferred<ReplayError>;
  readonly bindingTable: Map<string, unknown>;
  readonly queries: Array<ClaudeReplayQuery>;
  readonly initialization:
    | { readonly result: unknown; readonly mcpServerStatus: ReadonlyArray<unknown> }
    | undefined;
}

/** Starts the replay of query #`number` in the current scope. */
const openReplayQuery = (
  shared: ReplayShared,
  number: number,
  segment: ReplayTranscript,
  input: ClaudeQueryInput,
): Effect.Effect<ClaudeQueryRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { scenario, gate } = shared;
    const cursor = makeReplayCursor(segment.entries, {
      scenario,
      spawn: number,
      normalize: normalizeClaudeOutbound,
      bindings: claudeQueryBindingRules,
      bindingTable: shared.bindingTable,
    });
    const outbound = yield* Queue.unbounded<OutboundItem>();
    const channel = new SdkMessageChannel();
    const pendingInterrupts: Array<Settle> = [];
    const permissionSignals = new Set<AbortController>();
    let state: ClaudeReplayQueryState = "running";

    /** Like the CLI process dying: no message, receipt or permission answer follows. */
    const release = (cause?: unknown) => {
      channel.end(cause);
      for (const controller of permissionSignals) controller.abort();
      permissionSignals.clear();
      for (const pending of pendingInterrupts.splice(0)) {
        if (cause === undefined) pending.resolve(undefined);
        else pending.reject(cause);
      }
    };

    const offer = (frame: unknown, settle?: Settle) =>
      Queue.offerUnsafe(outbound, settle ? { frame, settle } : { frame });

    const invalid = (step: ReplayEmitStep, reason: string) =>
      new ReplayInvalidInboundError({
        scenario,
        spawn: number,
        cursor: step.cursor,
        reason,
        frame: step.frame,
      });

    const requestPermission = (step: ReplayEmitStep) =>
      Effect.gen(function* () {
        const frame = step.frame as Readonly<Record<string, unknown>>;
        const canUseTool = input.options.canUseTool;
        if (canUseTool === undefined) return yield* invalid(step, "query.open had no canUseTool");
        if (typeof frame.toolName !== "string" || !isRecord(frame.input)) {
          return yield* invalid(step, "a permission.request needs toolName and input");
        }
        const recorded = isRecord(frame.options) ? frame.options : {};
        const toolUseID =
          typeof recorded.toolUseID === "string"
            ? recorded.toolUseID
            : `replay-tool-${step.cursor}`;
        const controller = new AbortController();
        permissionSignals.add(controller);
        void canUseTool(frame.toolName, { ...frame.input }, {
          ...recorded,
          toolUseID,
          requestId: typeof recorded.requestId === "string" ? recorded.requestId : toolUseID,
          signal: controller.signal,
        } as Parameters<NonNullable<ClaudeQueryOptions["canUseTool"]>>[2])
          .then(
            (result) => ({ type: "permission.response", result }),
            (cause) => ({ type: "permission.response", error: messageOf(cause) }),
          )
          .then((answer) => {
            permissionSignals.delete(controller);
            // The SDK drops an answer to a query that is gone; nothing reaches the CLI.
            if (state === "running") offer(answer);
          });
      });

    const deliver = (step: ReplayEmitStep) =>
      Effect.gen(function* () {
        const frame = step.frame;
        const type = isRecord(frame) ? frame.type : undefined;
        switch (type) {
          case "sdk.message": {
            const message = (frame as { readonly message?: unknown }).message;
            if (!isRecord(message) || typeof message.type !== "string") {
              return yield* invalid(step, "an sdk.message needs an SDK message");
            }
            channel.push(message as unknown as SDKMessage);
            return;
          }
          case "permission.request":
            return yield* requestPermission(step);
          case "interrupt.result": {
            const pending = pendingInterrupts.shift();
            if (pending === undefined) {
              return yield* invalid(step, "no interrupt() awaits a receipt");
            }
            pending.resolve((frame as { readonly value?: unknown }).value);
            return;
          }
          default:
            return yield* invalid(step, `unknown inbound frame type ${JSON.stringify(type)}`);
        }
      });

    const finish = (step: ReplayExitStep) =>
      Effect.sync(() => {
        state = "exited";
        release(
          step.status === "success"
            ? undefined
            : recordedExitError({
                type: "runtime_exit",
                status: step.status,
                ...(step.code !== undefined ? { code: step.code } : {}),
                ...(step.error !== undefined ? { error: step.error } : {}),
              }),
        );
      });

    const replay = yield* runReplayCursor({
      cursor,
      scenario,
      spawn: number,
      name: `query #${number}`,
      gate,
      failure: shared.failure,
      outbound,
      frameOf: (item) => item.frame,
      state: () => state,
      deliver,
      finish,
      matched: (item, error) => {
        if (error === undefined) item.settle?.resolve(undefined);
        else item.settle?.reject(new Error(error.message));
      },
      onFail: (error) =>
        Effect.sync(() => {
          // A closed or exited query already released its waiters.
          if (state !== "running") return;
          state = "failed";
          release(new Error(error.message));
        }),
    });
    const fail = (error: ReplayError) => Effect.runSync(replay.fail(error));

    /** Queues an outbound frame; while the query is not open, that is a failure. */
    const send = (frame: unknown, settle?: Settle) => {
      if (state !== "running") {
        const error = new ReplayUnexpectedOutboundError({
          scenario,
          spawn: number,
          cursor: cursor.position(),
          reason:
            state === "closed"
              ? "the query was closed"
              : state === "exited"
                ? "the transcript recorded the query ending"
                : "the replay already failed",
          actual: normalizeClaudeOutbound(frame),
        });
        fail(error);
        settle?.reject(new Error(error.message));
        return;
      }
      offer(frame, settle);
    };

    const call = (frame: unknown) =>
      new Promise<void>((resolve, reject) =>
        send(frame, { resolve: () => resolve(), reject: (cause) => reject(cause) }),
      );

    send({ type: "query.open", options: input.options });
    // The SDK reads the prompt stream eagerly and writes each message to the CLI.
    const pump = yield* Stream.fromAsyncIterable(input.prompt, (cause) => cause).pipe(
      Stream.runForEach((message) =>
        Effect.sync(() => {
          if (state === "running") send({ type: "prompt.offer", message });
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    const close = () => {
      // A query whose process already ended has nothing left to close.
      if (state !== "running") return;
      send({ type: "query.close" });
      state = "closed";
      release();
      Effect.runFork(Fiber.interrupt(pump));
    };

    shared.queries.push({
      number,
      options: input.options,
      state: () => state,
      assertConsumed: replay.assertConsumed,
      describePosition: replay.describePosition,
    });

    const initialization = shared.initialization;
    const runtime: ClaudeQueryRuntime = {
      [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
      interrupt: (...args: ReadonlyArray<unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          const settle = { resolve, reject };
          pendingInterrupts.push(settle);
          send(
            { type: "query.interrupt", args },
            {
              // Resolved by its receipt, not by the match.
              resolve: () => undefined,
              reject: (cause) => {
                const index = pendingInterrupts.indexOf(settle);
                if (index !== -1) pendingInterrupts.splice(index, 1);
                reject(cause);
              },
            },
          );
        }),
      setModel: (model) =>
        call({ type: "query.set_model", ...(model !== undefined ? { model } : {}) }),
      setPermissionMode: (mode) => call({ type: "query.set_permission_mode", mode }),
      setMaxThinkingTokens: (maxThinkingTokens) =>
        call({ type: "query.set_max_thinking_tokens", maxThinkingTokens }),
      stopTask: (taskId) => call({ type: "query.stop_task", taskId }),
      close,
      // Only when the transcript says how the CLI answered initialize; the adapter allows none.
      ...(initialization
        ? {
            initializationResult: () => Promise.resolve(initialization.result),
            mcpServerStatus: () =>
              Promise.resolve(
                initialization.mcpServerStatus as ReadonlyArray<{
                  readonly name: string;
                  readonly status: string;
                }>,
              ),
          }
        : {}),
    };
    return runtime;
  });

/**
 * A query factory playing `transcript` (materialize `<workspace>` first). Every query it opens
 * plays the next segment; a query beyond the last fails the replay and throws, as a CLI that
 * cannot start would.
 */
export const makeClaudeReplayQueryFactory = (
  transcript: ReplayTranscript,
  options: ClaudeReplayQueryOptions = {},
): Effect.Effect<ClaudeReplayQueryFactory, never, Scope.Scope> =>
  Effect.gen(function* () {
    const metadata = transcript.header.metadata;
    const shared: ReplayShared = {
      scenario: transcript.header.scenario,
      segments: splitReplaySegments(transcript),
      gate: options.gate ?? openReplayGate,
      failure: yield* Deferred.make<ReplayError>(),
      bindingTable: new Map(),
      queries: [],
      initialization:
        metadata?.initializationResult === undefined
          ? undefined
          : {
              result: metadata.initializationResult,
              mcpServerStatus: Array.isArray(metadata.mcpServerStatus)
                ? metadata.mcpServerStatus
                : [],
            },
    };
    let opened = 0;

    const createQueryIn =
      (scope: Scope.Scope): ClaudeCreateQuery =>
      (input) => {
        opened += 1;
        const number = opened;
        const segment = shared.segments[number - 1];
        if (segment === undefined) {
          Effect.runSync(
            Deferred.succeed(
              shared.failure,
              new ReplayUnexpectedSpawnError({
                scenario: shared.scenario,
                spawn: number,
                command: "query",
              }),
            ),
          );
          throw new Error(`replay: no transcript for query #${number}`);
        }
        return Effect.runSync(
          openReplayQuery(shared, number, segment, input).pipe(Scope.provide(scope)),
        );
      };

    const assertConsumed = Effect.gen(function* () {
      const failed = yield* Deferred.poll(shared.failure);
      if (Option.isSome(failed)) return yield* Effect.flatMap(failed.value, Effect.fail);
      for (const query of shared.queries) yield* query.assertConsumed;
      const missing = shared.segments.length - shared.queries.length;
      if (missing > 0) {
        return yield* new ReplayIncompleteError({
          scenario: shared.scenario,
          spawn: shared.queries.length + 1,
          cursor: 0,
          remainingLabels: Array.from(
            { length: missing },
            (_, index) => `query #${shared.queries.length + index + 1}`,
          ),
        });
      }
    });

    const describePosition = () =>
      shared.queries.length === 0
        ? `replay '${shared.scenario}': no query opened yet (${shared.segments.length} expected)`
        : shared.queries.map((query) => query.describePosition()).join("; ");

    return {
      createQuery: createQueryIn(yield* Effect.scope),
      createQueryInScope: Effect.map(Effect.scope, createQueryIn),
      queries: shared.queries,
      failure: shared.failure,
      assertConsumed,
      describePosition,
    } satisfies ClaudeReplayQueryFactory;
  });
