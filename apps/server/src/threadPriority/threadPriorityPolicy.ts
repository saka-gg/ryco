import {
  ThreadPriorityCandidateId,
  ThreadPriorityCandidateRanking,
  type ThreadId,
  type ThreadPriorityConfidence,
  type ThreadPriorityFailureKind,
  type ThreadPriorityReason,
  type ThreadPriorityTier,
} from "@ryco/contracts";
import { Schema } from "effect";

import { buildThreadPriorityPrompt } from "../textGeneration/TextGenerationPrompts.ts";
import { limitUnicode } from "../textGeneration/TextGenerationUtils.ts";

export const THREAD_PRIORITY_PROMPT_POLICY_VERSION = "thread-priority-v1";
export const THREAD_PRIORITY_MAX_CANDIDATES_PER_CHUNK = 40;
export const THREAD_PRIORITY_MAX_PROMPT_CHARS = 48_000;
export const THREAD_PRIORITY_LATEST_REQUEST_MAX_CHARS = 600;

const THREAD_PRIORITY_METADATA_MAX_CHARS = 300;

export const ThreadPriorityAgeBucket = Schema.Literals([
  "under 1 hour",
  "1-6 hours",
  "6-24 hours",
  "1-3 days",
  "3-7 days",
  "over 7 days",
]);
export type ThreadPriorityAgeBucket = typeof ThreadPriorityAgeBucket.Type;

export interface ThreadPriorityCandidateInput {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectName: string | null;
  readonly branchName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activityState: "running" | "stopped" | "idle";
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly queueState: "none" | "queued-turn" | "local-queue";
  readonly hasLatestFailure: boolean;
  readonly deliveryState: "known" | "delivery-unknown";
  readonly pullRequest: ThreadPriorityLinkedItem | null;
  readonly issue: ThreadPriorityLinkedItem | null;
  readonly latestUserRequest: string | null;
}

export interface ThreadPriorityLinkedItem {
  readonly title: string;
  readonly state: string;
}

export interface ThreadPriorityPromptCandidate {
  readonly candidateId: ThreadPriorityCandidateId;
  readonly title: string;
  readonly projectName: string | null;
  readonly branchName: string | null;
  readonly createdAge: ThreadPriorityAgeBucket;
  readonly activityAge: ThreadPriorityAgeBucket;
  readonly activityState: "running" | "stopped" | "idle";
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly queueState: "none" | "queued-turn" | "local-queue";
  readonly hasLatestFailure: boolean;
  readonly deliveryState: "known" | "delivery-unknown";
  readonly pullRequest: ThreadPriorityLinkedItem | null;
  readonly issue: ThreadPriorityLinkedItem | null;
  readonly latestUserRequest: string | null;
}

export interface ThreadPriorityPromptChunk {
  readonly candidates: ReadonlyArray<ThreadPriorityPromptCandidate>;
  readonly threadIdsByCandidateId: ReadonlyMap<ThreadPriorityCandidateId, ThreadId>;
  readonly serializedCandidates: string;
  readonly prompt: string;
}

export interface ValidatedThreadPriorityRanking {
  readonly threadId: ThreadId;
  readonly candidateId: ThreadPriorityCandidateId;
  readonly tier: ThreadPriorityTier;
  readonly confidence: ThreadPriorityConfidence;
  readonly reason: ThreadPriorityReason;
}

export class ThreadPriorityPolicyError extends Error {
  readonly kind: ThreadPriorityFailureKind;
  readonly candidateId: ThreadPriorityCandidateId | undefined;

  constructor(
    kind: ThreadPriorityFailureKind,
    message: string,
    candidateId?: ThreadPriorityCandidateId,
  ) {
    super(message);
    this.name = "ThreadPriorityPolicyError";
    this.kind = kind;
    this.candidateId = candidateId;
  }
}

function boundedMetadata(value: string): string {
  return limitUnicode(value.trim(), THREAD_PRIORITY_METADATA_MAX_CHARS);
}

function boundedLinkedItem(
  value: ThreadPriorityLinkedItem | null,
): ThreadPriorityLinkedItem | null {
  return value === null
    ? null
    : {
        title: boundedMetadata(value.title),
        state: boundedMetadata(value.state),
      };
}

export function threadPriorityAgeBucket(timestamp: string, nowMs: number): ThreadPriorityAgeBucket {
  const timestampMs = Date.parse(timestamp);
  const ageMs = Number.isFinite(timestampMs) ? Math.max(0, nowMs - timestampMs) : 0;
  const hour = 60 * 60 * 1_000;
  const day = 24 * hour;
  if (ageMs < hour) return "under 1 hour";
  if (ageMs < 6 * hour) return "1-6 hours";
  if (ageMs < day) return "6-24 hours";
  if (ageMs < 3 * day) return "1-3 days";
  if (ageMs < 7 * day) return "3-7 days";
  return "over 7 days";
}

function candidateIdForIndex(index: number): ThreadPriorityCandidateId {
  return ThreadPriorityCandidateId.make(`candidate-${(index + 1).toString(36).padStart(4, "0")}`);
}

