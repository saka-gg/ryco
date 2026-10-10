import { ProviderInstanceId } from "@ryco/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vite-plus/test";

import { codexServiceTierForSelection, codexSpeedOptionDescriptors } from "./CodexServiceTier.ts";

function catalogModel(
  tiers: Pick<CodexSchema.V2ModelListResponse__Model, "serviceTiers" | "additionalSpeedTiers">,
): CodexSchema.V2ModelListResponse__Model {
  return {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "gpt-6-astra",
    description: "",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    ...tiers,
  };
}

const tier = (id: string, name: string) => ({ id, name, description: "" });

function selection(options: ReadonlyArray<{ id: string; value: boolean }>) {
  return { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra", options };
}

describe("codexSpeedOptionDescriptors", () => {
  it("reads Fast from the current `priority` tier and Ultrafast alongside it", () => {
    const ids = codexSpeedOptionDescriptors(
      catalogModel({ serviceTiers: [tier("priority", "Fast"), tier("ultrafast", "Ultrafast")] }),
    ).map((descriptor) => descriptor.id);
    expect(ids).toEqual(["fastMode", "ultrafastMode"]);
  });

  it("still reads Fast from the deprecated speed tier list", () => {
    const ids = codexSpeedOptionDescriptors(catalogModel({ additionalSpeedTiers: ["fast"] })).map(
      (descriptor) => descriptor.id,
    );
    expect(ids).toEqual(["fastMode"]);
  });

  it("offers Ultrafast on its own when it is the only tier", () => {
    const ids = codexSpeedOptionDescriptors(
      catalogModel({ serviceTiers: [tier("ultrafast", "Ultrafast")] }),
    ).map((descriptor) => descriptor.id);
    expect(ids).toEqual(["ultrafastMode"]);
  });

  it("offers nothing without speed tiers", () => {
    expect(codexSpeedOptionDescriptors(catalogModel({}))).toEqual([]);
  });
});

describe("codexServiceTierForSelection", () => {
  it("maps each speed option to the tier a turn requests, Ultrafast first", () => {
    expect(codexServiceTierForSelection(selection([]))).toBeUndefined();
    expect(codexServiceTierForSelection(selection([{ id: "fastMode", value: true }]))).toBe("fast");
    expect(codexServiceTierForSelection(selection([{ id: "ultrafastMode", value: true }]))).toBe(
      "ultrafast",
    );
    expect(
      codexServiceTierForSelection(
        selection([
          { id: "fastMode", value: true },
          { id: "ultrafastMode", value: true },
        ]),
      ),
    ).toBe("ultrafast");
    expect(codexServiceTierForSelection(null)).toBeUndefined();
  });
});
