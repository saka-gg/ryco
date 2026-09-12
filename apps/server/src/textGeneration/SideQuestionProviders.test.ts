import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Effect, Fiber, FileSystem, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";
import { sideQuestionEnvironment } from "./SideQuestionIsolation.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "ryco-side-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const input = {
  cwd: process.cwd(),
  context: "Completed context only",
  question: "Why?",
  history: [{ question: "Earlier?", answer: "Earlier answer" }],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6",
    options: [{ id: "reasoningEffort", value: "medium" }],
  },
};

it.layer(testLayer)("side question provider isolation", (it) => {
  for (const provider of ["codex", "claude"] as const) {
    it.effect(`${provider} uses an isolated process with tools and ambient context disabled`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-side-cli-test-" });
          const binary = `${root}/${provider}`;
          const capture = `${root}/capture.json`;
          yield* fs.writeFileString(
            binary,
            [
              `#!${process.execPath}`,
              'const fs = require("node:fs");',
              "const args = process.argv.slice(2);",
              `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, cwd: process.cwd(), secret: process.env.RYCO_AGENT_CONTROL_TOKEN, stdin: fs.readFileSync(0, "utf8") }));`,
              provider === "codex"
                ? 'fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({answer:"A separate answer"}));'
                : 'process.stdout.write(JSON.stringify({structured_output:{answer:"A separate answer"}}));',
            ].join("\n"),
          );
          yield* fs.chmod(binary, 0o755);
          const env = { ...process.env, RYCO_AGENT_CONTROL_TOKEN: "primary-only" };
          const service =
            provider === "codex"
              ? yield* makeCodexTextGeneration(
                  Schema.decodeSync(CodexSettings)({ binaryPath: binary }),
                  env,
                )
              : yield* makeClaudeTextGeneration(
                  Schema.decodeSync(ClaudeSettings)({ binaryPath: binary }),
                  env,
                );
          expect(yield* service.answerSideQuestion(input)).toEqual({ answer: "A separate answer" });
          const captured = JSON.parse(yield* fs.readFileString(capture)) as {
            args: string[];
            cwd: string;
            secret?: string;
            stdin: string;
          };
          expect(captured.cwd).not.toBe(input.cwd);
          expect(captured.secret).toBeUndefined();
          expect(yield* fs.exists(captured.cwd)).toBe(false);
          expect(captured.stdin).toContain("Completed context only");
          expect(captured.stdin).toContain("Earlier answer");
          if (provider === "codex") {
            expect(captured.args).toContain("--ignore-user-config");
            expect(captured.args).toContain("features.shell_tool=false");
            expect(captured.args).toContain("mcp_servers={}");
            expect(captured.args).toContain('model_reasoning_effort="medium"');
            expect(captured.args).toContain("read-only");
          } else {
            expect(captured.args).toContain("--strict-mcp-config");
            expect(captured.args).toContain("--no-session-persistence");
            expect(
              JSON.parse(captured.args[captured.args.indexOf("--settings") + 1]!),
            ).toMatchObject({
              disableAllHooks: true,
              autoMemoryEnabled: false,
              claudeMdExcludes: ["**"],
            });
            expect(captured.args[captured.args.indexOf("--tools") + 1]).toBe("");
            expect(captured.args).not.toContain("--dangerously-skip-permissions");
          }
        }),
      ),
    );
  }

  for (const provider of ["codex", "claude"] as const) {
    it.effect(
      `${provider} cancellation kills only the separate CLI and removes its directory`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-side-cancel-test-" });
            const binary = `${root}/${provider}`;
            const capture = `${root}/capture.json`;
            yield* fs.writeFileString(
              binary,
              [
                `#!${process.execPath}`,
                'const fs = require("node:fs");',
                `fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));`,
                "setInterval(() => {}, 1000);",
              ].join("\n"),
            );
            yield* fs.chmod(binary, 0o755);
            const service =
              provider === "codex"
                ? yield* makeCodexTextGeneration(
                    Schema.decodeSync(CodexSettings)({ binaryPath: binary }),
                  )
                : yield* makeClaudeTextGeneration(
                    Schema.decodeSync(ClaudeSettings)({ binaryPath: binary }),
                  );
            const fiber = yield* service.answerSideQuestion(input).pipe(Effect.forkChild);
            yield* Effect.promise(async () => {
              const { access } = await import("node:fs/promises");
              for (let attempt = 0; attempt < 200; attempt++) {
                try {
                  await access(capture);
                  return;
                } catch {
                  await new Promise((resolve) => setTimeout(resolve, 10));
                }
              }
              throw new Error("Side CLI did not start");
            });
            const captured = JSON.parse(yield* fs.readFileString(capture)) as {
              cwd: string;
              pid: number;
            };
            yield* Fiber.interrupt(fiber);
            expect(yield* fs.exists(captured.cwd)).toBe(false);
            expect(() => process.kill(captured.pid, 0)).toThrow();
            expect(process.pid).not.toBe(captured.pid);
          }),
        ),
    );
  }

  it.effect("Copilot cancellation aborts only its independent tool-free session", () =>
    Effect.gen(function* () {
      let config: SessionConfig | undefined;
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let aborted = 0;
      let stopped = 0;
      const client = {
        createSession: async (value: SessionConfig) => {
          config = value;
          return {
            sendAndWait: () => {
              resolveStarted();
              return new Promise(() => {});
            },
            abort: async () => {
              aborted++;
            },
            disconnect: async () => {},
          };
        },
        stop: async () => {
          stopped++;
        },
      } as unknown as CopilotClient;
      const service = yield* makeCopilotTextGeneration(
        Schema.decodeSync(CopilotSettings)({}),
        {},
        () => client,
      );
      const fiber = yield* service.answerSideQuestion(input).pipe(Effect.forkChild);
      yield* Effect.promise(() => started);
      yield* Fiber.interrupt(fiber);
      expect(aborted).toBe(1);
      expect(stopped).toBe(1);
      expect(config).toMatchObject({
        availableTools: [],
        enableConfigDiscovery: false,
        enableFileHooks: false,
        enableSessionStore: false,
        model: "gpt-6",
        reasoningEffort: "medium",
      });
    }),
  );
});

it("strips main control environment without dropping provider authentication", () => {
  expect(
    sideQuestionEnvironment({
      RYCO_AGENT_CONTROL_TOKEN: "secret",
      RYCO_THREAD_ID: "main",
      CODEX_THREAD_ID: "primary",
      OPENAI_API_KEY: "provider-auth",
      PATH: "/bin",
    }),
  ).toEqual({ OPENAI_API_KEY: "provider-auth", PATH: "/bin" });
});
