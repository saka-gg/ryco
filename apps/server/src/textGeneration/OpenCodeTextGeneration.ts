import { Effect, Schema } from "effect";

import {
  TextGenerationError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@ryco/contracts";
import {
  appendAttachmentPathLines,
  formatAttachmentPathLines,
  type AttachmentPathLineEntry,
} from "@ryco/shared/attachmentPrompt";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@ryco/shared/git";
import { getModelSelectionStringOptionValue } from "@ryco/shared/model";

import { ServerConfig } from "../config.ts";
import { readPersistedAttachment, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildIssueContentPolishPrompt,
  buildIssueContentTitlePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildThreadPriorityPrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape, validateRankInboxThreadsResult } from "./TextGeneration.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  OpenCodeRuntime,
  type OpenCodeServerConnection,
  isOpenCodeNativeAttachment,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
  verifyOpenCodeServerVersion,
} from "../provider/opencodeRuntime.ts";
import {
  makeOpenCodeServerOwner,
  type OpenCodeServerOwner,
} from "../provider/OpenCodeServerOwner.ts";

function getOpenCodePromptErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return message;
  }

  if ("name" in error && typeof error.name === "string") {
    const name = error.name.trim();
    return name.length > 0 ? name : null;
  }

  return null;
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      if (!("type" in part) || part.type !== "text") {
        return [];
      }
      if (!("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("")
    .trim();
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly serverOwner?: OpenCodeServerOwner },
) {
  const serverConfig = yield* ServerConfig;
  const openCodeRuntime = yield* OpenCodeRuntime;
  const serverOwner =
    options?.serverOwner ??
    (openCodeSettings.serverUrl.trim().length === 0
      ? yield* makeOpenCodeServerOwner(openCodeSettings, environment)
      : undefined);

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateIssueContent"
      | "rankInboxThreads";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const parsedModel = parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }

    const declaredAttachmentBytes = (input.attachments ?? []).reduce(
      (total, attachment) => total + (attachment.sizeBytes ?? 0),
      0,
    );
    if (declaredAttachmentBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: `Attachments total ${declaredAttachmentBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
      });
    }
    const attachmentUrlById = new Map<string, string>();
    let attachmentTotalBytes = 0;
    const pathLineEntries: AttachmentPathLineEntry[] = [];
    for (const attachment of input.attachments ?? []) {
      if (!isOpenCodeNativeAttachment(attachment)) {
        pathLineEntries.push({
          attachment,
          ...(attachment.id === undefined
            ? {}
            : {
                resolvedPath:
                  resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment,
                  }) ?? undefined,
              }),
        });
        continue;
      }
      if (attachment.id === undefined) {
        continue;
      }
      const persisted = readPersistedAttachment({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!persisted.ok) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: persisted.reason,
        });
      }
      attachmentTotalBytes += persisted.sizeBytes;
      if (attachmentTotalBytes > PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: `Attachments total ${attachmentTotalBytes} bytes; limit is ${PROVIDER_SEND_TURN_MAX_ATTACHMENT_TOTAL_BYTES} bytes.`,
        });
      }
      attachmentUrlById.set(
        attachment.id,
        `data:${attachment.mimeType};base64,${persisted.bytes.toString("base64")}`,
      );
    }
    const fileParts = toOpenCodeFileParts({
      attachments: input.attachments,
      resolveAttachmentUrl: (attachment) =>
        attachment.id === undefined ? null : (attachmentUrlById.get(attachment.id) ?? null),
    });
    const promptWithAttachmentLines = appendAttachmentPathLines(
      input.prompt,
      formatAttachmentPathLines(pathLineEntries),
    );
    const finalPrompt = promptWithAttachmentLines ?? input.prompt;

    const runAgainstServer = (server: Pick<OpenCodeServerConnection, "url" | "serverPassword">) =>
      Effect.gen(function* () {
        const client = yield* openCodeRuntime
          .createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: input.cwd,
            ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: openCodeRuntimeErrorDetail(cause),
                  cause,
                }),
            ),
          );
        yield* verifyOpenCodeServerVersion(client).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ),
        );
        return yield* Effect.tryPromise({
          try: async () => {
            const session = await client.session.create({
              title: `Ryco ${input.operation}`,
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            });
            if (!session.data) {
              throw new Error("OpenCode session.create returned no session payload.");
            }
            const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
            const selectedVariant = getModelSelectionStringOptionValue(
              input.modelSelection,
              "variant",
            );

            const result = await client.session.prompt({
              sessionID: session.data.id,
              model: parsedModel,
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
              parts: [{ type: "text", text: finalPrompt }, ...fileParts],
            });
            const info = result.data?.info;
            const errorMessage = getOpenCodePromptErrorMessage(info?.error);
            if (errorMessage) {
              throw new Error(errorMessage);
            }
            const rawText = getOpenCodeTextResponse(result.data?.parts);
            if (rawText.length === 0) {
              throw new Error("OpenCode returned empty output.");
            }
            return rawText;
          },
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            }),
        });
      });

    const rawOutput =
      openCodeSettings.serverUrl.length > 0
        ? yield* runAgainstServer({
            url: openCodeSettings.serverUrl,
            ...(openCodeSettings.serverPassword
              ? { serverPassword: openCodeSettings.serverPassword }
              : {}),
          })
        : yield* Effect.scoped(
            serverOwner!.acquire.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail: openCodeRuntimeErrorDetail(cause),
                    cause,
                  }),
              ),
              Effect.flatMap(runAgainstServer),
            ),
          );

    return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
      extractJsonObject(rawOutput),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OpenCodeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runOpenCodeJson({
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
    "OpenCodeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runOpenCodeJson({
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
    "OpenCodeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OpenCodeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runOpenCodeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  const generateIssueContent: TextGenerationShape["generateIssueContent"] = Effect.fn(
    "OpenCodeTextGeneration.generateIssueContent",
  )(function* (input) {
    if (input.mode === "polish") {
      const { prompt, outputSchema } = buildIssueContentPolishPrompt({
        rough: input.rough ?? "",
        ...(input.currentTitle ? { currentTitle: input.currentTitle } : {}),
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
      });
      const decoded = yield* runOpenCodeJson({
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
      const decoded = yield* runOpenCodeJson({
        operation: "generateIssueContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: decoded.title.trim() };
    }
  });

  // A remote or managed OpenCode server can load configured plugins before session
  // permissions take effect. A deny-all session alone is not sufficient isolation.
  const answerSideQuestion: TextGenerationShape["answerSideQuestion"] = () =>
    Effect.fail(
      new TextGenerationError({
        operation: "answerSideQuestion",
        detail:
          "OpenCode cannot isolate configured server plugins for a tool-free side question. Select Codex, Claude, or GitHub Copilot for side chat.",
      }),
    );

  const rankInboxThreads: TextGenerationShape["rankInboxThreads"] = Effect.fn(
    "OpenCodeTextGeneration.rankInboxThreads",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadPriorityPrompt({
      serializedCandidates: input.chunk.serializedCandidates,
    });
    const generated = yield* runOpenCodeJson({
      operation: "rankInboxThreads",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
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
