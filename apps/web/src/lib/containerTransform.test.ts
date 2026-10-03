import { describe, expect, it } from "vitest";

import { springCurve } from "./containerTransform";

function samplesOf(easing: string): number[] {
  const inner = /^linear\((.*)\)$/.exec(easing)?.[1];
  if (!inner) throw new Error(`not a linear() easing: ${easing}`);
  return inner.split(",").map((value) => Number.parseFloat(value));
}

describe("springCurve", () => {
  it("samples a damped spring from rest to its target", () => {
    const curve = springCurve({ stiffness: 300, damping: 31, samples: 32 });
    const samples = samplesOf(curve.easing);

    expect(samples).toHaveLength(32);
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(1);
    expect(curve.durationMs).toBeGreaterThan(200);
    expect(curve.durationMs).toBeLessThan(1500);
  });

  it("stays within a hair of the target for a near-critically damped spring", () => {
    const samples = samplesOf(springCurve({ stiffness: 300, damping: 31 }).easing);

    expect(Math.max(...samples)).toBeLessThan(1.02);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThanOrEqual((samples[index - 1] ?? 0) - 0.02);
    }
  });

  it("overshoots when underdamped and settles slower when stiffness drops", () => {
    const bouncy = springCurve({ stiffness: 600, damping: 14 });
    const soft = springCurve({ stiffness: 120, damping: 22 });

    expect(Math.max(...samplesOf(bouncy.easing))).toBeGreaterThan(1.05);
    expect(soft.durationMs).toBeGreaterThan(
      springCurve({ stiffness: 600, damping: 49 }).durationMs,
    );
  });
});
