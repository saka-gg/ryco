import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Effect, Fiber, Stream } from "effect";
import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

it.effect.each([false, true])(
  "continues native work and consumes one exact reply (uncertain=%s)",
  (failSteer) =>
    Effect.gen(function* () {
      const scriptPath = path.join(import.meta.dirname, "../testFixtures/.optional-script.json");
      const root = fixture.rootThreadId;
      const turnId = "optional-turn";
      const item = {
        type: "agentMessage",
        id: "question-item",
        text: "Audience?",
        phase: "final_answer",
        delivery: "async",
        questions: [{ title: "Audience?", options: ["Engineers"] }],
      };
      fs.writeFileSync(
        scriptPath,
        JSON.stringify({
          rootThreadId: root,
          holdTurnOpen: true,
          failSteer,
          turnIds: [turnId],
          notifications: [
            {
              method: "item/started",
              params: { threadId: root, turnId, item, startedAtMs: 1, completedAtMs: 2 },
            },
            {
              method: "item/completed",
              params: { threadId: root, turnId, item, startedAtMs: 1, completedAtMs: 2 },
            },
            {
              method: "item/completed",
              params: { threadId: root, turnId, item, startedAtMs: 1, completedAtMs: 2 },
            },
            {
              method: "item/agentMessage/delta",
              params: {
                threadId: root,
                turnId,
                itemId: "independent-work",
                delta: "I have continued researching.",
              },
            },
          ],
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fs.rmSync(scriptPath, { force: true });
          fs.rmSync(`${scriptPath}.steers`, { force: true });
        }),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("optional-thread"),
        runtimeSessionId: RuntimeSessionId.make("optional-runtime"),
        binaryPath: path.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh"),
        cwd: "/tmp",
        runtimeMode: "full-access",
        tokenMode: "balanced",
        environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "item/agentMessage/delta"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "Ask an optional question and continue" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const questions = events.filter(
        (event) => event.method === "item/agentMessage/optionalQuestions",
      );
      assert.equal(questions.length, 1, JSON.stringify(events));
      assert.equal(events.at(-1)?.textDelta, "I have continued researching.");
      assert.equal(fs.existsSync(`${scriptPath}.steers`), false);
      const requestId = questions[0]!.requestId!;
      assert.equal(
        (yield* runtime.respondToUserInput(requestId, { bad: "Invalid" }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(fs.existsSync(`${scriptPath}.steers`), false);
      const answerResult = yield* runtime
        .respondToUserInput(requestId, { "0": "Engineers" })
        .pipe(Effect.result);
      assert.equal(answerResult._tag, failSteer ? "Failure" : "Success");
      assert.equal(
        (yield* runtime.respondToUserInput(requestId, { "0": "Again" }).pipe(Effect.result))._tag,
        "Failure",
      );
      const sent = fs
        .readFileSync(`${scriptPath}.steers`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(sent.length, 1);
      assert.equal(sent[0].threadId, root);
      assert.equal(sent[0].expectedTurnId, turnId);
      assert.include(sent[0].input[0].text, "question-item");
      assert.include(sent[0].input[0].text, "Answer: Engineers");
    }).pipe(Effect.provide(NodeServices.layer)),
);
