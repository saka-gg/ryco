import { describe, expect, it } from "vitest";

import { approximateJsonSize } from "./approximateJsonSize.ts";

describe("approximateJsonSize", () => {
  it("tracks JSON length within a small factor", () => {
    const activity = {
      id: "activity-1",
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran the test suite",
      payload: { detail: "x".repeat(5_000), exitCode: 0, ok: true, files: ["a.ts", "b.ts"] },
      turnId: null,
      sequence: 12,
      createdAt: "2026-10-12T00:00:00.000Z",
    };
    const exact = JSON.stringify(activity).length;
    const estimate = approximateJsonSize(activity);
    expect(estimate).toBeGreaterThan(exact * 0.8);
    expect(estimate).toBeLessThan(exact * 1.5);
  });

  it("is zero for undefined and survives cycles and depth", () => {
    expect(approximateJsonSize(undefined)).toBe(0);
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(approximateJsonSize(cyclic)).toBeGreaterThan(0);
    let deep: unknown = "leaf";
    for (let index = 0; index < 1_000; index += 1) deep = [deep];
    expect(() => approximateJsonSize(deep)).not.toThrow();
  });
});
