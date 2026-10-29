import type { UsagePriceOverrides } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  listsUsagePriceModel,
  parseUsagePriceForm,
  resolveUsagePriceDrafts,
  savedRowId,
  upsertUsagePriceDraft,
  usagePriceForm,
  type UsagePriceDraft,
} from "./usagePriceSettings.logic";

const SAVED: UsagePriceOverrides = {
  "claude-preview-x": {
    price: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 0.3 },
  },
  "gateway/sonnet": { mapTo: "claude-sonnet-4-5" },
};

const newRow = (id: string, fields: Omit<UsagePriceDraft, "id" | "isNew">): UsagePriceDraft => ({
  id,
  isNew: true,
  ...fields,
});

const edit = (model: string, fields: Partial<UsagePriceDraft> = {}): UsagePriceDraft => ({
  id: savedRowId(model),
  model,
  isNew: false,
  ...fields,
});

describe("parseUsagePriceForm", () => {
  const form = (prices: Partial<ReturnType<typeof usagePriceForm>["prices"]>) => ({
    ...usagePriceForm(),
    prices: { ...usagePriceForm().prices, ...prices },
  });

  it("leaves blank cache prices out (they charge the input price) and keeps an explicit 0", () => {
    expect(
      parseUsagePriceForm(
        " model-a ",
        form({
          inputUsdPerMillion: "1.5",
          outputUsdPerMillion: "6",
          cacheReadUsdPerMillion: "0",
          cacheWriteUsdPerMillion: " ",
        }),
      ),
    ).toEqual({
      override: {
        price: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 6, cacheReadUsdPerMillion: 0 },
      },
    });
  });

  it("requires a model ID, input and output prices, and numbers the node accepts", () => {
    const priced = form({ inputUsdPerMillion: "1", outputUsdPerMillion: "2" });
    expect(parseUsagePriceForm("  ", priced)).toEqual({ error: "Enter a model ID." });
    expect(parseUsagePriceForm("x".repeat(257), priced)).toEqual({
      error: "Model IDs have at most 256 characters.",
    });
    expect(parseUsagePriceForm("m", form({ inputUsdPerMillion: "1" }))).toEqual({
      error: "Enter input and output prices.",
    });
    for (const value of ["-1", "abc", "1,5", "2000000", "Infinity"]) {
      expect(
        parseUsagePriceForm("m", {
          ...priced,
          prices: { ...priced.prices, outputUsdPerMillion: value },
        }),
      ).toEqual({ error: "Enter prices as numbers from 0 to 1,000,000." });
    }
    expect(
      parseUsagePriceForm("m", form({ inputUsdPerMillion: ".5", outputUsdPerMillion: "1e2" })),
    ).toEqual({ override: { price: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 100 } } });
  });

  it("maps to a trimmed model and ignores prices typed before switching", () => {
    const priced = form({ inputUsdPerMillion: "1", outputUsdPerMillion: "2" });
    expect(
      parseUsagePriceForm("m", { ...priced, mode: "map", mapTo: " claude-opus-4-1 " }),
    ).toEqual({
      override: { mapTo: "claude-opus-4-1" },
    });
    expect(parseUsagePriceForm("m", { ...priced, mode: "map", mapTo: "" })).toEqual({
      error: "Enter the model to count it as.",
    });
  });
});

