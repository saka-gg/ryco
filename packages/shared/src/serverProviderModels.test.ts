import type { ServerProviderModel } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findServerProviderModel } from "./serverProviderModels.ts";

const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: null,
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    aliases: ["opus", "claude-opus-4-8-20260101"],
    isCustom: false,
    capabilities: null,
  },
  // A custom model whose slug equals another model's alias: the slug wins.
  { slug: "Opus", name: "My Opus", isCustom: true, capabilities: null },
];

describe("findServerProviderModel", () => {
  it("finds a model by slug or alias, case-insensitively", () => {
    expect(findServerProviderModel(models, "claude-opus-5-5")?.name).toBe("Claude Opus 5.5");
    expect(findServerProviderModel(models, " CLAUDE-OPUS-4-8-20260101 ")?.name).toBe(
      "Claude Opus 4.8",
    );
  });

  it("prefers a slug match over an alias match", () => {
    expect(findServerProviderModel(models, "opus")?.name).toBe("My Opus");
  });

  it("finds nothing for an unknown or empty selection", () => {
    expect(findServerProviderModel(models, "claude-unknown")).toBeUndefined();
    expect(findServerProviderModel(models, "  ")).toBeUndefined();
    expect(findServerProviderModel(models, null)).toBeUndefined();
    expect(findServerProviderModel(models, undefined)).toBeUndefined();
  });
});
