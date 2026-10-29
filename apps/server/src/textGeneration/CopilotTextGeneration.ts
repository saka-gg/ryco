import {
  isolatedTextGenerationDirectory,
  lightweightSystemPrompt,
  sideQuestionDirectory,
  sideQuestionEnvironment,
  withFullConfigFallback,
} from "./SideQuestionIsolation.ts";
import {
  CodexSettings,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_OPTIONS_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type CopilotSettings,
  type ModelSelection,
} from "@ryco/contracts";
import { getModelSelectionStringOptionValue } from "@ryco/shared/model";
import { CopilotClient, type SessionConfig } from "@github/copilot-sdk";
import { Effect, Option, Schema } from "effect";

import { makeCopilotClientOptions } from "../provider/Layers/CopilotAdapter.ts";
import { withCopilotAgentPriority } from "../provider/Layers/CopilotAdapter.types.ts";
import type { AgentProcessPriorityShape } from "../provider/agentProcessPriority.ts";
import {
  COPILOT_CLIENT_STOP_TIMEOUT_MS,
  stopCopilotClient,
} from "../provider/Layers/CopilotAdapter.clientStop.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { type TextGenerationShape, validateRankInboxThreadsResult } from "./TextGeneration.ts";
import {
  buildSideQuestionPrompt,
  buildThreadPriorityPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { extractJsonObject, sanitizeThreadTitleResult } from "./TextGenerationUtils.ts";

/**
 * A title (and branch name) is short and falls back to the user's own message, so a hung
 * Copilot CLI must not hold it: the whole call, session start included, is bounded.
 */
const COPILOT_NAMING_TIMEOUT_MS = 30_000;
const COPILOT_NAMING_TIMEOUT_DETAIL = "GitHub Copilot title generation timed out.";
const COPILOT_INBOX_RANKING_TIMEOUT_MS = 60_000;
const COPILOT_SIDE_QUESTION_TIMEOUT_MS = 180_000;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

type CopilotReasoningEffort = "low" | "medium" | "high" | "xhigh";

function copilotModelConfig(
  modelSelection: ModelSelection,
): Pick<SessionConfig, "model" | "reasoningEffort"> {
  const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
  return {
    model: modelSelection.model,
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as CopilotReasoningEffort } : {}),
  };
}

/**
 * A session without the user's Copilot config, custom instructions, hooks, skills or session
 * store, in an empty directory, with `systemMessage` in place of the coding-agent prompt.
 */
function isolatedCopilotSessionConfig(
  directory: string,
  systemMessage: string,
): Omit<SessionConfig, "model" | "reasoningEffort" | "onPermissionRequest"> {
  return {
    workingDirectory: directory,
    configDirectory: directory,
    streaming: false,
    availableTools: [],
    systemMessage: { mode: "replace", content: systemMessage },
    enableConfigDiscovery: false,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    infiniteSessions: { enabled: false },
  };
}

/**
 * One prompt in a fresh session on `client`. Interruption aborts the session; the caller owns
 * the client and stops it.
 */
async function promptCopilotSession(input: {
  readonly client: CopilotClient;
  readonly sessionConfig: SessionConfig;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<string> {
  const session = await input.client.createSession(input.sessionConfig);
  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal.aborted) {
      abort();
      throw new Error("GitHub Copilot request cancelled.");
    }
    const response = await session.sendAndWait(
      { prompt: input.prompt, mode: "immediate" },
      input.timeoutMs,
    );
    return response?.data.content ?? "";
  } finally {
    input.signal.removeEventListener("abort", abort);
    await session.disconnect();
  }
}

