import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadPriorityBatchSnapshot,
  ThreadPriorityCandidateRanking,
  ThreadPriorityEnsureCurrentInput,
  ThreadPriorityEnsureCurrentResult,
  ThreadPriorityFailure,
  ThreadPriorityReason,
} from "./threadPriority.ts";

describe("thread priority vocabulary", () => {
  const decodeRanking = Schema.decodeUnknownSync(ThreadPriorityCandidateRanking);

  it("accepts only the approved tiers and confidence values", () => {
    for (const tier of ["now", "soon", "later", "none"] as const) {
      for (const confidence of ["high", "medium", "low"] as const) {
        expect(
          decodeRanking({
            candidateId: "candidate-1",
            tier,
            confidence,
            reason: "Needs attention",
          }),
        ).toMatchObject({ tier, confidence });
      }
    }

    expect(() =>
      decodeRanking({
        candidateId: "candidate-1",
        tier: "urgent",
        confidence: "high",
        reason: "Needs attention",
      }),
    ).toThrow();
    expect(() =>
      decodeRanking({
        candidateId: "candidate-1",
        tier: "now",
        confidence: "certain",
        reason: "Needs attention",
      }),
    ).toThrow();
  });

  it("trims reasons and enforces non-empty 160-character output", () => {
    const decodeReason = Schema.decodeUnknownSync(ThreadPriorityReason);
    expect(decodeReason("  concise reason  ")).toBe("concise reason");
    expect(decodeReason("x".repeat(160))).toHaveLength(160);
    expect(() => decodeReason("   ")).toThrow();
    expect(() => decodeReason("x".repeat(161))).toThrow();
  });

  it("represents malformed, duplicate, and unknown candidate output as structured failures", () => {
    const decodeFailure = Schema.decodeUnknownSync(ThreadPriorityFailure);
    expect(
      decodeFailure({ kind: "malformed-response", detail: "Response was not valid JSON" }),
    ).toMatchObject({ kind: "malformed-response" });
    expect(
      decodeFailure({
        kind: "duplicate-candidate-id",
        detail: "Candidate appeared twice",
        candidateId: "candidate-1",
      }),
    ).toMatchObject({ kind: "duplicate-candidate-id", candidateId: "candidate-1" });
    expect(
      decodeFailure({
        kind: "unknown-candidate-id",
        detail: "Candidate was not requested",
        candidateId: "candidate-9",
      }),
    ).toMatchObject({ kind: "unknown-candidate-id", candidateId: "candidate-9" });
  });
});

describe("thread priority snapshots and freshness RPC", () => {
  const freshness = {
    rankedAt: "2026-08-25T00:00:00.000Z",
    usableUntil: "2026-08-26T00:00:00.000Z",
    checkedAt: "2026-08-25T00:00:01.000Z",
  };

  it("decodes a published batch with model and cache metadata", () => {
    const decoded = Schema.decodeUnknownSync(ThreadPriorityBatchSnapshot)({
      batchId: "batch-1",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      modelFingerprint: "model-fingerprint",
      promptVersion: "thread-priority-v1",
      freshness,
      entries: [
        {
          threadId: "thread-1",
          tier: "now",
          confidence: "high",
          reason: "Waiting for approval",
          inputFingerprint: "input-fingerprint",
        },
      ],
    });
    expect(decoded.entries[0]?.threadId).toBe("thread-1");
    expect(decoded.freshness.usableUntil).toBe(freshness.usableUntil);
  });

  it("defaults normal refresh and preserves explicit forced refresh", () => {
    const decodeInput = Schema.decodeUnknownSync(ThreadPriorityEnsureCurrentInput);
    expect(decodeInput({}).force).toBe(false);
    expect(decodeInput({ force: true }).force).toBe(true);
    expect(decodeInput({ force: false, prompt: "client-controlled prompt" })).toEqual({
      force: false,
    });
    expect(() => decodeInput({ force: "yes", prompt: "forbidden" })).toThrow();
  });

  it("returns the published batch identity and cache or inference disposition", () => {
    const decodeResult = Schema.decodeUnknownSync(ThreadPriorityEnsureCurrentResult);
    expect(decodeResult({ batchId: "batch-1", disposition: "cache-hit", freshness })).toMatchObject(
      {
        batchId: "batch-1",
        disposition: "cache-hit",
      },
    );
    expect(decodeResult({ batchId: "batch-2", disposition: "ranked", freshness })).toMatchObject({
      batchId: "batch-2",
      disposition: "ranked",
    });
    expect(() => decodeResult({ batchId: "batch-3", disposition: "stale", freshness })).toThrow();
  });
});
