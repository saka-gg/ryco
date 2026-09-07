import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_GOAL_OBJECTIVE_MAX_CHARS = 4_000;

export const ThreadGoalObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_GOAL_OBJECTIVE_MAX_CHARS),
);
export type ThreadGoalObjective = typeof ThreadGoalObjective.Type;

export const ThreadGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoalUpdate = Schema.Struct({
  objective: Schema.optional(ThreadGoalObjective),
  status: Schema.optional(ThreadGoalStatus),
  tokenBudget: Schema.optional(Schema.NullOr(PositiveInt)),
});
export type ThreadGoalUpdate = typeof ThreadGoalUpdate.Type;

const ThreadGoalSynchronizationSchema = Schema.Struct({
  requestId: Schema.String,
  state: Schema.Literals(["pending", "failed", "unsupported"]),
  action: Schema.Literals(["set", "clear"]),
  startTurn: Schema.optional(Schema.Boolean),
  deferUntilTurn: Schema.optional(Schema.Boolean),
  fields: Schema.optional(Schema.Array(Schema.Literals(["objective", "status", "tokenBudget"]))),
  error: Schema.optional(Schema.String),
});

export interface ThreadGoalSynchronization extends Schema.Schema.Type<
  typeof ThreadGoalSynchronizationSchema
> {}

export const ThreadGoalSynchronization: Schema.Codec<ThreadGoalSynchronization> =
  ThreadGoalSynchronizationSchema;

export const ThreadGoal = Schema.Struct({
  objective: ThreadGoalObjective,
  status: ThreadGoalStatus,
  tokenBudget: Schema.NullOr(PositiveInt),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Local delivery state. Absent when the native provider has confirmed the goal. */
  synchronization: Schema.optional(ThreadGoalSynchronization),
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ThreadGoalEventOrigin = Schema.Literals(["client", "provider"]);
export type ThreadGoalEventOrigin = typeof ThreadGoalEventOrigin.Type;
