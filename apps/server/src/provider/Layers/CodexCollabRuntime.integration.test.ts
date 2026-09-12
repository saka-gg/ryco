/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Effect, Fiber, Stream } from "effect";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime, readStoredCodexThread } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        completedAtMs: 1_785_898_350_000,
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

describe("CodexSessionRuntime collab integration", () => {
  it.effect("reads stored turns without acquiring a writer or starting a turn", () =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(
        scriptPath,
        JSON.stringify({
          writerConflict: true,
          recordRequests: true,
          historyTurns: [
            {
              id: "stored-turn",
              status: "completed",
              startedAt: 1_700_000_000,
              items: [{ id: "stored-item", type: "agentMessage", text: "Recovered result" }],
            },
          ],
        }),
        "utf8",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      const snapshot = yield* readStoredCodexThread({
        binaryPath: peerPath,
        cwd: "/tmp",
        providerThreadId: ROOT,
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      assert.equal(snapshot.turns[0]?.status, "completed");
      assert.deepEqual(snapshot.turns[0]?.items, [
        { id: "stored-item", type: "agentMessage", text: "Recovered result" },
      ]);
      assert.deepEqual(NodeFS.readFileSync(`${scriptPath}.requests`, "utf8").trim().split("\n"), [
        "initialize",
        "initialized",
        "thread/read",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        runtimeSessionId: RuntimeSessionId.make("runtime-collab-integration"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        tokenMode: "balanced",
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [turnStartedA, registrationA, registrationB, turnStartedB],
      };
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        runtimeSessionId: RuntimeSessionId.make("runtime-collab-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        tokenMode: "balanced",
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      const stopResult = yield* runtime.interruptTurn().pipe(Effect.exit);
      assert.equal(
        stopResult._tag,
        "Failure",
        "failed child cancellation must trigger adapter fallback",
      );

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "reconciles late activity and stops a child whose turn-start notification was missed",
    () =>
      Effect.gen(function* () {
        const registration = (child: string) =>
          wireFixture.notifications.find((entry) => {
            const item = (entry.params as { item?: { type?: string; agentThreadId?: string } })
              .item;
            return item?.type === "subAgentActivity" && item.agentThreadId === child;
          });
        const turn = wireFixture.responses.turnStart.turn;
        NodeFS.writeFileSync(
          scriptPath,
          JSON.stringify({
            rootThreadId: ROOT,
            notifications: [registration(CHILD_A), registration(CHILD_B)],
            childSnapshots: {
              [CHILD_A]: {
                status: { type: "active", activeFlags: [] },
                turns: [{ ...turn, id: "missed-child-turn", status: "inProgress" }],
              },
              [CHILD_B]: { status: { type: "idle" }, turns: [{ ...turn, status: "completed" }] },
            },
          }),
        );
        const interruptsPath = `${scriptPath}.interrupts`;
        NodeFS.rmSync(interruptsPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(interruptsPath, { force: true });
          }),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-reconcile-children"),
          runtimeSessionId: RuntimeSessionId.make("runtime-reconcile-children"),
          binaryPath: peerPath,
          cwd: "/tmp",
          runtimeMode: "full-access",
          tokenMode: "off",
          environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const idleChild = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.method === "collabAgent/statusChanged" &&
              (event.payload as { agentThreadId?: string; status?: { type?: string } })
                .agentThreadId === CHILD_B &&
              (event.payload as { status?: { type?: string } }).status?.type === "idle",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "late activity for finished child" });
        const reconciled = yield* Fiber.join(idleChild).pipe(Effect.timeoutOption("12 seconds"));
        assert.equal(
          reconciled._tag,
          "Some",
          "polling must settle stale activity without user intervention",
        );
        const stoppedChild = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.method === "collabAgent/statusChanged" &&
              (event.payload as { agentThreadId?: string; status?: { type?: string } })
                .agentThreadId === CHILD_A &&
              (event.payload as { status?: { type?: string } }).status?.type === "idle",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.interruptTurn();
        const stopped = yield* Fiber.join(stoppedChild).pipe(Effect.timeoutOption("5 seconds"));
        assert.equal(
          stopped._tag,
          "Some",
          "stop must publish confirmed settlement without a completion notification",
        );
        const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(interrupts, [{ threadId: CHILD_A, turnId: "missed-child-turn" }]);
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ignores a stale idle read when a child starts a newer turn", () =>
    Effect.gen(function* () {
      const registration = wireFixture.notifications.find((entry) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === CHILD_A;
      });
      NodeFS.writeFileSync(
        scriptPath,
        JSON.stringify({
          rootThreadId: ROOT,
          notifications: [registration],
          staleReadFor: CHILD_A,
          childSnapshots: {
            [CHILD_A]: {
              status: { type: "active", activeFlags: [] },
              turns: [
                { ...wireFixture.responses.turnStart.turn, id: "newer-turn", status: "inProgress" },
              ],
            },
          },
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.interrupts`, { force: true });
        }),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-child-read-race"),
        runtimeSessionId: RuntimeSessionId.make("runtime-child-read-race"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        tokenMode: "off",
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const seen: Array<{ method?: string; payload?: unknown }> = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "race snapshot against child follow-up" });
      // Stop performs the read immediately; the mock publishes a newer turn
      // before returning its obsolete idle snapshot.
      yield* Effect.sleep("100 millis");
      yield* runtime.interruptTurn();
      const start = seen.findIndex((event) => event.method === "collabAgent/turnStarted");
      assert.isAtLeast(start, 0);
      const statuses = seen
        .slice(start)
        .filter((event) => event.method === "collabAgent/statusChanged");
      // The only idle event is the confirmed post-interrupt read; the stale
      // pre-interrupt snapshot must not erase the newly observed turn id.
      assert.isAtMost(statuses.length, 1);
      const interrupts = NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(interrupts, [{ threadId: CHILD_A, turnId: "newer-turn" }]);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        runtimeSessionId: RuntimeSessionId.make("runtime-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        tokenMode: "balanced",
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
