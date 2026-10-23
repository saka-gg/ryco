import { describe, expect, it } from "vitest";

import {
  concludeContextCompactionRequest,
  disableContextCompaction,
  initialContextCompactionPolicyState,
  markContextCompactionStarted,
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
