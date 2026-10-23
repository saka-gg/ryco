/**
 * An agent question the user answered (or that was cancelled), kept in the transcript as the
 * questions and the chosen answers instead of two bare "User input" rows. Derived from the
 * thread's `user-input.requested` / `user-input.resolved` activity pairs; the copy is shared so
 * web and mobile say the same thing.
 */
import type { TurnId } from "@ryco/contracts";
import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";
import {
  answerUserInputQuestions,
  createUserInputExchangePairing,
  readUserInputLifecycleRecord,
  type UserInputExchangeQuestion,
  type UserInputLifecycleRecord,
} from "@ryco/shared/userInputExchange";

import type { TimelineEntry, WorkLogEntry } from "./session-logic.ts";

export type { UserInputExchangeQuestion } from "@ryco/shared/userInputExchange";

export interface UserInputExchangeTimelineEntry {
  id: string;
  /** The `user-input.resolved` activity; the entry sits where the question was answered. */
  activityId: string;
  /** The `user-input.requested` activity that asked the questions. */
  requestActivityId: string;
  createdAt: string;
  turnId: TurnId | null;
  /** Cancelled, or dismissed without an answer; the questions stay. */
  cancelled: boolean;
  questions: ReadonlyArray<UserInputExchangeQuestion>;
}

export const USER_INPUT_EXCHANGE_COPY = {
  answerLabel: "Answer",
  noAnswer: "No answer",
} as const;

export function userInputExchangeCancelledLabel(
  entry: Pick<UserInputExchangeTimelineEntry, "questions">,
): string {
  return entry.questions.length === 1 ? "Question cancelled" : "Questions cancelled";
}

// Store activity records are immutable and reused across derivations. Caching the parsed record
// and the paired entry keeps an exchange's identity (and its rendered row) while other
// activities change.
const recordByActivity = new WeakMap<
  OrchestrationThreadActivity,
  UserInputLifecycleRecord | null
>();
const entryByResolvedActivity = new WeakMap<
  OrchestrationThreadActivity,
  { readonly request: OrchestrationThreadActivity; readonly entry: UserInputExchangeTimelineEntry }
>();

function lifecycleRecord(activity: OrchestrationThreadActivity): UserInputLifecycleRecord | null {
  let record = recordByActivity.get(activity);
  if (record === undefined) {
    record = readUserInputLifecycleRecord(activity);
    recordByActivity.set(activity, record);
  }
  return record;
}

/**
 * Collects exchanges while a derivation walks the thread's activities in order. It sees only the
 * activities the client holds: a question whose activities left the thread's activity window
 * has no exchange.
 */
export function createUserInputExchangeCollector() {
  const pair = createUserInputExchangePairing<OrchestrationThreadActivity>();
  const entries: UserInputExchangeTimelineEntry[] = [];
  return {
    entries,
    observe(activity: OrchestrationThreadActivity): void {
      if (activity.kind !== "user-input.requested" && activity.kind !== "user-input.resolved") {
        return;
      }
      const record = lifecycleRecord(activity);
      if (!record) return;
      const match = pair(record, activity);
      if (!match || record.kind !== "resolved") return;
      const cached = entryByResolvedActivity.get(activity);
      if (cached?.request === match.request) {
        entries.push(cached.entry);
        return;
      }
      const exchange = answerUserInputQuestions(match.questions, record);
      const entry: UserInputExchangeTimelineEntry = {
        id: `user-input:${activity.id}`,
        activityId: activity.id,
        requestActivityId: match.request.id,
        createdAt: activity.createdAt,
        turnId: activity.turnId,
        cancelled: exchange.cancelled,
        questions: exchange.questions,
      };
      entryByResolvedActivity.set(activity, { request: match.request, entry });
      entries.push(entry);
    },
  };
}

type UserInputExchangeTimelineRow = Extract<TimelineEntry, { kind: "user-input-exchange" }>;

export interface UserInputExchangeTimeline {
  /** One timeline entry per exchange, carrying the work rows it stands in for. */
  readonly entries: ReadonlyArray<UserInputExchangeTimelineRow>;
  /** False for an exchange's request or resolution row, which the timeline leaves out. */
  readonly keepsWorkEntry: (entry: Pick<WorkLogEntry, "id">) => boolean;
}

const NO_USER_INPUT_EXCHANGES: UserInputExchangeTimeline = {
  entries: [],
  keepsWorkEntry: () => true,
};
const timelineByExchanges = new WeakMap<
  ReadonlyArray<UserInputExchangeTimelineEntry>,
  {
    readonly workEntries: ReadonlyArray<WorkLogEntry>;
    readonly timeline: UserInputExchangeTimeline;
  }
>();

/**
 * The exchanges' place in the timeline, shared by the timeline index and
 * `deriveTimelineEntries`: each stands in for its request and resolution work rows. Both arrays
 * come from the thread's activity view model, which changes only with its activities, so the
 * timeline updates a streamed reply makes reuse the last result.
 */
export function userInputExchangeTimeline(
  workEntries: ReadonlyArray<WorkLogEntry>,
  exchanges: ReadonlyArray<UserInputExchangeTimelineEntry>,
): UserInputExchangeTimeline {
  if (exchanges.length === 0) return NO_USER_INPUT_EXCHANGES;
  const cached = timelineByExchanges.get(exchanges);
  if (cached?.workEntries === workEntries) return cached.timeline;
  const replacedIds = new Set<string>();
  for (const exchange of exchanges) {
    replacedIds.add(exchange.requestActivityId);
    replacedIds.add(exchange.activityId);
  }
  const replacedRows = new Map<string, WorkLogEntry>();
  for (const entry of workEntries) {
    if (replacedIds.has(entry.id)) replacedRows.set(entry.id, entry);
  }
  const timeline: UserInputExchangeTimeline = {
    entries: exchanges.map((exchange): UserInputExchangeTimelineRow => ({
      id: exchange.id,
      kind: "user-input-exchange",
      createdAt: exchange.createdAt,
      exchange,
      workEntries: [exchange.requestActivityId, exchange.activityId].flatMap((id) => {
        const row = replacedRows.get(id);
        return row ? [row] : [];
      }),
    })),
    keepsWorkEntry: (entry) => !replacedIds.has(entry.id),
  };
  timelineByExchanges.set(exchanges, { workEntries, timeline });
  return timeline;
}
