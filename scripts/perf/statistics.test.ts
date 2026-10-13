import { assert, describe, it } from "@effect/vitest";

import { DEFAULT_COMPARISON_POLICY, type PerfSample, sampleMetric } from "./model.ts";
import { aggregate, finiteValues, median, percentile } from "./statistics.ts";

describe("external performance statistics", () => {
  it("filters unavailable and non-finite values", () => {
    assert.deepStrictEqual(finiteValues([1, null, Number.NaN, 2, undefined, Infinity]), [1, 2]);
  });

  it("calculates odd and even medians without mutating input", () => {
    const values = [9, 1, 5, 3];
    assert.equal(median(values), 4);
    assert.deepStrictEqual(values, [9, 1, 5, 3]);
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([]), null);
  });

  it("uses a nearest-rank p95 and bounded fractions", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    assert.equal(percentile(values, 0.95), 19);
    assert.equal(percentile(values, -1), 1);
    assert.equal(percentile(values, 2), 20);
  });

  it("aggregates the finite samples", () => {
    assert.deepStrictEqual(aggregate([4, 1, 3, 2, null]), {
      count: 4,
      median: 2.5,
      p95: 4,
      maximum: 4,
      minimum: 1,
    });
  });
});

describe("theme recalc metric", () => {
  it("reads the probe's value and treats results recorded before it as unavailable", () => {
    const sample = { themeRecalcMs: 41.5 } as unknown as PerfSample;
    const legacy = {} as unknown as PerfSample;
    assert.equal(sampleMetric(sample, "themeRecalcMs"), 41.5);
    assert.equal(sampleMetric(legacy, "themeRecalcMs"), null);
    assert.deepStrictEqual(DEFAULT_COMPARISON_POLICY.metrics.themeRecalcMs, {
      relativePercent: 20,
      absolute: 10,
    });
  });
});
