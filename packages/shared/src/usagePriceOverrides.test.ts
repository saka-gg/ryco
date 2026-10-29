import type { UsagePriceOverride } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  indexUsagePriceOverrides,
  isSyntheticUsageModel,
  matchUsageModelKey,
  normalizeUsageModelKey,
  resolveUsageModelMappings,
  usageModelBaseKey,
  validateUsagePriceOverrides,
} from "./usagePriceOverrides.ts";

const price: UsagePriceOverride = { price: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
const mapTo = (model: string): UsagePriceOverride => ({ mapTo: model });

describe("usage model keys", () => {
  it("match case-insensitively and fall back from a context variant to its base model", () => {
    expect(normalizeUsageModelKey("  Claude-Opus-5[1M] ")).toBe("claude-opus-5[1m]");
    expect(usageModelBaseKey(" Claude-Opus-5[1M] ")).toBe("claude-opus-5");
    const entries = new Set(["claude-x", "claude-y", "claude-y[1m]", "claude-z[1m]"]);
    expect(matchUsageModelKey(entries, "CLAUDE-X[1m]")).toBe("claude-x");
    // A variant's own entry wins over its base model's.
    expect(matchUsageModelKey(entries, "claude-y[1M]")).toBe("claude-y[1m]");
    // A base model never borrows a variant's entry.
    expect(matchUsageModelKey(entries, "claude-z")).toBeUndefined();
  });

  it("recognizes synthetic placeholders, with or without a provider prefix", () => {
    for (const model of ["<synthetic>", "Synthetic", "anthropic/<synthetic>"])
      expect(isSyntheticUsageModel(model)).toBe(true);
    expect(isSyntheticUsageModel("synthetic-model")).toBe(false);
  });

  it("keeps the first of several IDs that differ only in case", () => {
    const index = indexUsagePriceOverrides([
      ["Model-A", price],
      ["model-a", mapTo("other")],
    ]);
    expect([...index]).toEqual([["model-a", price]]);
  });
});

describe("resolveUsageModelMappings", () => {
  it("follows chains to their final target as typed", () => {
    const mappings = resolveUsageModelMappings([
      ["preview-1", mapTo("Preview-2")],
      ["preview-2", mapTo("Claude-Opus-5")],
      ["claude-opus-5", price],
      ["direct", mapTo("gpt-5")],
    ]);
    expect(Object.fromEntries(mappings)).toEqual({
      "preview-1": "Claude-Opus-5",
      "preview-2": "Claude-Opus-5",
      direct: "gpt-5",
    });
  });

  it("follows a target's context variant to its base model's mapping", () => {
    const mappings = resolveUsageModelMappings([
      ["a", mapTo("b[1m]")],
      ["B", mapTo("c")],
    ]);
    expect(mappings.get("a")).toBe("c");
  });

  it("drops every mapping whose chain loops", () => {
    const mappings = resolveUsageModelMappings([
      ["into-loop", mapTo("loop-a")],
      ["loop-a", mapTo("loop-b")],
      ["loop-b", mapTo("LOOP-A")],
      ["self", mapTo("Self")],
      ["fine", mapTo("loop-free")],
    ]);
    expect(Object.fromEntries(mappings)).toEqual({ fine: "loop-free" });
  });
});

describe("validateUsagePriceOverrides", () => {
  it("reports duplicates, self-maps, loops and synthetic placeholders in entry order", () => {
    expect(
      validateUsagePriceOverrides([
        ["claude-x", price],
        ["Claude-X", price],
        ["self", mapTo(" SELF ")],
        ["loop-a", mapTo("loop-b")],
        ["loop-b", mapTo("loop-a")],
        ["<synthetic>", price],
        ["preview", mapTo("claude-x")],
      ]),
    ).toEqual([
      { key: "Claude-X", issue: "duplicate" },
      { key: "self", issue: "self-map" },
      { key: "loop-a", issue: "loop" },
      { key: "loop-b", issue: "loop" },
      { key: "<synthetic>", issue: "synthetic" },
    ]);
  });

  it("accepts prices, mappings to priced or published models, and an empty list", () => {
    expect(validateUsagePriceOverrides([])).toEqual([]);
    expect(
      validateUsagePriceOverrides([
        ["claude-x", price],
        ["preview", mapTo("claude-x")],
        ["preview[1m]", mapTo("preview")],
        ["other", mapTo("gpt-5")],
      ]),
    ).toEqual([]);
  });
});
