import {
  ProviderInstanceId,
  ThreadId,
  ThreadPriorityCandidateId,
  ThreadPriorityReason,
  ThreadPriorityRpcError,
  TextGenerationError,
  type ModelSelection,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Result } from "effect";

import type { TextGenerationShape } from "../textGeneration/TextGeneration.ts";
import type {
  ThreadPriorityRepositoryShape,
  ThreadPriorityStoredBatch,
} from "./ThreadPriorityRepository.ts";
import {
  makeThreadPriorityCoordinator,
  THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS,
  THREAD_PRIORITY_MAX_CACHE_AGE_MS,
} from "./ThreadPriorityCoordinator.ts";
import type { ThreadPriorityCandidateInput } from "./threadPriorityPolicy.ts";

const baseNow = Date.parse("2026-08-25T12:00:00.000Z");

function makeCandidate(index: number): ThreadPriorityCandidateInput {
  return {
    threadId: ThreadId.make(`priority-thread-${index}`),
    title: `Repair item ${index}`,
    projectName: "Ryco",
    branchName: "main",
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T11:30:00.000Z",
    activityState: "idle",
    hasPendingApproval: false,
    hasPendingUserInput: false,
    queueState: "none",
    hasLatestFailure: false,
    deliveryState: "known",
    pullRequest: null,
    issue: null,
    latestUserRequest: `Please repair item ${index}`,
  };
}

const unused = () => Effect.die("unused text-generation operation");

function makeHarness(options: {
  readonly candidates?: ThreadPriorityCandidateInput[];
  readonly rank?: TextGenerationShape["rankInboxThreads"];
}) {
  let nowMs = baseNow;
  let candidates = options.candidates ?? [makeCandidate(1)];
  let stored: ThreadPriorityStoredBatch | null = null;
  let replaceCount = 0;
  let providerCalls = 0;
  let modelSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const repository: ThreadPriorityRepositoryShape = {
    readLatest: () => Effect.succeed(Option.fromNullishOr(stored)),
    readUsable: (now) =>
      Effect.succeed(
        stored !== null && Date.parse(stored.snapshot.freshness.usableUntil) > Date.parse(now)
          ? Option.some(stored)
          : Option.none(),
      ),
    replace: (batch) =>
      Effect.sync(() => {
        stored = batch;
        replaceCount += 1;
      }),
    deleteThread: () => Effect.void,
    inspectRows: () => Effect.succeed(stored?.snapshot.entries ?? []),
  };
  const defaultRank: TextGenerationShape["rankInboxThreads"] = (input) =>
    Effect.sync(() => ({
      rankings: input.chunk.candidates.map((candidate) => ({
        threadId: input.chunk.threadIdsByCandidateId.get(candidate.candidateId)!,
        candidateId: ThreadPriorityCandidateId.make(candidate.candidateId),
        tier: "soon" as const,
        confidence: "high" as const,
        reason: ThreadPriorityReason.make("Actionable next work"),
      })),
    }));
  const textGeneration: TextGenerationShape = {
    generateCommitMessage: unused,
    generatePrContent: unused,
    generateBranchName: unused,
    generateThreadTitle: unused,
    generateIssueContent: unused,
    answerSideQuestion: () => Effect.die("Unexpected side question"),
    rankInboxThreads: (input) => {
      providerCalls += 1;
      return (options.rank ?? defaultRank)(input);
    },
  };

  return {
    make: () =>
      makeThreadPriorityCoordinator({
        listCandidates: Effect.sync(() => candidates),
        repository,
        textGeneration,
        getModelSelection: Effect.sync(() => modelSelection),
        cwd: process.cwd(),
        nowMs: () => nowMs,
        makeBatchId: () => `batch-${replaceCount + 1}`,
      }),
    advance: (amount: number) => {
      nowMs += amount;
    },
    setCandidates: (next: ThreadPriorityCandidateInput[]) => {
      candidates = next;
    },
    setModelSelection: (next: ModelSelection) => {
      modelSelection = next;
    },
    providerCalls: () => providerCalls,
    replaceCount: () => replaceCount,
    stored: () => stored,
  };
}

it.effect("uses stable fingerprints until sent input or its age bucket changes", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    const coordinator = yield* harness.make();
    assert.equal((yield* coordinator.ensureCurrent({ force: false })).disposition, "ranked");
    harness.advance(10 * 60_000);
    assert.equal((yield* coordinator.ensureCurrent({ force: false })).disposition, "cache-hit");
    assert.equal(harness.providerCalls(), 1);

    harness.advance(30 * 60_000);
    assert.equal((yield* coordinator.ensureCurrent({ force: false })).disposition, "ranked");
    assert.equal(harness.providerCalls(), 2);

    harness.advance(THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS);
    harness.setCandidates([{ ...makeCandidate(1), title: "Changed approved title" }]);
    yield* coordinator.ensureCurrent({ force: false });
    assert.equal(harness.providerCalls(), 3);

    harness.advance(THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS);
    harness.setModelSelection({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-5",
    });
    yield* coordinator.ensureCurrent({ force: false });
    assert.equal(harness.providerCalls(), 4);
  }),
);