export function normalizeThreadPriorityCandidate(
  input: ThreadPriorityCandidateInput,
  candidateId: ThreadPriorityCandidateId,
  nowMs: number,
): ThreadPriorityPromptCandidate {
  return {
    candidateId,
    title: boundedMetadata(input.title),
    projectName: input.projectName === null ? null : boundedMetadata(input.projectName),
    branchName: input.branchName === null ? null : boundedMetadata(input.branchName),
    createdAge: threadPriorityAgeBucket(input.createdAt, nowMs),
    activityAge: threadPriorityAgeBucket(input.updatedAt, nowMs),
    activityState: input.activityState,
    hasPendingApproval: input.hasPendingApproval,
    hasPendingUserInput: input.hasPendingUserInput,
    queueState: input.queueState,
    hasLatestFailure: input.hasLatestFailure,
    deliveryState: input.deliveryState,
    pullRequest: boundedLinkedItem(input.pullRequest),
    issue: boundedLinkedItem(input.issue),
    latestUserRequest:
      input.latestUserRequest === null
        ? null
        : limitUnicode(input.latestUserRequest, THREAD_PRIORITY_LATEST_REQUEST_MAX_CHARS),
  };
}

export function serializeThreadPriorityCandidates(
  candidates: ReadonlyArray<ThreadPriorityPromptCandidate>,
): string {
  return JSON.stringify({ policyVersion: THREAD_PRIORITY_PROMPT_POLICY_VERSION, candidates });
}

function makeChunk(
  entries: ReadonlyArray<{
    readonly candidate: ThreadPriorityPromptCandidate;
    readonly threadId: ThreadId;
  }>,
): ThreadPriorityPromptChunk {
  const candidates = entries.map((entry) => entry.candidate);
  const serializedCandidates = serializeThreadPriorityCandidates(candidates);
  const prompt = buildThreadPriorityPrompt({ serializedCandidates }).prompt;
  return {
    candidates,
    threadIdsByCandidateId: new Map(
      entries.map((entry) => [entry.candidate.candidateId, entry.threadId] as const),
    ),
    serializedCandidates,
    prompt,
  };
}

export function buildThreadPriorityChunks(
  inputs: ReadonlyArray<ThreadPriorityCandidateInput>,
  nowMs: number,
): ReadonlyArray<ThreadPriorityPromptChunk> {
  const normalized = inputs.map((input, index) => ({
    candidate: normalizeThreadPriorityCandidate(input, candidateIdForIndex(index), nowMs),
    threadId: input.threadId,
  }));
  const chunks: Array<ThreadPriorityPromptChunk> = [];
  let pending: typeof normalized = [];

  for (const entry of normalized) {
    const proposed = [...pending, entry];
    const proposedChunk = makeChunk(proposed);
    if (
      pending.length > 0 &&
      (proposed.length > THREAD_PRIORITY_MAX_CANDIDATES_PER_CHUNK ||
        proposedChunk.prompt.length > THREAD_PRIORITY_MAX_PROMPT_CHARS)
    ) {
      chunks.push(makeChunk(pending));
      pending = [entry];
      continue;
    }
    if (proposedChunk.prompt.length > THREAD_PRIORITY_MAX_PROMPT_CHARS) {
      throw new ThreadPriorityPolicyError(
        "internal",
        "A single normalized ranking candidate exceeds the prompt budget.",
        entry.candidate.candidateId,
      );
    }
    pending = proposed;
  }

  if (pending.length > 0) chunks.push(makeChunk(pending));
  return chunks;
}

export function validateThreadPriorityRankings(
  raw: unknown,
  chunk: ThreadPriorityPromptChunk,
): ReadonlyArray<ValidatedThreadPriorityRanking> {
  let rankings: ReadonlyArray<ThreadPriorityCandidateRanking>;
  try {
    rankings = Schema.decodeUnknownSync(Schema.Array(ThreadPriorityCandidateRanking))(raw);
  } catch (error) {
    throw new ThreadPriorityPolicyError(
      "malformed-response",
      error instanceof Error ? error.message : "Ranking response failed schema validation.",
    );
  }

  const seen = new Set<ThreadPriorityCandidateId>();
  return rankings.map((ranking) => {
    if (seen.has(ranking.candidateId)) {
      throw new ThreadPriorityPolicyError(
        "duplicate-candidate-id",
        "Ranking response contains a duplicate candidate identifier.",
        ranking.candidateId,
      );
    }
    seen.add(ranking.candidateId);
    const threadId = chunk.threadIdsByCandidateId.get(ranking.candidateId);
    if (threadId === undefined) {
      throw new ThreadPriorityPolicyError(
        "unknown-candidate-id",
        "Ranking response contains a candidate identifier that was not requested.",
        ranking.candidateId,
      );
    }
    return {
      threadId,
      candidateId: ranking.candidateId,
      tier: ranking.tier,
      confidence: ranking.confidence,
      reason: ranking.reason,
    };
  });
}
