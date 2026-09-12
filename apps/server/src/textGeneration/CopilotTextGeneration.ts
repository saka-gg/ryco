import { sideQuestionDirectory, sideQuestionEnvironment } from "./SideQuestionIsolation.ts";
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
import { Effect, Schema } from "effect";

import { makeCopilotClientOptions } from "../provider/Layers/CopilotAdapter.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { type TextGenerationShape, validateRankInboxThreadsResult } from "./TextGeneration.ts";
import {
  buildSideQuestionPrompt,
  buildThreadPriorityPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { extractJsonObject, sanitizeThreadTitle } from "./TextGenerationUtils.ts";

const COPILOT_THREAD_TITLE_TIMEOUT_MS = 60_000;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const ThreadTitleResponse = Schema.Struct({
  title: Schema.String,
});

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
  clientFactory: (cwd: string, sideQuestion?: boolean) => CopilotClient = (cwd, sideQuestion) =>
    new CopilotClient(
      makeCopilotClientOptions(
        copilotSettings,
        sideQuestion ? sideQuestionEnvironment(environment) : environment,
        cwd,
      ),
    ),
) {
  const codexFallback = yield* makeCodexTextGeneration(
    Schema.decodeSync(CodexSettings)({}),
    environment,
  );

  const withGitFallbackSelection = <T extends { readonly modelSelection: ModelSelection }>(
    input: T,
  ): T => ({
    ...input,
    modelSelection: gitTextGenerationSelection(),
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
    Effect.gen(function* () {
      const { prompt } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const client = clientFactory(input.cwd);
      const reasoningEffort = getModelSelectionStringOptionValue(
        input.modelSelection,
        "reasoningEffort",
      );
      const sessionConfig: SessionConfig = {
        model: input.modelSelection.model,
        ...(reasoningEffort
          ? {
              reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh",
            }
          : {}),
        workingDirectory: input.cwd,
        streaming: false,
        availableTools: [],
        onPermissionRequest: () => ({ kind: "reject" }),
      };

      const content = yield* Effect.tryPromise({
        try: async () => {
          try {
            const session = await client.createSession(sessionConfig);
            const response = await session.sendAndWait(
              { prompt, mode: "immediate" },
              COPILOT_THREAD_TITLE_TIMEOUT_MS,
            );
            await session.disconnect();
            return response?.data.content ?? "";
          } finally {
            await client.stop();
          }
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail:
              cause instanceof Error
                ? `GitHub Copilot title generation failed: ${cause.message}`
                : "GitHub Copilot title generation failed.",
            cause,
          }),
      });

      const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(ThreadTitleResponse))(
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
      return { title: sanitizeThreadTitle(parsed.title) };
    });

  const answerSideQuestion: TextGenerationShape["answerSideQuestion"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* sideQuestionDirectory;
        const { prompt, outputSchema } = buildSideQuestionPrompt(input);
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => clientFactory(cwd, true)),
          (client) => Effect.promise(() => client.stop()).pipe(Effect.ignore),
        );
        const reasoningEffort = getModelSelectionStringOptionValue(
          input.modelSelection,
          "reasoningEffort",
        );
        const content = yield* Effect.tryPromise({
          try: async (signal) => {
            const session = await client.createSession({
              model: input.modelSelection.model,
              ...(reasoningEffort
                ? { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" }
                : {}),
              workingDirectory: cwd,
              configDirectory: cwd,
              streaming: false,
              availableTools: [],
              onPermissionRequest: () => ({ kind: "reject" }),
              systemMessage: {
                mode: "replace",
                content:
                  "Answer only from the supplied completed context. No tools, file access, or mutations are permitted.",
              },
              enableConfigDiscovery: false,
              enableOnDemandInstructionDiscovery: false,
              enableFileHooks: false,
              enableHostGitOperations: false,
              enableSessionStore: false,
              enableSkills: false,
              skipEmbeddingRetrieval: true,
              embeddingCacheStorage: "in-memory",
              infiniteSessions: { enabled: false },
            });
            const abort = () => {
              void session.abort().catch(() => undefined);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              if (signal.aborted) {
                abort();
                throw new Error("Side question cancelled.");
              }
              const response = await session.sendAndWait({ prompt, mode: "immediate" }, 180_000);
              return response?.data.content ?? "";
            } finally {
              signal.removeEventListener("abort", abort);
              await session.disconnect();
            }
          },
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
    Effect.gen(function* () {
      const { prompt, outputSchema } = buildThreadPriorityPrompt({
        serializedCandidates: input.chunk.serializedCandidates,
      });
      const client = clientFactory(input.cwd);
      const reasoningEffort = getModelSelectionStringOptionValue(
        input.modelSelection,
        "reasoningEffort",
      );
      const sessionConfig: SessionConfig = {
        model: input.modelSelection.model,
        ...(reasoningEffort
          ? { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" }
          : {}),
        workingDirectory: input.cwd,
        streaming: false,
        availableTools: [],
        onPermissionRequest: () => ({ kind: "reject" }),
      };

      const content = yield* Effect.tryPromise({
        try: async () => {
          try {
            const session = await client.createSession(sessionConfig);
            const response = await session.sendAndWait(
              { prompt, mode: "immediate" },
              COPILOT_THREAD_TITLE_TIMEOUT_MS,
            );
            await session.disconnect();
            return response?.data.content ?? "";
          } finally {
            await client.stop();
          }
        },
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
    });

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
  } satisfies TextGenerationShape;
});