function gitTextGenerationSelection(): ModelSelection {
  const options = DEFAULT_GIT_TEXT_GENERATION_OPTIONS_BY_PROVIDER[CODEX_DRIVER_KIND];
  return {
    instanceId: ProviderInstanceId.make("codex"),
    model:
      DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[CODEX_DRIVER_KIND] ??
      DEFAULT_GIT_TEXT_GENERATION_MODEL,
    ...(options ? { options } : {}),
  };
}

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
  /** Test seam; the default runs the configured CLI (through `nice` per `processPriority`). */
  clientFactoryOverride?: (cwd: string, sideQuestion?: boolean) => Effect.Effect<CopilotClient>,
  options?: { readonly processPriority?: AgentProcessPriorityShape | undefined },
) {
  const processPriority = options?.processPriority;
  const clientFactory =
    clientFactoryOverride ??
    ((cwd: string, sideQuestion?: boolean) =>
      Effect.promise(() =>
        makeCopilotClientOptions(
          copilotSettings,
          sideQuestion ? sideQuestionEnvironment(environment) : environment,
          cwd,
        ),
      ).pipe(
        Effect.flatMap((clientOptions) => withCopilotAgentPriority(processPriority, clientOptions)),
        Effect.map((clientOptions) => new CopilotClient(clientOptions)),
      ));
  const codexFallback = yield* makeCodexTextGeneration(
    Schema.decodeSync(CodexSettings)({}),
    environment,
    { processPriority },
  );

  const withGitFallbackSelection = <T extends { readonly modelSelection: ModelSelection }>(
    input: T,
  ): T => ({
    ...input,
    modelSelection: gitTextGenerationSelection(),
  });

  /** A client for one call, stopped when the call's scope closes (also on interruption). */
  const scopedClient = (cwd: string, sideQuestion?: boolean) =>
    Effect.acquireRelease(clientFactory(cwd, sideQuestion), (client) =>
      Effect.promise(() =>
        stopCopilotClient({ client, timeoutMs: COPILOT_CLIENT_STOP_TIMEOUT_MS }),
      ),
    );

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
        includeBranch: input.includeBranch,
        branchChangeTypes: input.branchChangeTypes,
      });
      const attempt = (lightweight: boolean) =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = lightweight
              ? yield* isolatedTextGenerationDirectory("generateThreadTitle")
              : input.cwd;
            const client = yield* scopedClient(directory, lightweight);
            const sessionConfig: SessionConfig = {
              ...copilotModelConfig(input.modelSelection),
              ...(lightweight
                ? isolatedCopilotSessionConfig(
                    directory,
                    lightweightSystemPrompt("generateThreadTitle"),
                  )
                : { workingDirectory: input.cwd, streaming: false, availableTools: [] }),
              onPermissionRequest: () => ({ kind: "reject" }),
            };
            const content = yield* Effect.tryPromise({
              try: (signal) =>
                promptCopilotSession({
                  client,
                  sessionConfig,
                  prompt,
                  timeoutMs: COPILOT_NAMING_TIMEOUT_MS,
                  signal,
                }),
              catch: (cause) =>
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail:
                    cause instanceof Error
                      ? `GitHub Copilot title generation failed: ${cause.message}`
                      : "GitHub Copilot title generation failed.",
                  cause,
                }),
            }).pipe(
              Effect.timeoutOption(COPILOT_NAMING_TIMEOUT_MS),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new TextGenerationError({
                        operation: "generateThreadTitle",
                        detail: COPILOT_NAMING_TIMEOUT_DETAIL,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
            return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
              extractJsonObject(content),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: "generateThreadTitle",
                    detail: "GitHub Copilot returned invalid title JSON.",
                    cause,
                  }),
              ),
            );
          }),
        );

      // Lightweight first; the user's own configuration once more when that may be what was
      // missing. One call answers the branch name too when it is asked for.
      const generated = yield* withFullConfigFallback({
        operation: "generateThreadTitle",
        lightweight: attempt(true),
        full: attempt(false),
        isTimeout: (error) => error.detail === COPILOT_NAMING_TIMEOUT_DETAIL,
      });
      return sanitizeThreadTitleResult(generated);
    });

  const answerSideQuestion: TextGenerationShape["answerSideQuestion"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* sideQuestionDirectory;
        const { prompt, outputSchema } = buildSideQuestionPrompt(input);
        const client = yield* scopedClient(cwd, true);
        const content = yield* Effect.tryPromise({
          try: (signal) =>
            promptCopilotSession({
              client,
              sessionConfig: {
                ...copilotModelConfig(input.modelSelection),
                ...isolatedCopilotSessionConfig(
                  cwd,
                  "Answer only from the supplied completed context. No tools, file access, or mutations are permitted.",
                ),
                onPermissionRequest: () => ({ kind: "reject" }),
              },
              prompt,
              timeoutMs: COPILOT_SIDE_QUESTION_TIMEOUT_MS,
              signal,
            }),
          catch: (cause) =>
            new TextGenerationError({
              operation: "answerSideQuestion",
              detail: "GitHub Copilot side question failed.",
              cause,
            }),
        });
        return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
          extractJsonObject(content),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "answerSideQuestion",
                detail: "GitHub Copilot returned invalid side question JSON.",
                cause,
              }),
          ),
        );
      }),
    );

  const rankInboxThreads: TextGenerationShape["rankInboxThreads"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadPriorityPrompt({
          serializedCandidates: input.chunk.serializedCandidates,
        });
        const client = yield* scopedClient(input.cwd);
        const sessionConfig: SessionConfig = {
          ...copilotModelConfig(input.modelSelection),
          workingDirectory: input.cwd,
          streaming: false,
          availableTools: [],
          onPermissionRequest: () => ({ kind: "reject" }),
        };

        const content = yield* Effect.tryPromise({
          try: (signal) =>
            promptCopilotSession({
              client,
              sessionConfig,
              prompt,
              timeoutMs: COPILOT_INBOX_RANKING_TIMEOUT_MS,
              signal,
            }),
          catch: (cause) =>
            new TextGenerationError({
              operation: "rankInboxThreads",
              detail:
                cause instanceof Error
                  ? `GitHub Copilot inbox ranking failed: ${cause.message}`
                  : "GitHub Copilot inbox ranking failed.",
              cause,
            }),
        });
        const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
          extractJsonObject(content),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "rankInboxThreads",
                detail: "GitHub Copilot returned invalid inbox ranking JSON.",
                cause,
              }),
          ),
        );
        return yield* validateRankInboxThreadsResult(input, parsed.rankings);
      }),
    );

  return {
    generateCommitMessage: (input) =>
      codexFallback.generateCommitMessage(withGitFallbackSelection(input)),
    generatePrContent: (input) => codexFallback.generatePrContent(withGitFallbackSelection(input)),
    generateBranchName: (input) =>
      codexFallback.generateBranchName(withGitFallbackSelection(input)),
    generateThreadTitle,
    generateIssueContent: (input) =>
      codexFallback.generateIssueContent(withGitFallbackSelection(input)),
    rankInboxThreads,
    answerSideQuestion,
    summarizeWorkspaceChanges: (input) =>
      codexFallback.summarizeWorkspaceChanges(withGitFallbackSelection(input)),
  } satisfies TextGenerationShape;
});
