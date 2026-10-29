import { createHash, randomUUID } from "node:crypto";

import {
  ThreadPriorityBatchId,
  ThreadPriorityFingerprint,
  ThreadPriorityRpcError,
  type ServerSettingsError,
  type ModelSelection,
  type ThreadPriorityEnsureCurrentInput,
  type ThreadPriorityEnsureCurrentResult,
  type ThreadPriorityFailureKind,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect";

import { nodeAutoSettleAfterDays } from "../orchestration/threadSettlementInput.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration, type TextGenerationShape } from "../textGeneration/TextGeneration.ts";
import { ThreadPriorityCandidateQuery } from "./ThreadPriorityCandidateQuery.ts";
import {
  ThreadPriorityRepository,
  type ThreadPriorityRepositoryError,
  type ThreadPriorityRepositoryShape,
} from "./ThreadPriorityRepository.ts";
import type { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  buildThreadPriorityChunks,
  THREAD_PRIORITY_PROMPT_POLICY_VERSION,
  type ThreadPriorityCandidateInput,
  type ThreadPriorityPromptCandidate,
} from "./threadPriorityPolicy.ts";

export const THREAD_PRIORITY_MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
export const THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS = 60_000;
export const THREAD_PRIORITY_MANUAL_ABUSE_GUARD_MS = 5_000;

export interface ThreadPriorityCoordinatorShape {
  readonly ensureCurrent: (
    input: ThreadPriorityEnsureCurrentInput,
  ) => Effect.Effect<ThreadPriorityEnsureCurrentResult, ThreadPriorityRpcError>;
  readonly changes: Stream.Stream<void>;
}

export class ThreadPriorityCoordinator extends Context.Service<
  ThreadPriorityCoordinator,
  ThreadPriorityCoordinatorShape
>()("ryco/threadPriority/ThreadPriorityCoordinator") {}

interface ThreadPriorityCoordinatorDependencies {
  readonly listCandidates: Effect.Effect<
    ReadonlyArray<ThreadPriorityCandidateInput>,
    PersistenceSqlError | ServerSettingsError
  >;
  readonly repository: ThreadPriorityRepositoryShape;
  readonly textGeneration: TextGenerationShape;
  readonly getModelSelection: Effect.Effect<ModelSelection, ServerSettingsError>;
  readonly cwd: string;
  readonly nowMs: () => number;
  readonly makeBatchId: () => string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateFingerprint(candidate: ThreadPriorityPromptCandidate): string {
  const { candidateId: _candidateId, ...sentFields } = candidate;
  return fingerprint(sentFields);
}

function failure(kind: ThreadPriorityFailureKind, detail: string): ThreadPriorityRpcError {
  return new ThreadPriorityRpcError({ failure: { kind, detail } });
}

function mapFailure(
  error:
    | ThreadPriorityRpcError
    | ThreadPriorityRepositoryError
    | PersistenceSqlError
    | ServerSettingsError
    | { readonly operation: string; readonly detail?: string },
): ThreadPriorityRpcError {
  if (Schema.is(ThreadPriorityRpcError)(error)) return error;
  if (typeof error === "object" && error !== null && "operation" in error) {
    const detail = "detail" in error ? String(error.detail) : "Provider ranking failed.";
    return failure(
      detail.includes("No provider instance registered")
        ? "provider-unavailable"
        : "provider-failure",
      detail,
    );
  }
  return failure("internal", "Inbox priority ranking could not be completed.");
}

export const makeThreadPriorityCoordinator = Effect.fn("makeThreadPriorityCoordinator")(function* (
  dependencies: ThreadPriorityCoordinatorDependencies,
) {
  const lock = yield* Semaphore.make(1);
  const lastAutomaticAt = yield* Ref.make<number | null>(null);
  const lastManualAt = yield* Ref.make<number | null>(null);
  const changes = yield* PubSub.unbounded<void>();

  const ensureCurrent: ThreadPriorityCoordinatorShape["ensureCurrent"] = (input) => {
    const requestedAt = dependencies.nowMs();
    return lock.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = dependencies.nowMs();
        const now = new Date(nowMs).toISOString();
        const modelSelection = yield* dependencies.getModelSelection;
        const modelFingerprint = ThreadPriorityFingerprint.make(fingerprint(modelSelection));
        const candidates = yield* dependencies.listCandidates;
        const chunks = buildThreadPriorityChunks(candidates, nowMs);
        const candidateFingerprints = new Map<string, string>();
        const threadIdsByCandidateId = new Map<string, string>();
        const fingerprintByThreadId = new Map<string, string>();
        for (const chunk of chunks) {
          for (const candidate of chunk.candidates) {
            candidateFingerprints.set(candidate.candidateId, candidateFingerprint(candidate));
            const threadId = chunk.threadIdsByCandidateId.get(candidate.candidateId);
            if (threadId !== undefined) {
              threadIdsByCandidateId.set(candidate.candidateId, threadId);
              fingerprintByThreadId.set(threadId, candidateFingerprint(candidate));
            }
          }
        }
        const inputFingerprint = fingerprint(
          chunks.flatMap((chunk) =>
            chunk.candidates.map((candidate) => ({
              threadId: threadIdsByCandidateId.get(candidate.candidateId),
              fingerprint: candidateFingerprints.get(candidate.candidateId),
            })),
          ),
        );

        const cached = yield* dependencies.repository.readUsable(now);
        if (Option.isSome(cached)) {
          const snapshot = cached.value.snapshot;
          const current =
            cached.value.inputFingerprint === inputFingerprint &&
            snapshot.modelFingerprint === modelFingerprint &&
            snapshot.promptVersion === THREAD_PRIORITY_PROMPT_POLICY_VERSION;
          const completedAfterRequest = Date.parse(snapshot.freshness.rankedAt) >= requestedAt;
          if (current && (!input.force || completedAfterRequest)) {
            return {
              batchId: snapshot.batchId,
              disposition: "cache-hit" as const,
              freshness: { ...snapshot.freshness, checkedAt: now },
            };
          }
        }

        const lastRequestAt = yield* Ref.get(input.force ? lastManualAt : lastAutomaticAt);
        const minimumInterval = input.force
          ? THREAD_PRIORITY_MANUAL_ABUSE_GUARD_MS
          : THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS;
        if (lastRequestAt !== null && nowMs - lastRequestAt < minimumInterval) {
          return yield* failure(
            "rate-limited",
            input.force
              ? "Manual ranking refresh was requested too recently."
              : "Automatic ranking refresh was requested too recently.",
          );
        }
        yield* Ref.set(input.force ? lastManualAt : lastAutomaticAt, nowMs);

        const rankings = yield* Effect.forEach(
          chunks,
          (chunk) =>
            dependencies.textGeneration.rankInboxThreads({
              cwd: dependencies.cwd,
              chunk,
              modelSelection,
            }),
          { concurrency: 1 },
        ).pipe(Effect.map((results) => results.flatMap((result) => result.rankings)));

        const rankedAt = new Date(dependencies.nowMs()).toISOString();
        const usableUntil = new Date(
          Date.parse(rankedAt) + THREAD_PRIORITY_MAX_CACHE_AGE_MS,
        ).toISOString();
        const snapshot = {
          batchId: ThreadPriorityBatchId.make(dependencies.makeBatchId()),
          modelSelection,
          modelFingerprint,
          promptVersion: THREAD_PRIORITY_PROMPT_POLICY_VERSION,
          freshness: { rankedAt, usableUntil, checkedAt: rankedAt },
          entries: rankings.map((ranking) => ({
            threadId: ranking.threadId,
            tier: ranking.tier,
            confidence: ranking.confidence,
            reason: ranking.reason,
            inputFingerprint: ThreadPriorityFingerprint.make(
              fingerprintByThreadId.get(ranking.threadId) ?? fingerprint(ranking.threadId),
            ),
          })),
        };
        yield* dependencies.repository.replace({ snapshot, inputFingerprint });
        yield* PubSub.publish(changes, undefined);
        return {
          batchId: snapshot.batchId,
          disposition: "ranked" as const,
          freshness: snapshot.freshness,
        };
      }).pipe(Effect.mapError(mapFailure)),
    );
  };
  return {
    ensureCurrent,
    changes: Stream.fromPubSub(changes),
  } satisfies ThreadPriorityCoordinatorShape;
});

export const ThreadPriorityCoordinatorLive = Layer.effect(
  ThreadPriorityCoordinator,
  Effect.gen(function* () {
    const query = yield* ThreadPriorityCandidateQuery;
    const repository = yield* ThreadPriorityRepository;
    const textGeneration = yield* TextGeneration;
    const settings = yield* ServerSettingsService;
    return yield* makeThreadPriorityCoordinator({
      listCandidates: settings.getSettings.pipe(
        Effect.flatMap((current) =>
          query.listActive({
            autoSettleAfterDays: nodeAutoSettleAfterDays(current),
            nowMs: Date.now(),
          }),
        ),
      ),
      repository,
      textGeneration,
      getModelSelection: settings.getSettings.pipe(
        Effect.map(
          (current) => current.inboxPriorityModelSelection ?? current.textGenerationModelSelection,
        ),
      ),
      cwd: process.cwd(),
      nowMs: () => Date.now(),
      makeBatchId: () => `thread-priority-${randomUUID()}`,
    });
  }),
);
