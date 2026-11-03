import { describe, expect, it } from "vite-plus/test";

import { foldsAsLegacy, splitLegacyModels } from "./legacyModelFold.ts";

// Like every server model, current ones carry `isCustom` and no legacy flag.
const OPUS_5 = { slug: "claude-opus-5", isCustom: false };
const SONNET_5 = { slug: "claude-sonnet-5", isCustom: false };
const OPUS_4_6 = { slug: "claude-opus-4-6", isLegacy: true };
const SONNET_4_6 = { slug: "claude-sonnet-4-6", isLegacy: true };
const HAIKU_4_5 = { slug: "claude-haiku-4-5", isLegacy: true };

const slugs = (models: ReadonlyArray<{ readonly slug: string }>) =>
  models.map((model) => model.slug);
const notPinned = () => false;

describe("splitLegacyModels", () => {
  it("keeps the input order in both parts", () => {
    const split = splitLegacyModels([OPUS_4_6, OPUS_5, HAIKU_4_5, SONNET_5, SONNET_4_6], notPinned);

    expect(slugs(split.current)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(slugs(split.legacy)).toEqual([
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
  });

  it("keeps a pinned legacy model in the current part", () => {
    const split = splitLegacyModels(
      [OPUS_5, OPUS_4_6, HAIKU_4_5],
      (model) => model.slug === "claude-haiku-4-5",
    );

    expect(slugs(split.current)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    expect(slugs(split.legacy)).toEqual(["claude-opus-4-6"]);
  });

  it("never folds a custom model, even one marked legacy", () => {
    const custom = { slug: "openai/gpt-5.5", isCustom: true, isLegacy: true };
    const split = splitLegacyModels([OPUS_5, custom, OPUS_4_6], notPinned);

    expect(slugs(split.current)).toEqual(["claude-opus-5", "openai/gpt-5.5"]);
    expect(slugs(split.legacy)).toEqual(["claude-opus-4-6"]);
  });

  it("does not fold when every model is legacy", () => {
    const models = [OPUS_4_6, SONNET_4_6, HAIKU_4_5];
    const split = splitLegacyModels(models, notPinned);

    expect(split.current).toBe(models);
    expect(split.legacy).toEqual([]);
  });

  it("does not fold models without the legacy flag", () => {
    const split = splitLegacyModels(
      [OPUS_5, { slug: "claude-sonnet-5", isLegacy: false }],
      notPinned,
    );

    expect(slugs(split.current)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(split.legacy).toEqual([]);
  });
});

describe("foldsAsLegacy", () => {
  it("folds only unpinned, non-custom legacy models", () => {
    const custom = { slug: "openai/gpt-5.5", isCustom: true, isLegacy: true };

    expect(foldsAsLegacy(HAIKU_4_5, notPinned)).toBe(true);
    expect(foldsAsLegacy(HAIKU_4_5, () => true)).toBe(false);
    expect(foldsAsLegacy(custom, notPinned)).toBe(false);
    expect(foldsAsLegacy(OPUS_5, notPinned)).toBe(false);
  });
});
