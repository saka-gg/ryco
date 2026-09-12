import { OpenCodeSettings, ProviderInstanceId, TextGenerationError } from "@ryco/contracts";
import type { ChatFileAttachment, ChatImageAttachment } from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Duration, Effect, Layer, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { NetService } from "@ryco/shared/Net";
import { beforeEach, expect } from "vite-plus/test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ServerConfig } from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../provider/opencodeRuntime.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeOpenCodeTextGeneration } from "./OpenCodeTextGeneration.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    promptUrls: [] as string[],
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    promptResult: undefined as
      | { data?: { info?: { error?: unknown }; parts?: Array<{ type: string; text?: string }> } }
      | undefined,
    promptParts: [] as Array<Array<{ type: string; text?: string }>>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.promptUrls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.promptResult = undefined;
    this.state.promptParts.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      // The production runtime binds server lifetime to the caller's scope.
      // Mirror that here so the closeCalls probe observes scope close.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      ...(serverPassword ? { serverPassword } : {}),
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    Effect.succeed({
      global: {
        health: async () => ({ data: { healthy: true, version: "1.18.18" } }),
      },
      session: {
        create: async () => ({ data: { id: `${baseUrl}/session` } }),
        prompt: async (input?: { parts?: Array<{ type: string; text?: string }> }) => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.promptParts.push(input?.parts ?? []);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    } as unknown as OpencodeClient),
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5",
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationTestLayer = Layer.succeed(
  OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-opencode-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.succeed(
  OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-opencode-text-generation-existing-server-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
});
const EXISTING_SERVER_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

function withOpenCodeTextGeneration<A, E, R>(
  settings: OpenCodeSettings,
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const textGeneration = yield* makeOpenCodeTextGeneration(settings);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

beforeEach(() => {
  runtimeMock.reset();
});

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGeneration", (it) => {
  it.effect("rejects side questions before starting an unsafe provider runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeOpenCodeTextGeneration(
          Schema.decodeSync(OpenCodeSettings)({ binaryPath: "/missing-side-question-provider" }),
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
        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.promptUrls).toEqual([]);
      }),
    ),
  );

  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4301",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual([]);

        yield* advanceIdleClock;

        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "degrades non-native attachments to metadata lines while native ones become file parts",
    () =>
      withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          const serverConfig = yield* ServerConfig;
          const nativeAttachment: ChatImageAttachment = {
            type: "image",
            id: "native-image-0001",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 4,
          };
          const zipAttachment: ChatFileAttachment = {
            type: "file",
            id: "zip-attachment-0001",
            name: "archive.zip",
            mimeType: "application/zip",
            sizeBytes: 4,
          };
          const nativePath = path.join(
            serverConfig.attachmentsDir,
            attachmentRelativePath(nativeAttachment) ?? "",
          );
          const zipPath = path.join(
            serverConfig.attachmentsDir,
            attachmentRelativePath(zipAttachment) ?? "",
          );
          yield* Effect.promise(async () => {
            await writeFile(nativePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            await writeFile(zipPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
          });
          runtimeMock.state.promptResult = {
            data: {
              parts: [{ type: "text", text: JSON.stringify({ title: "Attachment title" }) }],
            },
          };

          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Summarize from attachments",
            attachments: [nativeAttachment, zipAttachment],
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          const parts = runtimeMock.state.promptParts.at(-1) ?? [];
          const textPart = parts.find((part) => part.type === "text");
          expect(textPart?.text).toContain(
            "[Attached file] archive.zip (application/zip, 4 bytes)",
          );
          expect(textPart?.text).toContain(`saved at: ${zipPath}`);
          const fileParts = parts.filter((part) => part.type === "file");
          expect(fileParts).toHaveLength(1);
          expect(fileParts[0]).toMatchObject({ filename: "shot.png", mime: "image/png" });
        }),
      ),
  );

  it.effect("ranks inbox threads with the configured OpenCode model", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  rankings: [
                    {
                      candidateId: "candidate-0001",
                      tier: "later",
                      confidence: "medium",
                      reason: "Safe to defer briefly",
                    },
                  ],
                }),
              },
            ],
          },
        };
        const result = yield* textGeneration.rankInboxThreads(
          makeThreadPriorityTestInput(ProviderInstanceId.make("opencode"), "openai/gpt-5"),
        );
        expect(result.rankings).toMatchObject([
          { threadId: "thread-priority-test", tier: "later", confidence: "medium" },
        ]);
      }),
    ),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        yield* advanceIdleClock;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode", "fake-opencode"]);
        expect(runtimeMock.state.promptUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4302",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns a typed empty-output error when OpenCode returns no text parts", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = { data: {} };

        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode returned empty output.");
      }),
    ),
  );

  it.effect("parses JSON returned as plain text output", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [
              {
                type: "text",
                text: 'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}',
              },
            ],
          },
        };

        const result = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(result).toEqual({
          subject: "Tighten OpenCode parsing",
          body: "Handle JSON text output locally.",
        });
      }),
    ),
  );

  it.effect("surfaces the upstream OpenCode structured-output error message", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            info: {
              error: {
                name: "StructuredOutputError",
                data: {
                  message: "Model did not produce structured output",
                  retries: 2,
                },
              },
            },
          },
        };

        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("Model did not produce structured output");
      }),
    ),
  );

  it.effect("generateIssueContent polish mode returns title and body via OpenCode", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({
                  title: "Fix race condition in event loop",
                  body: "## Steps to reproduce\n- Run concurrent requests",
                }),
              },
            ],
          },
        };

        const generated = yield* textGeneration.generateIssueContent({
          cwd: process.cwd(),
          mode: "polish",
          rough: "race condition in event loop under high concurrency",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Fix race condition in event loop");
        expect(generated.body).toBe("## Steps to reproduce\n- Run concurrent requests");
      }),
    ),
  );

  it.effect("generateIssueContent title mode returns title only via OpenCode", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.promptResult = {
          data: {
            parts: [
              {
                type: "text",
                text: JSON.stringify({ title: "Support custom themes" }),
              },
            ],
          },
        };

        const generated = yield* textGeneration.generateIssueContent({
          cwd: process.cwd(),
          mode: "title",
          body: "Users want to define custom color themes in the settings panel.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Support custom themes");
        expect(generated.body).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "generateIssueContent fails with TextGenerationError when OpenCode returns invalid JSON",
    () =>
      withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          runtimeMock.state.promptResult = {
            data: {
              parts: [
                {
                  type: "text",
                  text: "not valid json",
                },
              ],
            },
          };

          const result = yield* textGeneration
            .generateIssueContent({
              cwd: process.cwd(),
              mode: "polish",
              rough: "some rough notes",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
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
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGeneration with configured server URL",
  (it) => {
    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(runtimeMock.state.startCalls).toEqual([]);
          expect(runtimeMock.state.promptUrls).toEqual([
            "http://127.0.0.1:9999",
            "http://127.0.0.1:9999",
          ]);
          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:secret-password")}`,
            `Basic ${btoa("opencode:secret-password")}`,
          ]);

          yield* advanceIdleClock;

          expect(runtimeMock.state.closeCalls).toEqual([]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
