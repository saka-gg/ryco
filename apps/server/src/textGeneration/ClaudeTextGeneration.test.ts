import { ClaudeSettings, ProviderInstanceId, TextGenerationError } from "@ryco/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { createModelSelection } from "@ryco/shared/model";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";

const ClaudeTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const claudePath = path.join(binDir, "claude");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      claudePath,
      [
        "#!/bin/sh",
        'args="$*"',
        'stdin_content="$(cat)"',
        'if [ -n "$RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN" ]; then',
        '  printf "%s" "$args" | grep -F -- "$RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "args missing expected content" >&2',
        "    exit 2",
        "  }",
        "fi",
        'if [ -n "$RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$args" | grep -F -- "$RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "args contained forbidden content" >&2',
        "    exit 3",
        "  fi",
        "fi",
        'if [ -n "$RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 4",
        "  }",
        "fi",
        'if [ -n "$RYCO_FAKE_CLAUDE_HOME_MUST_BE" ] && [ "$HOME" != "$RYCO_FAKE_CLAUDE_HOME_MUST_BE" ]; then',
        '  printf "%s\\n" "HOME was $HOME" >&2',
        "  exit 5",
        "fi",
        'if [ -n "$RYCO_FAKE_CLAUDE_STDERR" ]; then',
        '  printf "%s\\n" "$RYCO_FAKE_CLAUDE_STDERR" >&2',
        "fi",
        'printf "%s" "$RYCO_FAKE_CLAUDE_OUTPUT"',
        'exit "${RYCO_FAKE_CLAUDE_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(claudePath, 0o755);
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    homeMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const previousPath = process.env.PATH;
    const previousOutput = process.env.RYCO_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.RYCO_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.RYCO_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousHomeMustBe = process.env.RYCO_FAKE_CLAUDE_HOME_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.RYCO_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.homeMustBe !== undefined) {
          process.env.RYCO_FAKE_CLAUDE_HOME_MUST_BE = input.homeMustBe;
        } else {
          delete process.env.RYCO_FAKE_CLAUDE_HOME_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.RYCO_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.RYCO_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_STDERR;
          } else {
            process.env.RYCO_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.RYCO_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.RYCO_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousHomeMustBe === undefined) {
            delete process.env.RYCO_FAKE_CLAUDE_HOME_MUST_BE;
          } else {
            process.env.RYCO_FAKE_CLAUDE_HOME_MUST_BE = previousHomeMustBe;
          }
        }),
    );

    const config = Schema.decodeSync(ClaudeSettings)(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("ranks inbox threads with the requested Claude model", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            rankings: [
              {
                candidateId: "candidate-0001",
                tier: "soon",
                confidence: "medium",
                reason: "Useful next work",
              },
            ],
          },
        }),
        stdinMustContain: "Untrusted candidate data (JSON)",
        argsMustContain: "--model claude-sonnet-4-5",
        argsMustNotContain: "--dangerously-skip-permissions",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.rankInboxThreads(
            makeThreadPriorityTestInput(
              ProviderInstanceId.make("claudeAgent"),
              "claude-sonnet-4-5",
            ),
          );
          expect(result.rankings).toMatchObject([
            { threadId: "thread-priority-test", tier: "soon", confidence: "medium" },
          ]);
        }),
    ),
  );

  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"fastMode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("forwards Claude Opus 4.8 ultracode as xhigh effort with settings", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort xhigh --settings {"ultracode":true}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-ultracode",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-8", [
                { id: "effort", value: "ultracode" },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("summarizes workspace changes in a lightweight, tool-free call", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: { summary: "  Adds a **farewell** greeting.  " },
        }),
        argsMustContain: "--no-session-persistence",
        stdinMustContain: "+goodbye",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.summarizeWorkspaceChanges({
            cwd: process.cwd(),
            branch: "topic",
            statusSummary: " M app.ts",
            diffPatch: "diff --git a/app.ts b/app.ts\n+goodbye",
            untrackedFiles: "",
            unmergedLog: "",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.summary).toBe("Adds a farewell greeting.");
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHome = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          homeMustBe: claudeHome,
          claudeConfig: { homePath: claudeHome },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("generateIssueContent polish mode returns title and body via Claude", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Fix session expiry bug",
            body: "## Steps to reproduce\n- Log in\n- Wait 10 min",
          },
        }),
        stdinMustContain: "rewrite rough notes into a clear GitHub issue",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "polish",
            rough: "session expires too early after idle",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("Fix session expiry bug");
          expect(generated.body).toBe("## Steps to reproduce\n- Log in\n- Wait 10 min");
        }),
    ),
  );

  it.effect("generateIssueContent title mode returns title only via Claude", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Support markdown export",
          },
        }),
        stdinMustContain: "concise GitHub issue titles from an existing body",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIssueContent({
            cwd: process.cwd(),
            mode: "title",
            body: "Users want to export notes as markdown files.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("Support markdown export");
          expect(generated.body).toBeUndefined();
        }),
    ),
  );

  it.effect("generateIssueContent fails with TextGenerationError when Claude exits non-zero", () =>
    withFakeClaudeEnv(
      {
        output: "",
        exitCode: 1,
        stderr: "claude issue generation failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateIssueContent({
              cwd: process.cwd(),
              mode: "polish",
              rough: "some notes",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.operation).toBe("generateIssueContent");
            expect(result.failure.message).toContain(
              "Claude CLI command failed: claude issue generation failed",
            );
          }
        }),
    ),
  );
});
