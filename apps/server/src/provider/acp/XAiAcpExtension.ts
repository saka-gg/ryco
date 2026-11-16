import type { ProviderUserInputAnswers, UserInputQuestion } from "@ryco/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const XAiPromptCompleteNotification = Schema.Struct({
  sessionId: Schema.String,
  promptId: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  agentResult: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

type XAiPromptCompleteNotification = typeof XAiPromptCompleteNotification.Type;

interface XAiPromptCompletionRegistration {
  readonly sessionId: string;
  readonly promptId: string;
  readonly responsePromptId?: string;
  readonly deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>;
  readonly state: "pending" | "settled";
}

interface XAiPromptCompletionState {
  readonly registrations: ReadonlyArray<XAiPromptCompletionRegistration>;
  readonly compactedSettledBySession: ReadonlyMap<string, number>;
}

const defaultXAiPromptCompletionHistoryLimit = 128;

export interface XAiPromptCompletionRuntimeOptions {
  readonly completionHistoryLimit?: number;
}

const XAiAskUserQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const XAiAskUserQuestion = Schema.Struct({
  id: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(XAiAskUserQuestionOption),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const XAiAskUserQuestionParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(XAiAskUserQuestion),
  mode: Schema.Literals(["default", "plan"]),
});

const XAiWrappedAskUserQuestionParams = Schema.Struct({
  method: Schema.Literals(["x.ai/ask_user_question", "_x.ai/ask_user_question"]),
  params: XAiAskUserQuestionParams,
});

export const XAiAskUserQuestionRequest = Schema.Union([
  XAiAskUserQuestionParams,
  XAiWrappedAskUserQuestionParams,
]);

type XAiAskUserQuestionRequestParams = typeof XAiAskUserQuestionParams.Type;
type XAiAskUserQuestionRequest = typeof XAiAskUserQuestionRequest.Type;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function unwrapAskUserQuestionParams(
  params: XAiAskUserQuestionRequest,
): XAiAskUserQuestionRequestParams {
  return "params" in params ? params.params : params;
}