describe("resolveUsagePriceDrafts", () => {
  it("shows saved entries by model ID with their values, then new rows", () => {
    const { rows, patch, errors, blocked } = resolveUsagePriceDrafts(SAVED, [
      newRow("new:0", { model: "" }),
    ]);
    expect(rows.map((row) => [row.id, row.form.mode])).toEqual([
      ["saved:claude-preview-x", "price"],
      ["saved:gateway/sonnet", "map"],
      ["new:0", "price"],
    ]);
    expect(rows[0]?.form.prices).toEqual({
      inputUsdPerMillion: "3",
      outputUsdPerMillion: "15",
      cacheReadUsdPerMillion: "0.3",
      cacheWriteUsdPerMillion: "",
    });
    expect(rows[1]?.form.mapTo).toBe("claude-sonnet-4-5");
    // A blank new row is neither an error nor a change.
    expect(patch).toEqual({});
    expect(errors.size).toBe(0);
    expect(blocked).toBe(false);
  });

  it("sends only changed entries, null for removals, and nothing for edits back to the saved value", () => {
    const { patch, blocked } = resolveUsagePriceDrafts(SAVED, [
      edit("claude-preview-x", {
        prices: { outputUsdPerMillion: "15.0", cacheWriteUsdPerMillion: "" },
      }),
      edit("gateway/sonnet", { removed: true }),
      newRow("new:0", {
        model: " claude-opus-5-preview ",
        prices: { inputUsdPerMillion: "5", outputUsdPerMillion: "25" },
      }),
    ]);
    expect(blocked).toBe(false);
    expect(patch).toEqual({
      "gateway/sonnet": null,
      "claude-opus-5-preview": { price: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } },
    });
  });

  it("replaces a price with a mapping, and a mapping with a price", () => {
    const { patch } = resolveUsagePriceDrafts(SAVED, [
      edit("claude-preview-x", { mode: "map", mapTo: "claude-opus-4-1" }),
      edit("gateway/sonnet", {
        mode: "price",
        prices: { inputUsdPerMillion: "2", outputUsdPerMillion: "8" },
      }),
    ]);
    expect(patch).toEqual({
      "claude-preview-x": { mapTo: "claude-opus-4-1" },
      "gateway/sonnet": { price: { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } },
    });
  });

  it("blocks saving on an edited row's error and reports it on that row", () => {
    const result = resolveUsagePriceDrafts(SAVED, [
      edit("claude-preview-x", { prices: { inputUsdPerMillion: "" } }),
      newRow("new:0", {
        model: "fine",
        prices: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" },
      }),
    ]);
    expect(result.errors.get("saved:claude-preview-x")).toBe("Enter input and output prices.");
    expect(result.blocked).toBe(true);
    expect(result.patch).toEqual({});
  });

  it("flags a model listed twice in another case, a mapping to itself and mapping loops", () => {
    const result = resolveUsagePriceDrafts(SAVED, [
      newRow("new:dup", {
        model: "Claude-Preview-X",
        prices: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" },
      }),
      newRow("new:self", { model: "alias-a", mode: "map", mapTo: "ALIAS-A" }),
      newRow("new:loop-1", { model: "loop-a", mode: "map", mapTo: "loop-b" }),
      newRow("new:loop-2", { model: "loop-b", mode: "map", mapTo: "loop-a" }),
      newRow("new:synthetic", {
        model: "<synthetic>",
        prices: { inputUsdPerMillion: "1", outputUsdPerMillion: "1" },
      }),
    ]);
    expect(Object.fromEntries(result.errors)).toEqual({
      "new:dup": "This model is already listed.",
      "new:self": "Map to a different model.",
      "new:loop-1": "These mappings form a loop, so none of them applies.",
      "new:loop-2": "These mappings form a loop, so none of them applies.",
      "new:synthetic": "Placeholder models are never priced.",
    });
    expect(result.blocked).toBe(true);
  });

  it("flags the saved entries the node ignores: those after the first of a model in stored order", () => {
    const price = (input: number) => ({
      price: { inputUsdPerMillion: input, outputUsdPerMillion: input * 5 },
    });
    // Shown sorted (kimi-k3 first), but the node keeps Kimi-K3, saved first.
    const result = resolveUsagePriceDrafts({ "Kimi-K3": price(3), "kimi-k3": price(1) }, [
      newRow("new:0", { model: "KIMI-k3", mode: "map", mapTo: "claude-opus-4-1" }),
    ]);
    expect(result.rows.map((row) => row.model)).toEqual(["kimi-k3", "Kimi-K3", "KIMI-k3"]);
    expect(Object.fromEntries(result.errors)).toEqual({
      "saved:kimi-k3": "This model is already listed.",
      "new:0": "This model is already listed.",
    });
  });

  it("lets a removed entry's model be added again in another case", () => {
    const { patch, blocked } = resolveUsagePriceDrafts(SAVED, [
      edit("claude-preview-x", { removed: true }),
      newRow("new:0", { model: "Claude-Preview-X", mode: "map", mapTo: "claude-opus-4-1" }),
    ]);
    expect(blocked).toBe(false);
    expect(patch).toEqual({
      "claude-preview-x": null,
      "Claude-Preview-X": { mapTo: "claude-opus-4-1" },
    });
  });

  it("warns about a saved problem without blocking unrelated edits", () => {
    const saved: UsagePriceOverrides = {
      ...SAVED,
      "loop-a": { mapTo: "loop-b" },
      "loop-b": { mapTo: "loop-a" },
    };
    const result = resolveUsagePriceDrafts(saved, [
      edit("claude-preview-x", { prices: { inputUsdPerMillion: "4" } }),
    ]);
    expect(result.errors.get("saved:loop-a")).toBeDefined();
    expect(result.blocked).toBe(false);
    expect(Object.keys(result.patch)).toEqual(["claude-preview-x"]);
  });

  it("refuses more entries than a node keeps", () => {
    const drafts = Array.from({ length: 199 }, (_, index) =>
      newRow(`new:${index}`, { model: `model-${index}`, mode: "map", mapTo: "claude-opus-4-1" }),
    );
    expect(resolveUsagePriceDrafts(SAVED, drafts).limitError).toMatch(/at most 200 models/u);
    expect(resolveUsagePriceDrafts(SAVED, drafts).blocked).toBe(true);
    expect(resolveUsagePriceDrafts(SAVED, drafts.slice(1)).limitError).toBeNull();
  });
});

describe("draft helpers", () => {
  it("replaces a row's draft in place or appends it", () => {
    const first = newRow("new:0", { model: "a" });
    const second = newRow("new:1", { model: "b" });
    expect(upsertUsagePriceDraft([first, second], { ...first, model: "c" })).toEqual([
      { ...first, model: "c" },
      second,
    ]);
    expect(upsertUsagePriceDraft([first], second)).toEqual([first, second]);
  });

  it("finds a listed model in any case, but not a removed one", () => {
    const { rows } = resolveUsagePriceDrafts(SAVED, [edit("gateway/sonnet", { removed: true })]);
    expect(listsUsagePriceModel(rows, "CLAUDE-PREVIEW-X")).toBe(true);
    expect(listsUsagePriceModel(rows, "gateway/sonnet")).toBe(false);
  });
});
