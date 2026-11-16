import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { type ProviderEvent, RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Deferred, Effect, Ref, Stream } from "effect";
import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

/**
 * Runs the real Codex client and session runtime against the mock peer, which replays
 * `notifications` and `serverRequests` after `turn/start`.
 */
const root = fixture.rootThreadId;
const turnId = "drift-turn";

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
    const firsts = new Map<string, Deferred.Deferred<ProviderEvent>>();
    const first = (method: string) =>
      Effect.sync(() => {
        const existing = firsts.get(method);
        if (existing) return existing;
        const created = Deferred.makeUnsafe<ProviderEvent>();
        firsts.set(method, created);
        return created;
      });
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Ref.update(seen, (current) => [...current, event]).pipe(
          Effect.andThen(first(event.method)),
          Effect.flatMap((deferred) => Deferred.succeed(deferred, event)),
        ),
      ),
      Effect.forkScoped,
    );
    const waitForEvent = (method: string) =>
      first(method).pipe(Effect.flatMap(Deferred.await), Effect.timeout("10 seconds"));
    yield* runtime.start();
    yield* runtime.sendTurn({ input: "Go" });
    return { runtime, waitForEvent, events: Ref.get(seen) };
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
