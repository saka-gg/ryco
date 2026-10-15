import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { CopilotSettings, ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";

const CopilotTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-copilot-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCopilotCall {
  readonly cwd: string;
  readonly sideQuestion: boolean | undefined;
  readonly config: SessionConfig;
  readonly prompt: string;
}

/** A Copilot client double whose `respond` decides each prompt's answer. */
function makeFakeCopilot(
  respond: (call: FakeCopilotCall, index: number) => Promise<string | undefined>,
) {
  const calls: FakeCopilotCall[] = [];
  let aborted = 0;
  let stopped = 0;
  const clientFactory = (cwd: string, sideQuestion?: boolean) =>
    ({
      createSession: async (config: SessionConfig) => ({
        sendAndWait: async ({ prompt }: { prompt: string }) => {
          const call = { cwd, sideQuestion, config, prompt };
          calls.push(call);
          const content = await respond(call, calls.length - 1);
          return content === undefined ? undefined : { data: { content } };
        },
        abort: async () => {
          aborted++;
        },
        disconnect: async () => undefined,
      }),
      stop: async () => {
        stopped++;
      },
    }) as unknown as CopilotClient;
  return {
    clientFactory,
    calls,
    aborted: () => aborted,
    stopped: () => stopped,
  };
}

const titleModelSelection = createModelSelection(
  ProviderInstanceId.make("githubCopilot"),
  "gpt-5.4",
  [],
);

it.layer(CopilotTextGenerationTestLayer)("CopilotTextGeneration", (it) => {
  it.effect("names a thread and its branch in one isolated, tool-free call", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot(async () =>
        JSON.stringify({ title: "Fix reconnect spinner", branch: "fix reconnect spinner" }),
      );
      const textGeneration = yield* makeCopilotTextGeneration(
        Schema.decodeSync(CopilotSettings)({}),
        {},
        fake.clientFactory,
      );

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: titleModelSelection,
        includeBranch: true,
      });

      expect(result).toEqual({ title: "Fix reconnect spinner", branch: "fix-reconnect-spinner" });
      expect(fake.calls).toHaveLength(1);
      const [call] = fake.calls;
      expect(call?.cwd).not.toBe(process.cwd());
      expect(call?.sideQuestion).toBe(true);
      expect(call?.config).toMatchObject({
        model: "gpt-5.4",
        workingDirectory: call?.cwd,
        configDirectory: call?.cwd,
        availableTools: [],
        enableConfigDiscovery: false,
        enableFileHooks: false,
        enableSkills: false,
        systemMessage: { mode: "replace" },
      });
      expect(call?.prompt).toContain("branch");
      expect(fake.stopped()).toBe(1);
    }),
  );

  it.effect("retries a failed lightweight title once with the full configuration", () =>
    Effect.gen(function* () {
      const fake = makeFakeCopilot(async (_call, index) => {
        if (index === 0) throw new Error("model provider not configured");
        return JSON.stringify({ title: "Fix reconnect spinner" });
      });
      const textGeneration = yield* makeCopilotTextGeneration(
        Schema.decodeSync(CopilotSettings)({}),
        {},
        fake.clientFactory,
      );

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner.",
        modelSelection: titleModelSelection,
      });

      expect(result).toEqual({ title: "Fix reconnect spinner" });
      expect(fake.calls.map((call) => call.cwd === process.cwd())).toEqual([false, true]);
      expect(fake.calls[1]?.config).not.toHaveProperty("configDirectory");
      expect(fake.stopped()).toBe(2);
    }),
  );

  it.effect("gives up on a hung title after the naming budget and stops its session", () =>
    Effect.gen(function* () {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const fake = makeFakeCopilot(() => {
        resolveStarted();
        return new Promise(() => {});
      });
      const textGeneration = yield* makeCopilotTextGeneration(
        Schema.decodeSync(CopilotSettings)({}),
        {},
        fake.clientFactory,
      );

      const fiber = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the reconnect spinner.",
          modelSelection: titleModelSelection,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => started);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);

      expect(error.detail).toBe("GitHub Copilot title generation timed out.");
      // A timeout is final: the full configuration would only be slower.
      expect(fake.calls).toHaveLength(1);
      expect(fake.aborted()).toBe(1);
      expect(fake.stopped()).toBe(1);
    }),
  );

  it.effect("ranks natively with the configured model and no tools or fallback", () =>
    Effect.gen(function* () {
      const sessionConfigs: SessionConfig[] = [];
      const prompts: string[] = [];
      const clientFactory = () =>
        ({
          createSession: async (config: SessionConfig) => {
            sessionConfigs.push(config);
            return {
              sendAndWait: async ({ prompt }: { prompt: string }) => {
                prompts.push(prompt);
                return {
                  data: {
                    content: JSON.stringify({
                      rankings: [
                        {
                          candidateId: "candidate-0001",
                          tier: "soon",
                          confidence: "high",
                          reason: "The requested repair is actionable",
                        },
                      ],
                    }),
                  },
                };
              },
              disconnect: async () => undefined,
            };
          },
          stop: async () => undefined,
        }) as unknown as CopilotClient;

      const settings = Schema.decodeSync(CopilotSettings)({});
      const textGeneration = yield* makeCopilotTextGeneration(settings, {}, clientFactory);
      const input = makeThreadPriorityTestInput(
        ProviderInstanceId.make("githubCopilot"),
        "gpt-5.4",
      );
      const result = yield* textGeneration.rankInboxThreads({
        ...input,
        modelSelection: createModelSelection(input.modelSelection.instanceId, "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      });

      expect(result.rankings).toMatchObject([
        { threadId: "thread-priority-test", tier: "soon", confidence: "high" },
      ]);
      expect(sessionConfigs).toHaveLength(1);
      expect(sessionConfigs[0]).toMatchObject({
        model: "gpt-5.4",
        reasoningEffort: "high",
        streaming: false,
        availableTools: [],
      });
      expect(prompts[0]).toContain("Untrusted candidate data (JSON)");
    }),
  );
});
