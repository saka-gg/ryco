/**
 * An agent question and what the user answered: the questions a `user-input.requested`
 * activity asked, paired with the answers its `user-input.resolved` activity recorded. The
 * transcript on every client and the Markdown export read the pair the same way.
 *
 * Pure module.
 */
import type { UserInputQuestion } from "@ryco/contracts/provider-runtime";

export const USER_INPUT_REQUESTED_ACTIVITY_KIND = "user-input.requested";
export const USER_INPUT_RESOLVED_ACTIVITY_KIND = "user-input.resolved";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The questions of a `user-input.requested` payload; null when none is usable. */
export function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0 && payload?.nonBlocking !== true) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

/**
 * One answer as text. Providers report a single string, a list (multi-select), or Codex's
 * `{ answers: [...] }`; blank parts are dropped and the rest joined with commas.
 */
function formatUserInputAnswer(value: unknown): string | null {
  const nested = asRecord(value)?.answers;
  const parts: ReadonlyArray<unknown> =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : Array.isArray(nested)
          ? nested
          : [];
  const text = parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(", ");
  return text.length > 0 ? text : null;
}

/**
 * The fields of a user-input activity that the pairing reads. Answers are already text, so a
 * caller that keeps records (the export) never holds the raw payload.
 */
export type UserInputLifecycleRecord =
  | {
      readonly kind: "requested";
      readonly activityId: string;
      readonly requestId: string;
      /** The request's identity (the node stamps its activity id); answers may name it. */
      readonly requestEventId: string;
      /** Null when the request carried no usable question; it then pairs with nothing. */
      readonly questions: ReadonlyArray<UserInputQuestion> | null;
    }
  | {
      readonly kind: "resolved";
      readonly activityId: string;
      readonly requestId: string;
      /** The request this resolves, when the provider reported it. */
      readonly requestEventId: string | null;
      /** Answer text by the key the provider used: the question's id or its text. */
      readonly answers: Readonly<Record<string, string>>;
      readonly cancelled: boolean;
    };

export function readUserInputLifecycleRecord(activity: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}): UserInputLifecycleRecord | null {
  if (
    activity.kind !== USER_INPUT_REQUESTED_ACTIVITY_KIND &&
    activity.kind !== USER_INPUT_RESOLVED_ACTIVITY_KIND
  ) {
    return null;
  }
  const payload = asRecord(activity.payload);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
  if (!requestId) return null;
  const requestEventId = asRecord(payload?.userInputIdentity)?.requestEventId;
  if (activity.kind === USER_INPUT_REQUESTED_ACTIVITY_KIND) {
    return {
      kind: "requested",
      activityId: activity.id,
      requestId,
      requestEventId: typeof requestEventId === "string" ? requestEventId : activity.id,
      questions: parseUserInputQuestions(payload),
    };
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(payload?.answers) ?? {})) {
    const text = formatUserInputAnswer(value);
    if (text !== null) answers[key] = text;
  }
  return {
    kind: "resolved",
    activityId: activity.id,
    requestId,
    requestEventId: typeof requestEventId === "string" ? requestEventId : null,
    answers,
    cancelled: payload?.cancelled === true,
  };
}

export interface UserInputExchangeQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  /** The option labels the agent offered. */
  readonly options: ReadonlyArray<string>;
  /** Null when this question got no answer. */
  readonly answer: string | null;
}

export interface UserInputExchange {
  /** Cancelled, or resolved without a single answer; the questions stay. */
  readonly cancelled: boolean;
  readonly questions: ReadonlyArray<UserInputExchangeQuestion>;
}

/**
 * Puts each answer under its question. Answers are keyed by question id, except Claude's, which
 * are keyed by the question text.
 */
export function answerUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  resolution: Extract<UserInputLifecycleRecord, { kind: "resolved" }>,
): UserInputExchange {
  // Own keys only: a question id like "constructor" must not read the prototype.
  const answerFor = (key: string) =>
    Object.hasOwn(resolution.answers, key) ? resolution.answers[key] : undefined;
  const answered = questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => option.label),
    answer: answerFor(question.id) ?? answerFor(question.question) ?? null,
  }));
  return {
    cancelled: resolution.cancelled || answered.every((question) => question.answer === null),
    questions: answered,
  };
}

export interface UserInputExchangeMatch<Source> {
  /** What the caller observed with the request. */
  readonly request: Source;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

/**
 * Pairs resolutions with the requests they answer. Feed it every user-input record in activity
 * order; it returns the request for each resolution that answers one. A request id can be
 * reused: a later request replaces an open one with the same id, and an answer that names the
 * replaced request pairs with nothing rather than with the newer question. `Source` is whatever
 * the caller keeps with a request.
 */
export function createUserInputExchangePairing<Source>() {
  const openByRequestId = new Map<
    string,
    {
      readonly requestEventId: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly source: Source;
    }
  >();
  return (
    record: UserInputLifecycleRecord,
    source: Source,
  ): UserInputExchangeMatch<Source> | null => {
    if (record.kind === "requested") {
      // An unreadable replacement must not leave the earlier question to pair with.
      if (record.questions === null) openByRequestId.delete(record.requestId);
      else
        openByRequestId.set(record.requestId, {
          requestEventId: record.requestEventId,
          questions: record.questions,
          source,
        });
      return null;
    }
    const request = openByRequestId.get(record.requestId);
    if (!request) return null;
    if (record.requestEventId !== null && record.requestEventId !== request.requestEventId) {
      return null;
    }
    openByRequestId.delete(record.requestId);
    return { request: request.source, questions: request.questions };
  };
}
