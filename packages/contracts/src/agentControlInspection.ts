import { Schema } from "effect";
import {
  ProjectId,
  ThreadId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationThreadHistoryCursor } from "./orchestration.ts";

export const AgentControlReadProjectInput = Schema.Struct({ projectId: ProjectId });
export const AgentControlInspectThreadInput = Schema.Struct({
  threadId: ThreadId,
  section: Schema.Literals(["info", "agents", "activities", "plans", "review", "terminals"]),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  cursor: Schema.optional(OrchestrationThreadHistoryCursor),
});
export const AgentControlWaitThreadsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  timeoutMs: Schema.optional(NonNegativeInt),
});

export const AgentControlSearchThreadsInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export const AgentControlReadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export const AgentControlReadThreadFileInput = Schema.Struct({
  threadId: ThreadId,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
