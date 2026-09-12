import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { createModelSelection } from "@ryco/shared/model";
import { expect } from "vite-plus/test";

import { CursorSettings, ProviderInstanceId, TextGenerationError } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeCursorTextGeneration } from "./CursorTextGeneration.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const CursorTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-cursor-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpAgentWrapper(dir: string, env: Record<string, string>): string {
  const binDir = path.join(dir, "bin");
  const agentPath = path.join(binDir, "agent");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    agentPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec bun ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(agentPath, 0o755);
  return agentPath;
}

function withFakeAcpAgent<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "ryco-cursor-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const agentPath = makeAcpAgentWrapper(tempDir, env);
    const config = Schema.decodeSync(CursorSettings)({ binaryPath: agentPath });
    const textGeneration = yield* makeCursorTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function waitForFileContent(path: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
}

it.layer(CursorTextGenerationTestLayer)("CursorTextGeneration", (it) => {
  it.effect("rejects side questions before starting an unsafe provider runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeCursorTextGeneration(
          Schema.decodeSync(CursorSettings)({ binaryPath: "/missing-side-question-provider" }),
        );
        const error = yield* service
          .answerSideQuestion({
            cwd: process.cwd(),
            context: "completed",
            question: "Why?",
            history: [],
            modelSelection: { instanceId: ProviderInstanceId.make("test"), model: "test" },
          })
          .pipe(Effect.flip);
        expect(error.operation).toBe("answerSideQuestion");
        expect(error.detail).toContain("tool-free side question");
      }),
    ),
  );

  it.effect("ranks inbox threads through tool-disabled ACP", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "ryco-cursor-rank-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        RYCO_ACP_REQUEST_LOG_PATH: requestLogPath,
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          rankings: [
            {
              candidateId: "candidate-0001",
              tier: "soon",
              confidence: "high",
              reason: "Continue the requested repair",
            },
          ],
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.rankInboxThreads(
            makeThreadPriorityTestInput(ProviderInstanceId.make("cursor"), "composer-2"),
          );
          expect(result.rankings).toMatchObject([
            { threadId: "thread-priority-test", tier: "soon", confidence: "high" },
          ]);

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
          expect(
            requests.find((request) => request.method === "session/prompt")?.params?.prompt,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Untrusted candidate data (JSON)"),
              }),
            ]),
          );
          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("uses ACP model config options instead of raw CLI model ids", () => {
    const requestLogDir = mkdtempSync(path.join(os.tmpdir(), "ryco-cursor-text-log-"));
    const requestLogPath = path.join(requestLogDir, "requests.ndjson");

    return withFakeAcpAgent(
      {
        RYCO_ACP_REQUEST_LOG_PATH: requestLogPath,
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add generated commit message",
          body: "- verify cursor acp model config path",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-text-generation",
            stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
                { id: "reasoning", value: "xhigh" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "1m" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add generated commit message");
          expect(generated.body).toBe("- verify cursor acp model config path");

          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line.length > 0)
            .map(
              (line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> },
            );

          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            _meta: {
              parameterizedModelPicker: true,
            },
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "model" &&
                request.params?.value === "gpt-5.4",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "reasoning" &&
                request.params?.value === "extra-high",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "context" &&
                request.params?.value === "1m",
            ),
          ).toBe(true);
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "fast" &&
                request.params?.value === "true",
            ),
          ).toBe(true);
          expect(
            requests.find((request) => request.method === "session/prompt")?.params?.prompt,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Staged patch:"),
              }),
            ]),
          );

          rmSync(requestLogDir, { recursive: true, force: true });
        }),
    );
  });

  it.effect("accepts json objects with extra assistant text around them", () =>
    withFakeAcpAgent(
      {
        RYCO_ACP_PROMPT_RESPONSE_TEXT:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-noisy-json",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.subject).toBe("Update README dummy comment with attribution and date");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("generates thread titles through Cursor ACP text generation", () =>
    withFakeAcpAgent(
      {
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: '"Trim reconnect spinner status after resume."',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.title).toBe("Trim reconnect spinner status after resume.");
        }),
    ),
  );

  it.effect("generateIssueContent polish mode returns title and body via Cursor ACP", () =>
    withFakeAcpAgent(
      {
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "Fix null pointer in parser",
          body: "## Steps to reproduce\n- Parse an empty file",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "polish",
            rough: "null pointer when parsing empty file",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.title).toBe("Fix null pointer in parser");
          expect(generated.body).toBe("## Steps to reproduce\n- Parse an empty file");
        }),
    ),
  );

  it.effect("generateIssueContent title mode returns title only via Cursor ACP", () =>
    withFakeAcpAgent(
      {
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "Add keyboard shortcut for search",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "title",
            body: "Users want a keyboard shortcut to open the search panel.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.title).toBe("Add keyboard shortcut for search");
          expect(generated.body).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "generateIssueContent fails with TextGenerationError when Cursor returns invalid JSON",
    () =>
      withFakeAcpAgent(
        {
          RYCO_ACP_PROMPT_RESPONSE_TEXT: "not valid json at all",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateIssueContent({
                cwd: process.cwd(),
                mode: "polish",
                rough: "some rough notes",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("cursor"),
                  model: "composer-2",
                },
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.operation).toBe("generateIssueContent");
            }
          }),
      ),
  );

  it.effect("closes the ACP child process after text generation completes", () => {
    const exitLogDir = mkdtempSync(path.join(os.tmpdir(), "ryco-cursor-text-exit-log-"));
    const exitLogPath = path.join(exitLogDir, "exit.log");

    return withFakeAcpAgent(
      {
        RYCO_ACP_EXIT_LOG_PATH: exitLogPath,
        RYCO_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Close runtime after generation",
          body: "",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/cursor-runtime-close",
            stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
            stagedPatch:
              "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts b/apps/server/src/textGeneration/CursorTextGeneration.ts",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          });

          expect(generated.subject).toBe("Close runtime after generation");

          const exitLog = yield* waitForFileContent(exitLogPath);
          expect(exitLog).toContain("exit:0");

          rmSync(exitLogDir, { recursive: true, force: true });
        }),
    );
  });
});
