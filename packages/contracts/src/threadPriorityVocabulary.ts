import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_PRIORITY_REASON_MAX_LENGTH = 160;

export const ThreadPriorityTier = Schema.Literals(["now", "soon", "later", "none"]);
export type ThreadPriorityTier = typeof ThreadPriorityTier.Type;

export const ThreadPriorityConfidence = Schema.Literals(["high", "medium", "low"]);
export type ThreadPriorityConfidence = typeof ThreadPriorityConfidence.Type;

export const ThreadPriorityReason = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_PRIORITY_REASON_MAX_LENGTH),
);
export type ThreadPriorityReason = typeof ThreadPriorityReason.Type;

export const ThreadPriorityCandidateId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("ThreadPriorityCandidateId"),
);
export type ThreadPriorityCandidateId = typeof ThreadPriorityCandidateId.Type;

export const ThreadPriorityBatchId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ThreadPriorityBatchId"),
);
export type ThreadPriorityBatchId = typeof ThreadPriorityBatchId.Type;

export const ThreadPriorityFingerprint = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ThreadPriorityFingerprint"),
);
export type ThreadPriorityFingerprint = typeof ThreadPriorityFingerprint.Type;
