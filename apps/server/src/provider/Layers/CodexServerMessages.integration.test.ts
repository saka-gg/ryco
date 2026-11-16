import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { type ProviderEvent, ProviderItemId, RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Deferred, Effect, Ref, Stream } from "effect";
import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

/**
 * Runs the real Codex client and session runtime against the mock peer, which replays
 * `notifications` and `serverRequests` after `turn/start`.
 */
const root = fixture.rootThreadId;
const turnId = "wire-turn";

const startHarness = (input: {
  readonly name: string;
  readonly notifications?: ReadonlyArray<Record<string, unknown>>;
  readonly serverRequests?: ReadonlyArray<Record<string, unknown>>;
}) =>
  Effect.gen(function* () {
    const scriptPath = path.join(
      import.meta.dirname,
      `../testFixtures/.server-messages-${input.name}.json`,
    );
    fs.writeFileSync(
      scriptPath,
      JSON.stringify({
        rootThreadId: root,
        holdTurnOpen: true,
        turnIds: [turnId],
        notifications: input.notifications ?? [],
        serverRequests: input.serverRequests ?? [],
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(scriptPath, { force: true })));
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make(`server-messages-${input.name}`),
      runtimeSessionId: RuntimeSessionId.make(`server-messages-runtime-${input.name}`),
      binaryPath: path.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh"),
      cwd: "/tmp",
      runtimeMode: "approval-required",
      tokenMode: "balanced",
      environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
    });
    const seen = yield* Ref.make<ReadonlyArray<ProviderEvent>>([]);
    const waiters: Array<{
      readonly method: string;
      readonly count: number;
      readonly done: Deferred.Deferred<ReadonlyArray<ProviderEvent>>;
    }> = [];
    const settle = (events: ReadonlyArray<ProviderEvent>) =>
      Effect.forEach(
        waiters,
        (waiter) => {
          const matching = events.filter((event) => event.method === waiter.method);
          return matching.length >= waiter.count
            ? Deferred.succeed(waiter.done, matching)
            : Effect.void;
        },
        { discard: true },
      );
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Ref.updateAndGet(seen, (current) => [...current, event]).pipe(Effect.flatMap(settle)),
      ),
      Effect.forkScoped,
    );
    /** The first `count` events with this method, once they arrived. */
    const waitForEvents = (method: string, count: number) =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<ReadonlyArray<ProviderEvent>>();
        waiters.push({ method, count, done });
        yield* settle(yield* Ref.get(seen));
        return (yield* Deferred.await(done)).slice(0, count);
      }).pipe(Effect.timeout("10 seconds"));
    const waitForEvent = (method: string) =>
      waitForEvents(method, 1).pipe(Effect.map((events) => events[0]!));
    yield* runtime.start();
    yield* runtime.sendTurn({ input: "Go" });
    return { runtime, waitForEvent, waitForEvents };
  });

it.live("ends a turn whose turn/completed carries an error kind newer than the schema", () =>
  Effect.gen(function* () {
    const { runtime, waitForEvent } = yield* startHarness({
      name: "turn-completed",
      notifications: [
        // A raw payload the runtime cannot handle loses only itself.
        { method: "item/completed", params: { threadId: root, turnId } },
        {
          method: "turn/completed",
          params: {
            threadId: root,
            turn: {
              ...fixture.responses.turnStart.turn,
              id: turnId,
              status: "failed",
              error: { message: "Rate limit reached", codexErrorInfo: "rateLimitExceeded" },
            },
          },
        },
      ],
    });
    const completed = yield* waitForEvent("turn/completed");
    assert.equal(completed.turnId, turnId);
    assert.deepEqual((completed.payload as { turn: { error: unknown } }).turn.error, {
      message: "Rate limit reached",
      codexErrorInfo: "rateLimitExceeded",
    });
    const session = yield* runtime.getSession;
    assert.equal(session.status, "error");
    assert.equal(session.activeTurnId, undefined);
    assert.equal(session.lastError, "Rate limit reached");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("matches serverRequest/resolved to the approval by its JSON-RPC id", () =>
  Effect.gen(function* () {
    const { waitForEvent, waitForEvents } = yield* startHarness({
      name: "approval-resolved",
      serverRequests: [
        {
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: root,
            turnId,
            itemId: "item-command",
            approvalId: "approval-command",
            command: "rm -rf build",
            startedAtMs: 1,
          },
          resolveAfterMs: 150,
        },
        {
          id: 8,
          method: "item/fileChange/requestApproval",
          params: { threadId: root, turnId, itemId: "item-file", startedAtMs: 1 },
          resolveAfterMs: 200,
        },
      ],
    });
    const command = yield* waitForEvent("item/commandExecution/requestApproval");
    const fileChange = yield* waitForEvent("item/fileChange/requestApproval");
    // Codex withdrew both itself (an interrupt): each resolution names its own approval.
    const resolved = yield* waitForEvents("serverRequest/resolved", 2);
    assert.deepEqual(
      resolved.map((event) => ({
        requestId: event.requestId,
        requestKind: event.requestKind,
        itemId: event.itemId,
      })),
      [
        {
          requestId: command.requestId,
          requestKind: "command",
          itemId: ProviderItemId.make("item-command"),
        },
        {
          requestId: fileChange.requestId,
          requestKind: "file-change",
          itemId: ProviderItemId.make("item-file"),
        },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
