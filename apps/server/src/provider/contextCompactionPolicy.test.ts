import { describe, expect, it } from "vitest";

import {
  CONTEXT_COMPACTION_TRIGGER_RATIO,
  NATIVE_AUTO_COMPACT_MIN_LEAD_TOKENS,
  NATIVE_AUTO_COMPACT_RESERVE_TOKENS,
  concludeContextCompactionRequest,
  disableContextCompaction,
  initialContextCompactionPolicyState,
  markContextCompactionStarted,
  nativeAutoCompactWindowBehindTrigger,
  observeContextCompaction,
  recordContextCompactionRequest,
  settleContextCompaction,
} from "./contextCompactionPolicy.ts";

describe("context compaction policy", () => {
  it("triggers at the high watermark", () => {
    const state = initialContextCompactionPolicyState(7);

    expect(
      observeContextCompaction(state, {
        generation: 7,
        usage: { usedTokens: 159_999, maxTokens: 200_000 },
      }).trigger,
    ).toBe(false);
    expect(
      observeContextCompaction(state, {
        generation: 7,
        usage: { usedTokens: 160_000, maxTokens: 200_000 },
      }),
    ).toMatchObject({
      trigger: true,
      state: { phase: "requested", armed: false },
    });
  });

  it("keeps one request in flight and rearms only below the low watermark", () => {
    const requested = observeContextCompaction(initialContextCompactionPolicyState(3), {
      generation: 3,
      usage: { usedTokens: 170_000, maxTokens: 200_000 },
    }).state;
    const compacting = markContextCompactionStarted(requested, 3);

    expect(
      observeContextCompaction(compacting, {
        generation: 3,
        usage: { usedTokens: 190_000, maxTokens: 200_000 },
      }).trigger,
    ).toBe(false);

    const settled = settleContextCompaction(compacting, 3);
    const stillHigh = observeContextCompaction(settled, {
      generation: 3,
      usage: { usedTokens: 150_000, maxTokens: 200_000 },
    });
    expect(stillHigh).toMatchObject({ trigger: false, state: { armed: false } });

    const rearmed = observeContextCompaction(stillHigh.state, {
      generation: 3,
      usage: { usedTokens: 130_000, maxTokens: 200_000 },
    });
    expect(rearmed).toMatchObject({ trigger: false, state: { armed: true, phase: "idle" } });
  });

  describe("with a configured window", () => {
    const observe = (
      state: ReturnType<typeof initialContextCompactionPolicyState>,
      usedTokens: number,
      maxTokens: number | undefined,
      windowTokens: number | undefined,
    ) =>
      observeContextCompaction(state, {
        generation: 1,
        usage: { usedTokens, ...(maxTokens !== undefined ? { maxTokens } : {}) },
        windowTokens,
      });

    it("triggers at 80% of a window smaller than the model's", () => {
      const state = initialContextCompactionPolicyState(1);

      expect(observe(state, 150_000, 1_000_000, 200_000).trigger).toBe(false);
      expect(observe(state, 160_000, 1_000_000, 200_000)).toMatchObject({
        trigger: true,
        state: { phase: "requested", armed: false },
      });
    });

    it("uses the model's window when the configured one is larger", () => {
      const state = initialContextCompactionPolicyState(1);

      expect(observe(state, 300_000, 200_000, 400_000).trigger).toBe(true);
      expect(observe(state, 159_999, 200_000, 400_000).trigger).toBe(false);
    });

    it("uses the configured window when the model's is unknown", () => {
      const state = initialContextCompactionPolicyState(1);

      expect(observe(state, 159_999, undefined, 200_000).trigger).toBe(false);
      expect(observe(state, 160_000, undefined, 200_000).trigger).toBe(true);
      expect(observe(state, 160_000, Number.NaN, 200_000).trigger).toBe(true);
      expect(observe(state, 900_000, undefined, undefined).trigger).toBe(false);
    });

    it("rearms at 65% of the effective window", () => {
      const settled = settleContextCompaction(
        markContextCompactionStarted(
          observe(initialContextCompactionPolicyState(1), 170_000, 1_000_000, 200_000).state,
          1,
        ),
        1,
      );

      const stillHigh = observe(settled, 131_000, 1_000_000, 200_000);
      expect(stillHigh).toMatchObject({ trigger: false, state: { armed: false } });
      const rearmed = observe(stillHigh.state, 130_000, 1_000_000, 200_000);
      expect(rearmed).toMatchObject({ trigger: false, state: { armed: true, phase: "idle" } });
      expect(observe(rearmed.state, 160_000, 1_000_000, 200_000).trigger).toBe(true);
    });
  });

  describe("the window Claude Code starts with", () => {
    const nativeThreshold = (windowTokens: number) =>
      nativeAutoCompactWindowBehindTrigger(windowTokens) - NATIVE_AUTO_COMPACT_RESERVE_TOKENS;

    it("raises a window below 200,000 tokens so Claude Code compacts after the trigger", () => {
      // Given as is, Claude Code would compact at 67,000 and 117,000: before 80,000 and 120,000.
      expect(nativeAutoCompactWindowBehindTrigger(100_000)).toBe(120_000);
      expect(nativeAutoCompactWindowBehindTrigger(150_000)).toBe(160_000);
      expect(nativeThreshold(100_000)).toBe(87_000);
      expect(nativeThreshold(150_000)).toBe(127_000);
    });

    it("keeps a window of 200,000 tokens or more", () => {
      expect(nativeAutoCompactWindowBehindTrigger(200_000)).toBe(200_000);
      expect(nativeAutoCompactWindowBehindTrigger(400_000)).toBe(400_000);
      expect(nativeAutoCompactWindowBehindTrigger(1_000_000)).toBe(1_000_000);
    });

    it("keeps Claude Code's threshold the lead above the trigger across the range", () => {
      for (let windowTokens = 100_000; windowTokens <= 1_000_000; windowTokens += 1_000) {
        const nativeWindow = nativeAutoCompactWindowBehindTrigger(windowTokens);
        expect(nativeWindow).toBeGreaterThanOrEqual(windowTokens);
        expect(nativeWindow).toBeLessThanOrEqual(1_000_000);
        expect(nativeThreshold(windowTokens)).toBeGreaterThanOrEqual(
          windowTokens * CONTEXT_COMPACTION_TRIGGER_RATIO + NATIVE_AUTO_COMPACT_MIN_LEAD_TOKENS,
        );
      }
    });
  });

  it("blocks policy requests while a provider-initiated compaction is active", () => {
    const compacting = markContextCompactionStarted(initialContextCompactionPolicyState(5), 5);

    expect(
      observeContextCompaction(compacting, {
        generation: 5,
        usage: { usedTokens: 190_000, maxTokens: 200_000 },
      }),
    ).toEqual({ state: compacting, trigger: false });
  });

  it("ignores stale generations and remains disabled after unsupported behavior", () => {
    const state = initialContextCompactionPolicyState(11);
    const stale = observeContextCompaction(state, {
      generation: 10,
      usage: { usedTokens: 190_000, maxTokens: 200_000 },
    });
    expect(stale).toEqual({ state, trigger: false });

    const disabled = disableContextCompaction(state, 11);
    expect(
      observeContextCompaction(disabled, {
        generation: 11,
        usage: { usedTokens: 190_000, maxTokens: 200_000 },
      }),
    ).toEqual({ state: disabled, trigger: false });
  });

  const requested = (generation: number) =>
    observeContextCompaction(initialContextCompactionPolicyState(generation), {
      generation,
      usage: { usedTokens: 170_000, maxTokens: 200_000 },
    }).state;

  it("binds only a triggered request of the current generation", () => {
    expect(recordContextCompactionRequest(requested(2), 2, "compact-1")).toMatchObject({
      phase: "requested",
      requestId: "compact-1",
    });
    const idle = initialContextCompactionPolicyState(2);
    expect(recordContextCompactionRequest(idle, 2, "compact-1")).toBe(idle);
    const current = requested(2);
    expect(recordContextCompactionRequest(current, 1, "compact-1")).toBe(current);
  });

  it("concludes a request its boundary settled without a warning", () => {
    const settled = settleContextCompaction(
      markContextCompactionStarted(recordContextCompactionRequest(requested(4), 4, "c"), 4),
      4,
    );

    expect(
      concludeContextCompactionRequest(settled, { generation: 4, requestId: "c", aborted: false }),
    ).toEqual({
      state: { generation: 4, phase: "idle", armed: false },
      unavailable: false,
    });
  });

  it("disables compaction when the request's result arrives without a boundary", () => {
    const pending = recordContextCompactionRequest(requested(6), 6, "c");
    const unavailable = { state: { generation: 6, phase: "disabled", armed: false } };

    expect(
      concludeContextCompactionRequest(pending, { generation: 6, requestId: "c", aborted: false }),
    ).toEqual({ ...unavailable, unavailable: true });
    expect(
      concludeContextCompactionRequest(markContextCompactionStarted(pending, 6), {
        generation: 6,
        requestId: "c",
        aborted: false,
      }),
    ).toEqual({ ...unavailable, unavailable: true });
  });

  it("settles a stopped request quietly and leaves rearming to the low watermark", () => {
    const compacting = markContextCompactionStarted(
      recordContextCompactionRequest(requested(8), 8, "c"),
      8,
    );

    expect(
      concludeContextCompactionRequest(compacting, {
        generation: 8,
        requestId: "c",
        aborted: true,
      }),
    ).toEqual({
      state: { generation: 8, phase: "idle", armed: false },
      unavailable: false,
    });
  });

  it("ignores results for another request or generation", () => {
    const pending = recordContextCompactionRequest(requested(9), 9, "c");

    for (const input of [
      { generation: 9, requestId: "other", aborted: false },
      { generation: 8, requestId: "c", aborted: false },
    ]) {
      expect(concludeContextCompactionRequest(pending, input)).toEqual({
        state: pending,
        unavailable: false,
      });
    }
  });
});
