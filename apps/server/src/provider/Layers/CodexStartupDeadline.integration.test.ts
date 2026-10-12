import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  isCodexStartupPhaseTimeout,
  makeCodexSessionRuntime,
  withCodexStartupPhaseDeadline,
  type CodexStartupPhase,
} from "./CodexSessionRuntime.ts";

const PEER = path.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

/** Starts a runtime against a peer that never answers `hangOn`; returns the start failure. */
const startAgainstHungPeer = (hangOn: CodexStartupPhase) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-deadline-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
    );
    const scriptPath = path.join(dir, "script.json");
    fs.writeFileSync(
      scriptPath,
      JSON.stringify({ rootThreadId: "root", notifications: [], hangOn }),
    );
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("startup-deadline-thread"),
      runtimeSessionId: RuntimeSessionId.make("startup-deadline-runtime"),
      binaryPath: PEER,
      cwd: dir,
      runtimeMode: "full-access",
      tokenMode: "balanced",
      environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      ...(hangOn === "thread/resume" ? { resumeCursor: { threadId: "stored-thread" } } : {}),
      // Only the hung phase is short, so a slow peer spawn cannot fail an earlier phase.
      startupPhaseTimeouts: {
        initialize: hangOn === "initialize" ? "300 millis" : "20 seconds",
        "thread/start": "300 millis",
        "thread/resume": "300 millis",
      },
    });
    return yield* runtime.start().pipe(Effect.flip);
  });

it.live.each(["initialize", "thread/start", "thread/resume"] as const)(
  "fails a start whose %s never answers with the phase and the next step",
  (phase) =>
    Effect.gen(function* () {
      const error = yield* startAgainstHungPeer(phase);

      assert.isTrue(isCodexStartupPhaseTimeout(error), String(error));
      if (!isCodexStartupPhaseTimeout(error)) return;
      assert.equal(error.cause.phase, phase);
      assert.include(
        error.detail,
        `\`${PEER}\` did not answer the Codex \`${phase}\` request within 0.3 seconds.`,
      );
      assert.include(
        error.detail,
        phase === "initialize" ? `\`${PEER} --version\`` : `\`${PEER} login\``,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { phase: "initialize", seconds: 15 },
  { phase: "thread/start", seconds: 30 },
  { phase: "thread/resume", seconds: 60 },
] as const)("bounds $phase at its default deadline of $seconds seconds", ({ phase, seconds }) =>
  Effect.gen(function* () {
    const pending = yield* withCodexStartupPhaseDeadline(
      { command: "codex", phase },
      Effect.never,
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(seconds - 1));
    assert.isUndefined(pending.pollUnsafe());
    yield* TestClock.adjust(Duration.seconds(1));
    const error = yield* Fiber.join(pending);

    assert.isTrue(isCodexStartupPhaseTimeout(error), String(error));
    if (!isCodexStartupPhaseTimeout(error)) return;
    assert.equal(error.cause.phase, phase);
    assert.equal(error.cause.timeoutMs, seconds * 1_000);
    assert.include(
      error.detail,
      `\`codex\` did not answer the Codex \`${phase}\` request within ${seconds} seconds.`,
    );
  }),
);
