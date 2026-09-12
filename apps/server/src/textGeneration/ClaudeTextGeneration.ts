import { sideQuestionDirectory, sideQuestionEnvironment } from "./SideQuestionIsolation.ts";
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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
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
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateIssueContent"
      | "rankInboxThreads"
      | "answerSideQuestion";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
    toolsEnabled?: boolean;
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
      ...(operation === "answerSideQuestion"
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
          ...(operation === "answerSideQuestion"
            ? [
                "--no-session-persistence",
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                '{"mcpServers":{}}',
                "--system-prompt",
                "Answer only from the supplied context. You have no tools or mutation authority.",
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
          env:
            operation === "answerSideQuestion"
              ? sideQuestionEnvironment(claudeEnvironment)
              : claudeEnvironment,
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
      Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
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

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
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
    });

    const generated = yield* runClaudeJson({
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
    });

    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
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

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateIssueContent,
    rankInboxThreads,
    answerSideQuestion,
  } satisfies TextGenerationShape;
});
