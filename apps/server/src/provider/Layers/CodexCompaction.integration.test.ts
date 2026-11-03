/**
 * Runtime-level compaction: boots the REAL CodexSessionRuntime against the scripted mock
 * app-server peer, so the root `turn/started` handler, the compaction starter and `compactThread`
 * are exercised together, as Codex answers `thread/compact/start` with `{}` and reports the turn
 * on its own.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  CodexSessionRuntimeCompactionNotStartedError,
  makeCodexSessionRuntime,
} from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD] = wireFixture.childThreadIds as [string];
const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.compaction-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

const turnStarted = (threadId: string, turnId: string) => ({
  method: "turn/started",
  params: { threadId, turn: { ...wireFixture.responses.turnStart.turn, id: turnId } },
});

const writeScript = (script: Record<string, unknown>) =>
  Effect.gen(function* () {
    NodeFS.writeFileSync(
      scriptPath,
      JSON.stringify({ rootThreadId: ROOT, recordRequests: true, notifications: [], ...script }),
      "utf8",
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const suffix of ["", ".requests", ".compactions"]) {
          NodeFS.rmSync(`${scriptPath}${suffix}`, { force: true });
        }
      }),
    );
  });

const readLines = (suffix: string): string[] =>
  NodeFS.existsSync(`${scriptPath}${suffix}`)
    ? NodeFS.readFileSync(`${scriptPath}${suffix}`, "utf8").trim().split("\n")
    : [];

const makeRuntime = makeCodexSessionRuntime({
  threadId: ThreadId.make("thread-compaction-integration"),
  runtimeSessionId: RuntimeSessionId.make("runtime-compaction-integration"),
  binaryPath: peerPath,
  cwd: "/tmp",
  runtimeMode: "full-access",
  tokenMode: "balanced",
  environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
});

describe("CodexSessionRuntime compaction integration", () => {
  it.effect.each([false, true])(
    "runs the root thread's next turn as the compaction, not a child's (turn reported first=%s)",
    (notifiesFirst) =>
      Effect.gen(function* () {
        yield* writeScript({
          compactNotifiesFirst: notifiesFirst,
          compactNotifications: [
            turnStarted(CHILD, "child-turn"),
            turnStarted(ROOT, "compaction-turn"),
          ],
        });
        const runtime = yield* makeRuntime;
        yield* runtime.start();

        const result = yield* runtime.compactThread();

        assert.equal(result.turnId, "compaction-turn");
        assert.deepEqual(result.resumeCursor, { threadId: ROOT });
        const session = yield* runtime.getSession;
        assert.equal(session.status, "running");
        assert.equal(session.activeTurnId, "compaction-turn");
        assert.deepEqual(
          readLines(".compactions").map((line) => JSON.parse(line)),
          [{ threadId: ROOT }],
        );
        // Compaction is Codex's own request, never a prompt.
        assert.notInclude(readLines(".requests"), "turn/start");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to compact while a turn runs, without asking Codex", () =>
    Effect.gen(function* () {
      yield* writeScript({ holdTurnOpen: true, turnIds: ["running-turn"] });
      const runtime = yield* makeRuntime;
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });

      const error = yield* Effect.flip(runtime.compactThread());

      assert.ok(Schema.is(CodexSessionRuntimeCompactionNotStartedError)(error));
      assert.equal(
        error.message,
        "Codex did not start compaction: a turn is running. Compact once it finishes.",
      );
      assert.deepEqual(readLines(".compactions"), []);
      assert.equal((yield* runtime.getSession).activeTurnId, "running-turn");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
