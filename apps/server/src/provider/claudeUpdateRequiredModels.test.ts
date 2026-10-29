import { assert, describe, it } from "@effect/vitest";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeCatalogModel,
  type ClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";
import { resolveClaudeUpdateRequiredModels } from "./claudeUpdateRequiredModels.ts";

const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;

function catalogModel(
  slug: string,
  name: string,
  compatibility: ClaudeCatalogModel["compatibility"],
  isLegacy?: boolean,
): ClaudeCatalogModel {
  return {
    model: { slug, name, isCustom: false, capabilities: null, ...(isLegacy ? { isLegacy } : {}) },
    runtime: {},
    compatibility,
  };
}

describe("resolveClaudeUpdateRequiredModels", () => {
  it("lists nothing when the probe could not parse a version", () => {
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, null), []);
  });

  it("lists gated current models in ascending minimum-version order", () => {
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "2.1.218"), [
      { slug: "claude-opus-5", name: "Claude Opus 5", minVersion: "2.1.219" },
      { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" },
    ]);
  });

  it("leaves out legacy models the CLI is also too old for", () => {
    const slugs = resolveClaudeUpdateRequiredModels(catalog, "2.1.100").map((model) => model.slug);

    assert.deepStrictEqual(slugs, ["claude-opus-5", "claude-fable-5-1"]);
    for (const legacy of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      assert.equal(slugs.includes(legacy), false, legacy);
    }
  });

  it("lists nothing once the CLI meets every minimum", () => {
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "2.1.257"), []);
  });

  it("never lists a model blocked only by a maximum, which an update cannot fix", () => {
    const capped: ClaudeModelCatalog = {
      models: [
        catalogModel("claude-retired", "Claude Retired", { maxVersionExclusive: "2.1.0" }),
        catalogModel("claude-window", "Claude Window", {
          minVersion: "1.0.0",
          maxVersionExclusive: "2.1.0",
        }),
      ],
    };

    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(capped, "2.2.0"), []);
  });

  it("orders equal minimums by name", () => {
    const tied: ClaudeModelCatalog = {
      models: [
        catalogModel("claude-zeta", "Zeta", { minVersion: "3.0.0" }),
        catalogModel("claude-alpha", "Alpha", { minVersion: "3.0.0" }),
        catalogModel("claude-beta", "Beta", { minVersion: "2.10.0" }),
        catalogModel("claude-old", "Old", { minVersion: "3.0.0" }, true),
      ],
    };

    assert.deepStrictEqual(
      resolveClaudeUpdateRequiredModels(tied, "2.9.0").map((model) => model.slug),
      ["claude-beta", "claude-alpha", "claude-zeta"],
    );
  });
});
