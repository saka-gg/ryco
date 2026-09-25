import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindow,
  resolveClaudeCatalogModel,
  resolveClaudeModelsForVersion,
} from "./ClaudeModelCatalog.ts";

const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function modelSelection(model: string, options?: Record<string, string | boolean>) {
  return createModelSelection(
    INSTANCE_ID,
    model,
    Object.entries(options ?? {}).map(([id, value]) => ({ id, value })),
  );
}

describe("ClaudeModelCatalog", () => {
  describe("version gating", () => {
    it("shows Fable 5.1 at the minimum CLI version and hides it below", () => {
      const at257 = resolveClaudeModelsForVersion(catalog, "2.1.257").map((model) => model.slug);
      assert.equal(at257.includes("claude-fable-5-1"), true);

      const at256 = resolveClaudeModelsForVersion(catalog, "2.1.256").map((model) => model.slug);
      assert.equal(at256.includes("claude-fable-5-1"), false);
      assert.equal(at256.includes("claude-fable-5"), true);
      assert.equal(at256.includes("claude-opus-5"), true);
    });

    it("keeps the existing Opus/Fable gates", () => {
      const at218 = resolveClaudeModelsForVersion(catalog, "2.1.218").map((model) => model.slug);
      assert.equal(at218.includes("claude-opus-5"), false);
      assert.equal(at218.includes("claude-fable-5"), true);

      const at193 = resolveClaudeModelsForVersion(catalog, "2.1.193").map((model) => model.slug);
      assert.equal(at193.includes("claude-fable-5"), false);
      assert.equal(at193.includes("claude-opus-4-8"), true);

      const at110 = resolveClaudeModelsForVersion(catalog, "2.1.110").map((model) => model.slug);
      assert.equal(at110.includes("claude-opus-4-7"), false);
      assert.equal(at110.includes("claude-opus-4-6"), true);
    });

    it("ungated models stay visible without a version", () => {
      const slugs = resolveClaudeModelsForVersion(catalog, null).map((model) => model.slug);
      assert.equal(slugs.includes("claude-sonnet-5"), true);
      assert.equal(slugs.includes("claude-haiku-4-5"), true);
      assert.equal(slugs.includes("claude-fable-5-1"), false);
    });
  });

  describe("upgrade messages", () => {
    it("names the lowest unmet minimum first", () => {
      assert.equal(
        formatClaudeVersionUpgradeMessage(catalog, "2.1.100"),
        "Claude Code v2.1.100 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
      );
    });

    it("nudges toward Fable 5.1 when it is the only gated model left", () => {
      assert.equal(
        formatClaudeVersionUpgradeMessage(catalog, "2.1.256"),
        "Claude Code v2.1.256 is too old for Claude Fable 5.1. Upgrade to v2.1.257 or newer to access it.",
      );
    });

    it("returns undefined when every model is available", () => {
      assert.equal(formatClaudeVersionUpgradeMessage(catalog, "2.1.257"), undefined);
    });
  });

  describe("alias resolution", () => {
    it("resolves `fable` to Fable 5.1", () => {
      assert.equal(resolveClaudeCatalogModel(catalog, "fable")?.model.slug, "claude-fable-5-1");
    });

    it("prefers exact slugs over aliases", () => {
      assert.equal(
        resolveClaudeCatalogModel(catalog, "claude-fable-5")?.model.slug,
        "claude-fable-5",
      );
    });
  });

  describe("effort normalization", () => {
    it("maps ultracode to xhigh on models that support it", () => {
      for (const model of [
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-5",
        "claude-opus-4-8",
      ]) {
        assert.equal(normalizeClaudeCatalogEffort(catalog, "ultracode", model), "xhigh");
      }
    });

    it("drops ultracode for models without a mapping", () => {
      assert.equal(
        normalizeClaudeCatalogEffort(catalog, "ultracode", "claude-sonnet-5"),
        undefined,
      );
      assert.equal(
        normalizeClaudeCatalogEffort(catalog, "ultracode", "my-custom-model"),
        undefined,
      );
    });

    it("always drops ultrathink", () => {
      assert.equal(normalizeClaudeCatalogEffort(catalog, "ultrathink", "claude-opus-5"), undefined);
      assert.equal(normalizeClaudeCatalogEffort(catalog, "ultrathink", "unknown"), undefined);
    });

    it("maps max to high on Sonnet 4.6 only", () => {
      assert.equal(normalizeClaudeCatalogEffort(catalog, "max", "claude-sonnet-4-6"), "high");
      assert.equal(normalizeClaudeCatalogEffort(catalog, "max", "claude-opus-5"), "max");
    });

    it("passes xhigh through unchanged for Fable 5.1", () => {
      assert.equal(normalizeClaudeCatalogEffort(catalog, "xhigh", "claude-fable-5-1"), "xhigh");
    });

    it("passes plain efforts through for unknown models", () => {
      assert.equal(normalizeClaudeCatalogEffort(catalog, "high", "my-custom-model"), "high");
    });
  });

  describe("context window and api model id", () => {
    it("defaults Fable 5.1 to the 1M window with the [1m] suffix", () => {
      const selection = modelSelection("claude-fable-5-1");
      assert.equal(resolveClaudeCatalogContextWindow(catalog, selection), "1m");
      assert.equal(resolveClaudeCatalogApiModelId(catalog, selection), "claude-fable-5-1[1m]");
    });

    it("honors an explicit 200k selection on Fable 5.1", () => {
      const selection = modelSelection("claude-fable-5-1", { contextWindow: "200k" });
      assert.equal(resolveClaudeCatalogContextWindow(catalog, selection), "200k");
      assert.equal(resolveClaudeCatalogApiModelId(catalog, selection), "claude-fable-5-1");
    });

    it("Fable 5 has no context window option and no suffix", () => {
      const selection = modelSelection("claude-fable-5");
      assert.equal(resolveClaudeCatalogContextWindow(catalog, selection), undefined);
      assert.equal(resolveClaudeCatalogApiModelId(catalog, selection), "claude-fable-5");
    });

    it("keeps the Opus 5 default 1M suffix and Sonnet 5 default 200k", () => {
      assert.equal(
        resolveClaudeCatalogApiModelId(catalog, modelSelection("claude-opus-5")),
        "claude-opus-5[1m]",
      );
      assert.equal(
        resolveClaudeCatalogApiModelId(catalog, modelSelection("claude-sonnet-5")),
        "claude-sonnet-5",
      );
      assert.equal(
        resolveClaudeCatalogApiModelId(
          catalog,
          modelSelection("claude-sonnet-5", { contextWindow: "1m" }),
        ),
        "claude-sonnet-5[1m]",
      );
    });

    it("returns unknown models verbatim", () => {
      assert.equal(
        resolveClaudeCatalogApiModelId(catalog, modelSelection("my-custom-model")),
        "my-custom-model",
      );
    });
  });

  describe("capabilities", () => {
    it("Fable 5.1 exposes the ultracode ladder without fast mode", () => {
      const caps = getClaudeCatalogModelCapabilities(catalog, "claude-fable-5-1");
      const ids = caps.optionDescriptors?.map((descriptor) => descriptor.id);
      assert.deepEqual(ids, ["effort", "contextWindow"]);
      const effort = caps.optionDescriptors?.find((descriptor) => descriptor.id === "effort");
      assert.equal(effort?.type, "select");
      if (effort?.type === "select") {
        assert.deepEqual(
          effort.options.map((option) => option.id),
          ["low", "medium", "high", "xhigh", "max", "ultracode"],
        );
      }
    });

    it("unknown models resolve to empty capabilities", () => {
      const caps = getClaudeCatalogModelCapabilities(catalog, "no-such-model");
      assert.deepEqual(caps.optionDescriptors, []);
    });
  });
});