it.effect("enforces the 24-hour ceiling even when candidate input is unchanged", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    const coordinator = yield* harness.make();
    yield* coordinator.ensureCurrent({ force: false });
    harness.advance(THREAD_PRIORITY_MAX_CACHE_AGE_MS);
    assert.equal((yield* coordinator.ensureCurrent({ force: false })).disposition, "ranked");
    assert.equal(harness.providerCalls(), 2);
  }),
);

it.effect("rate-limits changed automatic and manual requests independently", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    const coordinator = yield* harness.make();
    yield* coordinator.ensureCurrent({ force: false });

    harness.setCandidates([{ ...makeCandidate(1), title: "Changed automatically" }]);
    const automatic = yield* coordinator.ensureCurrent({ force: false }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(automatic));
    if (Result.isFailure(automatic)) {
      assert.equal(automatic.failure.failure.kind, "rate-limited");
    }

    assert.equal((yield* coordinator.ensureCurrent({ force: true })).disposition, "ranked");
    harness.setCandidates([{ ...makeCandidate(1), title: "Changed manually" }]);
    const manual = yield* coordinator.ensureCurrent({ force: true }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(manual));
    if (Result.isFailure(manual)) {
      assert.equal(manual.failure.failure.kind, "rate-limited");
    }
    assert.equal(harness.providerCalls(), 2);
  }),
);

it.effect("coalesces concurrent forced requests into one inference operation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = makeHarness({
      rank: (input) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(
            Effect.succeed({
              rankings: input.chunk.candidates.map((candidate) => ({
                threadId: input.chunk.threadIdsByCandidateId.get(candidate.candidateId)!,
                candidateId: candidate.candidateId,
                tier: "now" as const,
                confidence: "high" as const,
                reason: ThreadPriorityReason.make("Needs attention"),
              })),
            }),
          ),
        ),
    });
    const coordinator = yield* harness.make();
    const first = yield* coordinator.ensureCurrent({ force: true }).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* coordinator.ensureCurrent({ force: true }).pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    assert.deepEqual(
      results.map((result) => result.disposition),
      ["ranked", "cache-hit"],
    );
    assert.equal(harness.providerCalls(), 1);
  }),
);

it.effect("publishes no partial replacement when a later chunk fails", () =>
  Effect.gen(function* () {
    const candidates = Array.from({ length: 41 }, (_, index) => makeCandidate(index + 1));
    let call = 0;
    const harness = makeHarness({
      candidates,
      rank: (input) => {
        call += 1;
        return call === 2
          ? Effect.fail(
              new TextGenerationError({
                operation: "rankInboxThreads",
                detail: "Provider transport failed.",
              }),
            )
          : Effect.succeed({
              rankings: input.chunk.candidates.map((candidate) => ({
                threadId: input.chunk.threadIdsByCandidateId.get(candidate.candidateId)!,
                candidateId: candidate.candidateId,
                tier: "soon" as const,
                confidence: "medium" as const,
                reason: ThreadPriorityReason.make("Useful work"),
              })),
            });
      },
    });
    const coordinator = yield* harness.make();
    const result = yield* coordinator.ensureCurrent({ force: false }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.instanceOf(result.failure, ThreadPriorityRpcError);
    assert.equal(harness.providerCalls(), 2);
    assert.equal(harness.replaceCount(), 0);
    assert.isNull(harness.stored());
  }),
);

it.effect("retains the last complete batch when a later refresh fails", () =>
  Effect.gen(function* () {
    let shouldFail = false;
    const harness = makeHarness({
      rank: (input) =>
        shouldFail
          ? Effect.fail(
              new TextGenerationError({
                operation: "rankInboxThreads",
                detail: "Provider transport failed.",
              }),
            )
          : Effect.succeed({
              rankings: input.chunk.candidates.map((candidate) => ({
                threadId: input.chunk.threadIdsByCandidateId.get(candidate.candidateId)!,
                candidateId: candidate.candidateId,
                tier: "soon" as const,
                confidence: "high" as const,
                reason: ThreadPriorityReason.make("Useful work"),
              })),
            }),
    });
    const coordinator = yield* harness.make();
    yield* coordinator.ensureCurrent({ force: false });
    const retained = harness.stored();

    shouldFail = true;
    harness.advance(THREAD_PRIORITY_AUTOMATIC_MIN_INTERVAL_MS);
    harness.setCandidates([{ ...makeCandidate(1), title: "Changed before failure" }]);
    const result = yield* coordinator.ensureCurrent({ force: false }).pipe(Effect.result);

    assert.isTrue(Result.isFailure(result));
    assert.strictEqual(harness.stored(), retained);
    assert.equal(harness.replaceCount(), 1);
  }),
);
