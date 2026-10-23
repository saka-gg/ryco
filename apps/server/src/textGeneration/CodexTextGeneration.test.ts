import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { createModelSelection } from "@ryco/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@ryco/contracts";

import os from "node:os";

import { agentCommandResolves, resolveNiceExecutable } from "@ryco/shared/processPriority";

import { ServerConfig } from "../config.ts";
import {
  type AgentProcessPriorityShape,
  makeAgentProcessPriority,
} from "../provider/agentProcessPriority.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeCodexBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    niceFile?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'seen_image="0"',
        'seen_fast_service_tier="0"',
        'seen_reasoning_effort=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "service_tier=\\"fast\\"" ]; then',
        '      seen_fast_service_tier="1"',
        "    fi",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.niceFile !== undefined
          ? [`ps -o nice= -p $$ > ${JSON.stringify(input.niceFile)}`]
          : []),
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireFastServiceTier
          ? [
              'if [ "$seen_fast_service_tier" != "1" ]; then',
              '  printf "%s\\n" "missing fast service tier config" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [`printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__RYCO_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__RYCO_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return codexPath;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    niceFile?: string;
    processPriority?: AgentProcessPriorityShape;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = Schema.decodeSync(CodexSettings)({ binaryPath: codexPath });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      undefined,
      input.processPriority ? { processPriority: input.processPriority } : undefined,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  it.effect("ranks inbox threads with bounded structured output", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          rankings: [
            {
              candidateId: "candidate-0001",
              tier: "now",
              confidence: "high",
              reason: "Requires attention",
            },
          ],
        }),
        stdinMustContain: "Untrusted candidate data (JSON)",
        stdinMustNotContain: "thread-priority-test",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.rankInboxThreads(
            makeThreadPriorityTestInput(ProviderInstanceId.make("codex"), "gpt-5.4-mini"),
          );
          expect(result.rankings).toMatchObject([
            { threadId: "thread-priority-test", tier: "now", confidence: "high" },
          ]);
        }),
    ),
  );

  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "max",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "max" },
              { id: "fastMode", value: true },
            ]),
          }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
        }),
    ),
  );

  const fakeCodexNiceness = (processPriority: AgentProcessPriorityShape | undefined) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-codex-nice-" });
      const niceFile = path.join(dir, "nice");
      yield* withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Lower priority" }),
          niceFile,
          ...(processPriority ? { processPriority } : {}),
        },
        (textGeneration) =>
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Run agents at a lower priority",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }),
      );
      return Number((yield* fs.readFileString(niceFile)).trim());
    }).pipe(Effect.scoped);

  it.effect.skipIf(process.platform === "win32" || resolveNiceExecutable() === null)(
    "runs codex exec at the server's niceness + 5 with agent priority",
    () =>
      Effect.gen(function* () {
        const priority = makeAgentProcessPriority({
          enabled: Effect.succeed(true),
          platform: process.platform,
          niceExecutable: resolveNiceExecutable,
          commandResolves: agentCommandResolves,
          lowerChild: () => "unchanged",
        });
        expect(yield* fakeCodexNiceness(priority)).toBe(Math.min(19, os.getPriority() + 5));
        expect(yield* fakeCodexNiceness(undefined)).toBe(os.getPriority());
      }),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig;
          const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );

  it.effect("generateIssueContent polish mode returns title and body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login timeout", body: "## Steps\n- log in\n- wait" }),
        stdinMustContain: "rewrite rough notes into a clear GitHub issue",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "polish",
            rough: "login times out after 5 minutes of idle",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Fix login timeout");
          expect(generated.body).toBe("## Steps\n- log in\n- wait");
        }),
    ),
  );

  it.effect("generateIssueContent title mode returns title only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Add dark mode support" }),
        stdinMustContain: "concise GitHub issue titles from an existing body",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "title",
            body: "## Summary\nUsers want a dark mode toggle in settings.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Add dark mode support");
          expect(generated.body).toBeUndefined();
        }),
    ),
  );

  it.effect("generateIssueContent fails with TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: "",
        exitCode: 1,
        stderr: "codex issue generation failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
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
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex issue generation failed",
            );
          }
        }),
    ),
  );
});
