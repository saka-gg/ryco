import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { UsageCalendarDate } from "./usage.ts";

export const DailyRecapRequest = Schema.Struct({
  date: UsageCalendarDate,
  timeZone: TrimmedNonEmptyString,
  /** Maximum threads in each section; defaults to 20. Counts remain complete. */
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type DailyRecapRequest = typeof DailyRecapRequest.Type;

export const DailyRecapThread = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  lastActivityAt: IsoDateTime,
});
export type DailyRecapThread = typeof DailyRecapThread.Type;

export const DailyRecapAttentionThread = Schema.Struct({
  ...DailyRecapThread.fields,
  pendingApprovals: NonNegativeInt,
  pendingUserInputs: NonNegativeInt,
  hasProposedPlan: Schema.Boolean,
  sessionError: Schema.Boolean,
});

export const DailyRecapThreadSection = Schema.Struct({
  totalThreads: NonNegativeInt,
  threads: Schema.Array(DailyRecapThread),
  truncated: Schema.Boolean,
});

export const DailyRecapSnapshot = Schema.Struct({
  date: UsageCalendarDate,
  timeZone: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  /** Exact UTC interval for the selected local calendar day; end is exclusive. */
  from: IsoDateTime,
  to: IsoDateTime,
  /** Ryco turn outcomes in this day, excluding deleted threads and projects. */
  counts: Schema.Struct({
    completedTurns: NonNegativeInt,
    failedTurns: NonNegativeInt,
    interruptedTurns: NonNegativeInt,
  }),
  /** Sections are independent: a thread may have both successful and failed turns. */
  completed: DailyRecapThreadSection,
  failed: DailyRecapThreadSection,
  /** Current outstanding attention, regardless of the selected day; excludes archived threads. */
  needsAttention: Schema.Struct({
    totalThreads: NonNegativeInt,
    threads: Schema.Array(DailyRecapAttentionThread),
    truncated: Schema.Boolean,
  }),
});
export type DailyRecapSnapshot = typeof DailyRecapSnapshot.Type;

export class DailyRecapReadError extends Schema.TaggedError<DailyRecapReadError>()(
  "DailyRecapReadError",
  {
    reason: Schema.Literals(["invalid-date", "invalid-time-zone", "query-failed"]),
    detail: TrimmedNonEmptyString,
  },
) {}