export function extractXAiAskUserQuestions(
  params: XAiAskUserQuestionRequest,
): ReadonlyArray<UserInputQuestion> {
  return unwrapAskUserQuestionParams(params).questions.map((question) => ({
    id: question.id ?? question.question,
    header: "Question",
    question: question.question,
    multiSelect: question.multiSelect === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

interface XAiAskUserQuestionAnnotation {
  readonly preview?: string;
  readonly notes?: string;
}

interface XAiAskUserQuestionAcceptedResponse {
  readonly outcome: "accepted";
  readonly answers: Record<string, ReadonlyArray<string>>;
  readonly annotations?: Record<string, XAiAskUserQuestionAnnotation>;
}

interface XAiAskUserQuestionCancelledResponse {
  readonly outcome: "cancelled";
}

export type XAiAskUserQuestionResponse =
  | XAiAskUserQuestionAcceptedResponse
  | XAiAskUserQuestionCancelledResponse;

interface NormalizedXAiAnswer {
  readonly questionText: string;
  readonly selectedLabels: ReadonlyArray<string>;
  readonly annotation?: XAiAskUserQuestionAnnotation;
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const text = typeof entry === "string" ? trimmed(entry) : undefined;
      return text ? [text] : [];
    });
  }
  const text = typeof answer === "string" ? trimmed(answer) : undefined;
  return text ? [text] : [];
}

function normalizeAnswerForXAi(
  question: XAiAskUserQuestionRequestParams["questions"][number],
  answer: unknown,
): NormalizedXAiAnswer | undefined {
  const values = answerValues(answer);
  if (values.length === 0) {
    return undefined;
  }

  const optionByLabel = new Map(question.options.map((option) => [option.label, option]));
  const resolvedValues = values.map((value) => ({
    value,
    option: optionByLabel.get(value),
  }));
  const selectedLabels = resolvedValues.flatMap(({ option }) => (option ? [option.label] : []));
  const notes = resolvedValues.flatMap(({ option, value }) => (option ? [] : [value]));
  const preview =
    question.multiSelect === true
      ? undefined
      : resolvedValues.map(({ option }) => trimmed(option?.preview)).find((value) => value);

  const annotation =
    preview || notes.length > 0
      ? {
          ...(preview ? { preview } : {}),
          ...(notes.length > 0 ? { notes: notes.join("\n") } : {}),
        }
      : undefined;

  return {
    questionText: question.question,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : ["Other"],
    ...(annotation ? { annotation } : {}),
  };
}

function findQuestionAnswer(
  answers: ProviderUserInputAnswers,
  question: XAiAskUserQuestionRequestParams["questions"][number],
): unknown {
  const key = question.id ?? question.question;
  return answers[key] ?? answers[question.question];
}

export function makeXAiAskUserQuestionResponse(
  params: XAiAskUserQuestionRequest,
  answers: ProviderUserInputAnswers,
): XAiAskUserQuestionAcceptedResponse {
  const questions = unwrapAskUserQuestionParams(params).questions;
  const normalized = questions.flatMap((question) => {
    const entry = normalizeAnswerForXAi(question, findQuestionAnswer(answers, question));
    return entry ? [entry] : [];
  });
  const annotations = Object.fromEntries(
    normalized.flatMap((entry) =>
      entry.annotation ? [[entry.questionText, entry.annotation] as const] : [],
    ),
  );

  return {
    outcome: "accepted",
    answers: Object.fromEntries(
      normalized.map((entry) => [entry.questionText, entry.selectedLabels]),
    ),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

export function makeXAiAskUserQuestionCancelledResponse(): XAiAskUserQuestionCancelledResponse {
  return { outcome: "cancelled" };
}

/**
 * Adds Grok's private prompt-completion fallback around a standards-only ACP runtime.
 * The underlying runtime remains unaware of xAI methods and metadata.
 */
export const makeXAiPromptCompletionRuntime = Effect.fn("makeXAiPromptCompletionRuntime")(
  function* (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    options?: XAiPromptCompletionRuntimeOptions,
  ) {
    const requestedCompletionHistoryLimit =
      options?.completionHistoryLimit ?? defaultXAiPromptCompletionHistoryLimit;
    const completionHistoryLimit =
      Number.isSafeInteger(requestedCompletionHistoryLimit) && requestedCompletionHistoryLimit > 0
        ? requestedCompletionHistoryLimit
        : defaultXAiPromptCompletionHistoryLimit;
    const activeSessionIdRef = yield* Ref.make<string | undefined>(undefined);
    const completionStateRef = yield* Ref.make<XAiPromptCompletionState>({
      registrations: [],
      compactedSettledBySession: new Map(),
    });
    const completedPromptIdsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    let nextPromptFallbackId = 0;
    const allocatePromptFallbackId = Effect.sync(() => {
      nextPromptFallbackId += 1;
      return `ryco-xai-prompt-${nextPromptFallbackId}`;
    });

    yield* runtime.handleExtNotification(
      "_x.ai/session/prompt_complete",
      XAiPromptCompleteNotification,
      (notification) =>
        resolveXAiPromptCompletionFallback({
          completionStateRef,
          completedPromptIdsRef,
          notification,
        }),
    );

    return {
      ...runtime,
      start: () =>
        runtime
          .start()
          .pipe(Effect.tap((started) => Ref.set(activeSessionIdRef, started.sessionId))),
      prompt: (payload) =>
        Effect.gen(function* () {
          const sessionId = yield* Ref.get(activeSessionIdRef);
          if (sessionId === undefined) {
            return yield* runtime.prompt(payload);
          }

          const promptId = yield* allocatePromptFallbackId;
          const fallback = yield* registerXAiPromptCompletionFallback(
            completionStateRef,
            sessionId,
            promptId,
            completionHistoryLimit,
          );
          const requestPayload = {
            ...payload,
            _meta: {
              ...payload._meta,
              promptId: fallback.promptId,
              requestId: fallback.promptId,
            },
          } satisfies Omit<EffectAcpSchema.PromptRequest, "sessionId">;

          return yield* Effect.raceFirst(
            runtime
              .prompt(requestPayload)
              .pipe(Effect.map((response) => ({ source: "standard", response }) as const)),
            Deferred.await(fallback.deferred).pipe(
              Effect.map((response) => ({ source: "extension", response }) as const),
            ),
          ).pipe(
            Effect.tap(({ source, response }) =>
              rememberCompletedXAiPromptIds(
                completedPromptIdsRef,
                response,
                fallback.promptId,
                completionHistoryLimit,
              ).pipe(
                Effect.andThen(
                  source === "standard"
                    ? settleXAiPromptCompletionFallback(
                        completionStateRef,
                        fallback.deferred,
                        response,
                        completionHistoryLimit,
                      )
                    : unregisterXAiPromptCompletionFallback(completionStateRef, fallback.deferred),
                ),
              ),
            ),
            Effect.map(({ response }) => response),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : unregisterXAiPromptCompletionFallback(completionStateRef, fallback.deferred),
            ),
          );
        }),
      cancel: Ref.get(activeSessionIdRef).pipe(
        Effect.flatMap((sessionId) =>
          sessionId === undefined
            ? runtime.cancel
            : abortPendingPromptCompletions(completionStateRef, sessionId).pipe(
                Effect.andThen(runtime.cancel),
              ),
        ),
      ),
    } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
  },
);

const registerXAiPromptCompletionFallback = (
  completionStateRef: Ref.Ref<XAiPromptCompletionState>,
  sessionId: string,
  promptId: string,
  completionHistoryLimit: number,
) =>
  Deferred.make<EffectAcpSchema.PromptResponse>().pipe(
    Effect.tap((deferred) =>
      Ref.update(completionStateRef, (state) =>
        trimSettledXAiPromptCompletions(
          {
            ...state,
            registrations: [
              ...state.registrations,
              { sessionId, promptId, deferred, state: "pending" },
            ],
          },
          completionHistoryLimit,
        ),
      ),
    ),
    Effect.map((deferred) => ({ deferred, promptId })),
  );

const trimSettledXAiPromptCompletions = (
  state: XAiPromptCompletionState,
  completionHistoryLimit: number,
): XAiPromptCompletionState => {
  let settledToDrop = Math.max(
    0,
    state.registrations.filter((entry) => entry.state === "settled").length -
      completionHistoryLimit,
  );
  if (settledToDrop === 0) {
    return state;
  }
  const compactedSettledBySession = new Map(state.compactedSettledBySession);
  const registrations = state.registrations.filter((entry) => {
    if (entry.state === "pending" || settledToDrop === 0) {
      return true;
    }
    settledToDrop -= 1;
    compactedSettledBySession.set(
      entry.sessionId,
      (compactedSettledBySession.get(entry.sessionId) ?? 0) + 1,
    );
    return false;
  });
  return { registrations, compactedSettledBySession };
};

const settleXAiPromptCompletionFallback = (
  completionStateRef: Ref.Ref<XAiPromptCompletionState>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>,
  response: EffectAcpSchema.PromptResponse,
  completionHistoryLimit: number,
) =>
  Ref.update(completionStateRef, (state) =>
    trimSettledXAiPromptCompletions(
      {
        ...state,
        registrations: state.registrations.map((entry) => {
          if (entry.deferred !== deferred) {
            return entry;
          }
          const responsePromptId = promptIdFromResponse(response);
          return {
            ...entry,
            state: "settled" as const,
            ...(responsePromptId ? { responsePromptId } : {}),
          };
        }),
      },
      completionHistoryLimit,
    ),
  );

const unregisterXAiPromptCompletionFallback = (
  completionStateRef: Ref.Ref<XAiPromptCompletionState>,
  deferred: Deferred.Deferred<EffectAcpSchema.PromptResponse>,
) =>
  Ref.update(completionStateRef, (state) => ({
    ...state,
    registrations: state.registrations.filter((entry) => entry.deferred !== deferred),
  }));

const abortPendingPromptCompletions = (
  completionStateRef: Ref.Ref<XAiPromptCompletionState>,
  sessionId: string,
) =>
  Ref.modify(completionStateRef, (state) => {
    const [toAbort, remaining] = state.registrations.reduce<
      [
        ReadonlyArray<XAiPromptCompletionRegistration>,
        ReadonlyArray<XAiPromptCompletionRegistration>,
      ]
    >(
      ([aborting, kept], entry) =>
        entry.sessionId === sessionId ? [[...aborting, entry], kept] : [aborting, [...kept, entry]],
      [[], []],
    );
    const compactedSettledBySession = new Map(state.compactedSettledBySession);
    const hadCompactedSettled = compactedSettledBySession.delete(sessionId);
    if (toAbort.length === 0) {
      return [
        Effect.void,
        hadCompactedSettled ? { ...state, compactedSettledBySession } : state,
      ] as const;
    }
    return [
      Effect.forEach(
        toAbort,
        (entry) =>
          Deferred.succeed(
            entry.deferred,
            promptResponseFromXAi({
              sessionId: entry.sessionId,
              promptId: entry.promptId,
              stopReason: "cancelled",
              agentResult: null,
            }),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
      { registrations: remaining, compactedSettledBySession },
    ] as const;
  }).pipe(Effect.flatten);

const resolveXAiPromptCompletionFallback = ({
  completionStateRef,
  completedPromptIdsRef,
  notification,
}: {
  readonly completionStateRef: Ref.Ref<XAiPromptCompletionState>;
  readonly completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>;
  readonly notification: XAiPromptCompleteNotification;
}) =>
  Ref.get(completedPromptIdsRef).pipe(
    Effect.flatMap((completedPromptIds) => {
      return Ref.modify(completionStateRef, (state) => {
        if (notification.promptId === undefined) {
          const compactedCount = state.compactedSettledBySession.get(notification.sessionId) ?? 0;
          if (compactedCount > 0) {
            const compactedSettledBySession = new Map(state.compactedSettledBySession);
            if (compactedCount === 1) {
              compactedSettledBySession.delete(notification.sessionId);
            } else {
              compactedSettledBySession.set(notification.sessionId, compactedCount - 1);
            }
            return [Effect.void, { ...state, compactedSettledBySession }] as const;
          }
        }

        const index =
          notification.promptId !== undefined
            ? state.registrations.findIndex(
                (entry) =>
                  entry.sessionId === notification.sessionId &&
                  (entry.promptId === notification.promptId ||
                    entry.responsePromptId === notification.promptId),
              )
            : state.registrations.findIndex((entry) => entry.sessionId === notification.sessionId);
        if (index < 0) {
          return [Effect.void, state] as const;
        }
        const entry = state.registrations[index];
        if (!entry) {
          return [Effect.void, state] as const;
        }
        const shouldDiscard =
          entry.state === "settled" ||
          (notification.promptId !== undefined &&
            completedPromptIds.includes(notification.promptId));
        return [
          shouldDiscard
            ? Effect.void
            : (isXAiStopReason(notification.stopReason)
                ? Effect.void
                : Effect.logWarning("xai.prompt-complete.stop-reason-unrecognized", {
                    sessionId: notification.sessionId,
                    stopReason: notification.stopReason ?? "missing",
                  })
              ).pipe(
                Effect.andThen(
                  Deferred.succeed(entry.deferred, promptResponseFromXAi(notification)),
                ),
                Effect.asVoid,
              ),
          {
            ...state,
            registrations: [
              ...state.registrations.slice(0, index),
              ...state.registrations.slice(index + 1),
            ],
          },
        ] as const;
      }).pipe(Effect.flatten);
    }),
  );

const rememberCompletedXAiPromptIds = (
  completedPromptIdsRef: Ref.Ref<ReadonlyArray<string>>,
  response: EffectAcpSchema.PromptResponse,
  fallbackPromptId: string,
  completionHistoryLimit: number,
) => {
  const responsePromptId = promptIdFromResponse(response);
  const promptIds =
    responsePromptId === undefined || responsePromptId === fallbackPromptId
      ? [fallbackPromptId]
      : [fallbackPromptId, responsePromptId];
  return Ref.update(completedPromptIdsRef, (completedPromptIds) => {
    const next = [...new Set([...completedPromptIds, ...promptIds])];
    return next.slice(-completionHistoryLimit);
  });
};

function promptIdFromResponse(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = response._meta;
  if (meta === null || typeof meta !== "object") {
    return undefined;
  }
  const promptId = meta.promptId ?? meta.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function promptResponseFromXAi(
  notification: XAiPromptCompleteNotification,
): EffectAcpSchema.PromptResponse {
  const stopReason = normalizeXAiStopReason(notification.stopReason);
  const meta: Record<string, unknown> = {
    sessionId: notification.sessionId,
  };
  if (notification.promptId !== undefined) {
    meta.promptId = notification.promptId;
    meta.requestId = notification.promptId;
  }
  if (notification.agentResult !== undefined) {
    meta.agentResult = notification.agentResult;
  }
  return {
    stopReason,
    _meta: meta,
  };
}

function isXAiStopReason(value: string | undefined): value is EffectAcpSchema.StopReason {
  return (
    value === "cancelled" ||
    value === "end_turn" ||
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal"
  );
}

function normalizeXAiStopReason(value: string | undefined): EffectAcpSchema.StopReason {
  return isXAiStopReason(value) ? value : "end_turn";
}
