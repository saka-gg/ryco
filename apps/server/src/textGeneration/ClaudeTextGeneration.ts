import {
  isolatedTextGenerationDirectory,
  type LightweightTextGenerationOperation,
  lightweightSystemPrompt,
  sideQuestionDirectory,
  sideQuestionEnvironment,
  withFullConfigFallback,
} from "./SideQuestionIsolation.ts";
/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGenerationShape contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, type ModelSelection } from "@ryco/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@ryco/shared/git";

import { TextGenerationError } from "@ryco/contracts";
import { type TextGenerationShape, validateRankInboxThreadsResult } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildIssueContentPolishPrompt,
  buildIssueContentTitlePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildThreadPriorityPrompt,
  buildSideQuestionPrompt,
  buildWorkspaceChangesSummaryPrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitleResult,
  sanitizeWorkspaceChangesSummary,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@ryco/shared/model";
import {
  getClaudeModelCapabilities,
  isClaudeUltracodeEffort,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "../provider/Layers/ClaudeProvider.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
/**
 * Titles, branch names and workspace change summaries are short; each has a
 * fallback (the user's own message, or no summary).
 */
const CLAUDE_NAMING_TIMEOUT_MS = 30_000;
const CLAUDE_TIMEOUT_DETAIL = "Claude CLI request timed out.";

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * We only care about `structured_output`.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    toolsEnabled = true,
    lightweight = operation === "answerSideQuestion",
    persistSession = true,
    timeoutMs = CLAUDE_TIMEOUT_MS,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateIssueContent"
      | "rankInboxThreads"
      | "answerSideQuestion"
      | "summarizeWorkspaceChanges";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
    toolsEnabled?: boolean;
    /**
     * Run without the user's setting sources, MCP servers, hooks, memory and
     * CLAUDE.md, with a short system prompt, in an isolated environment.
     */
    lightweight?: boolean;
    /** False skips writing a Claude Code session for the call. */
    persistSession?: boolean;
    timeoutMs?: number;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = JSON.stringify(toJsonSchemaObject(outputSchemaJson));
    const caps = getClaudeModelCapabilities(modelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: modelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(modelSelection, "effort");
    const resolvedEffort = resolveClaudeEffort(caps, rawEffortSelection);
    const cliEffort = normalizeClaudeCliEffort(resolvedEffort, modelSelection.model);
    const ultracode = isClaudeUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      ...(lightweight
        ? {
            disableAllHooks: true,
            autoMemoryEnabled: false,
            claudeMdExcludes: ["**"],
          }
        : {}),
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      const command = ChildProcess.make(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          ...(lightweight || !persistSession ? ["--no-session-persistence"] : []),
          ...(lightweight
            ? [
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--system-prompt",
                lightweightSystemPrompt(operation),
              ]
            : []),
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeApiModelId(modelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          ...(Object.keys(settings).length > 0 ? ["--settings", JSON.stringify(settings)] : []),
          ...(toolsEnabled ? ["--dangerously-skip-permissions"] : ["--tools", ""]),
        ],
        {
          env: lightweight ? sideQuestionEnvironment(claudeEnvironment) : claudeEnvironment,
          cwd,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to read Claude CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation, detail: CLAUDE_TIMEOUT_DETAIL })),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope))(
      rawStdout,
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    return yield* Schema.decodeEffect(outputSchemaJson)(envelope.structured_output).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGenerationShape methods
  // ---------------------------------------------------------------------------

  /**
   * Titles, branch names and change summaries: lightweight first, in an empty directory, then
   * once with the user's setting sources (env, apiKeyHelper) when that may be
   * what was missing. Never with tools, never persisted as a session.
   */
  const runClaudeNamingJson = <S extends Schema.Top>(input: {
    readonly operation: Extract<
      LightweightTextGenerationOperation,
      "generateThreadTitle" | "generateBranchName" | "summarizeWorkspaceChanges"
    >;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) => {
    const shared = {
      ...input,
      toolsEnabled: false,
      persistSession: false,
      timeoutMs: CLAUDE_NAMING_TIMEOUT_MS,
    };
    return withFullConfigFallback({
      operation: input.operation,
      lightweight: Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* isolatedTextGenerationDirectory(input.operation);
          return yield* runClaudeJson({ ...shared, cwd, lightweight: true });
        }),
      ),
      full: runClaudeJson({ ...shared, lightweight: false }),
      isTimeout: (error) => error.detail === CLAUDE_TIMEOUT_DETAIL,
    });
  };

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      policy: input.policy,
    });

    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
      policy: input.policy,
    });

    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
      branchChangeTypes: input.branchChangeTypes,
    });

    const generated = yield* runClaudeNamingJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
      includeBranch: input.includeBranch,
      branchChangeTypes: input.branchChangeTypes,
    });

    const generated = yield* runClaudeNamingJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return sanitizeThreadTitleResult(generated);
  });

  const generateIssueContent: TextGenerationShape["generateIssueContent"] = Effect.fn(
    "ClaudeTextGeneration.generateIssueContent",
  )(function* (input) {
    if (input.mode === "polish") {
      const { prompt, outputSchema } = buildIssueContentPolishPrompt({
        rough: input.rough ?? "",
        ...(input.currentTitle ? { currentTitle: input.currentTitle } : {}),
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
      });
      const decoded = yield* runClaudeJson({
        operation: "generateIssueContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: decoded.title.trim(), body: decoded.body.trim() };
    } else {
      const { prompt, outputSchema } = buildIssueContentTitlePrompt({
        body: input.body ?? "",
      });
      const decoded = yield* runClaudeJson({
        operation: "generateIssueContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: decoded.title.trim() };
    }
  });

  const answerSideQuestion: TextGenerationShape["answerSideQuestion"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* sideQuestionDirectory;
        const { prompt, outputSchema } = buildSideQuestionPrompt(input);
        return yield* runClaudeJson({
          operation: "answerSideQuestion",
          cwd,
          prompt,
          outputSchemaJson: outputSchema,
          modelSelection: input.modelSelection,
          toolsEnabled: false,
        });
      }),
    );

  const rankInboxThreads: TextGenerationShape["rankInboxThreads"] = Effect.fn(
    "ClaudeTextGeneration.rankInboxThreads",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadPriorityPrompt({
      serializedCandidates: input.chunk.serializedCandidates,
    });
    const generated = yield* runClaudeJson({
      operation: "rankInboxThreads",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      toolsEnabled: false,
    });
    return yield* validateRankInboxThreadsResult(input, generated.rankings);
  });

  const summarizeWorkspaceChanges: TextGenerationShape["summarizeWorkspaceChanges"] = Effect.fn(
    "ClaudeTextGeneration.summarizeWorkspaceChanges",
  )(function* (input) {
    const { prompt, outputSchema } = buildWorkspaceChangesSummaryPrompt(input);
    const generated = yield* runClaudeNamingJson({
      operation: "summarizeWorkspaceChanges",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { summary: sanitizeWorkspaceChangesSummary(generated.summary) };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateIssueContent,
    rankInboxThreads,
    answerSideQuestion,
    summarizeWorkspaceChanges,
  } satisfies TextGenerationShape;
});
