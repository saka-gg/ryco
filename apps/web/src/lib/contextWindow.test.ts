import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@ryco/contracts";

import {
  createInitialContextWindowUsage,
  deriveContextWindowUsage,
  deriveLatestContextWindowSnapshot,
  parseContextWindowTokenLimit,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("parses configured context window limits", () => {
    expect(parseContextWindowTokenLimit("200k")).toBe(200_000);
    expect(parseContextWindowTokenLimit("1M")).toBe(1_000_000);
    expect(parseContextWindowTokenLimit("1.5m")).toBe(1_500_000);
    expect(parseContextWindowTokenLimit("258000")).toBe(258_000);
  });

  it("treats malformed, non-positive, and unsupported context limits as unknown", () => {
    expect(parseContextWindowTokenLimit(null)).toBeNull();
    expect(parseContextWindowTokenLimit("0")).toBeNull();
    expect(parseContextWindowTokenLimit("1.5")).toBeNull();
    expect(parseContextWindowTokenLimit("200kb")).toBeNull();
  });

  it("creates an initial zero-usage state with or without a known limit", () => {
    expect(createInitialContextWindowUsage(200_000)).toMatchObject({
      usedTokens: 0,
      maxTokens: 200_000,
      remainingTokens: 200_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
    expect(createInitialContextWindowUsage(null)).toMatchObject({
      usedTokens: 0,
      maxTokens: null,
      remainingTokens: null,
      usedPercentage: null,
      remainingPercentage: null,
    });
  });

  it("prefers real provider usage over the configured initial limit", () => {
    const usage = deriveContextWindowUsage(
      [
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 14_000,
          maxTokens: 258_000,
        }),
      ],
      "1m",
    );

    expect(usage.usedTokens).toBe(14_000);
    expect(usage.maxTokens).toBe(258_000);
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("falls back to the selected model's context limit when usage has none", () => {
    const usage = deriveContextWindowUsage(
      [makeActivity("activity-1", "context-window.updated", { usedTokens: 32_000 })],
      null,
      1_000_000,
    );

    expect(usage.usedTokens).toBe(32_000);
    expect(usage.maxTokens).toBe(1_000_000);
    expect(usage.remainingTokens).toBe(968_000);
    expect(usage.usedPercentage).toBe(3.2);
    expect(usage.remainingPercentage).toBe(96.8);
  });

  it("seeds an initial usage from the model limit before any turn", () => {
    const usage = deriveContextWindowUsage([], null, 128_000);

    expect(usage.maxTokens).toBe(128_000);
    expect(usage.usedTokens).toBe(0);
    expect(usage.remainingTokens).toBe(128_000);
    expect(usage.usedPercentage).toBe(0);
  });

  it("keeps a real provider max over the model fallback", () => {
    const usage = deriveContextWindowUsage(
      [
        makeActivity("activity-1", "context-window.updated", {
          usedTokens: 1_000,
          maxTokens: 2_000,
        }),
      ],
      null,
      1_000_000,
    );

    expect(usage.maxTokens).toBe(2_000);
  });

  it("ignores invalid model fallback limits", () => {
    const activities = [makeActivity("activity-1", "context-window.updated", { usedTokens: 100 })];
    expect(deriveContextWindowUsage(activities, null, 0).maxTokens).toBeNull();
    expect(deriveContextWindowUsage(activities, null, -5).maxTokens).toBeNull();
    expect(deriveContextWindowUsage(activities, null, 12.5).maxTokens).toBeNull();
    expect(deriveContextWindowUsage(activities, null, null).maxTokens).toBeNull();
  });
  it("preserves the configured limit after usage arrives without a maximum", () => {
    expect(
      deriveContextWindowUsage(
        [makeActivity("usage", "context-window.updated", { usedTokens: 50_000 })],
        "200k",
        1_000_000,
      ),
    ).toMatchObject({ usedTokens: 50_000, maxTokens: 200_000, usedPercentage: 25 });
  });

  it("uses the latest snapshot, including a zero reset, rather than accumulating usage", () => {
    const activities = [
      makeActivity("old", "context-window.updated", { usedTokens: 90_000, maxTokens: 100_000 }),
      makeActivity("new", "context-window.updated", { usedTokens: 20_000, maxTokens: 100_000 }),
    ];
    expect(deriveContextWindowUsage(activities, null)).toMatchObject({
      usedTokens: 20_000,
      usedPercentage: 20,
    });
    activities.push(
      makeActivity("reset", "context-window.updated", { usedTokens: 0, maxTokens: 100_000 }),
    );
    expect(deriveContextWindowUsage(activities, null)).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      usedPercentage: 0,
    });
  });

  it("uses a model fallback for invalid live limits and clamps only the percentage", () => {
    expect(
      deriveContextWindowUsage(
        [makeActivity("usage", "context-window.updated", { usedTokens: 120_000, maxTokens: 0 })],
        null,
        100_000,
      ),
    ).toMatchObject({
      usedTokens: 120_000,
      maxTokens: 100_000,
      remainingTokens: 0,
      usedPercentage: 100,
    });
  });
});
