import { ProviderDriverKind, type ServerProviderUpdateRequiredModel } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredNotice.ts";

const OPUS_5 = { slug: "claude-opus-5", name: "Claude Opus 5", minVersion: "2.1.219" };
const FABLE_5_1 = { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" };

function claude(updateRequiredModels?: ReadonlyArray<ServerProviderUpdateRequiredModel>) {
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude Hub",
    ...(updateRequiredModels ? { updateRequiredModels } : {}),
  };
}

describe("formatProviderUpdateRequiredNotice", () => {
  it("names the update that unlocks every listed model", () => {
    expect(formatProviderUpdateRequiredNotice(claude([OPUS_5, FABLE_5_1]))).toBe(
      "Update Claude Code to v2.1.257 or newer to use Claude Opus 5 and Claude Fable 5.1.",
    );
  });

  it("returns null when the snapshot lists none", () => {
    expect(formatProviderUpdateRequiredNotice(claude())).toBeNull();
    expect(formatProviderUpdateRequiredNotice(claude([]))).toBeNull();
  });

  it("limits the notice to models the search matches by name or slug", () => {
    const provider = claude([OPUS_5, FABLE_5_1]);

    expect(formatProviderUpdateRequiredNotice(provider, "  FABLE ")).toBe(
      "Update Claude Code to v2.1.257 or newer to use Claude Fable 5.1.",
    );
    expect(formatProviderUpdateRequiredNotice(provider, "opus-5")).toBe(
      "Update Claude Code to v2.1.219 or newer to use Claude Opus 5.",
    );
    expect(formatProviderUpdateRequiredNotice(provider, "sonnet")).toBeNull();
    expect(formatProviderUpdateRequiredNotice(provider, "   ")).toBe(
      formatProviderUpdateRequiredNotice(provider),
    );
  });

  it("takes the highest minimum among the matches from the server's ascending order", () => {
    const provider = claude([
      OPUS_5,
      { slug: "claude-opus-5-9", name: "Claude Opus 5.9", minVersion: "2.1.240" },
      FABLE_5_1,
    ]);

    expect(formatProviderUpdateRequiredNotice(provider, "opus")).toBe(
      "Update Claude Code to v2.1.240 or newer to use Claude Opus 5 and Claude Opus 5.9.",
    );
  });

  it("joins three names with commas and folds the rest into a count", () => {
    const model = (index: number) => ({
      slug: `model-${index}`,
      name: `Model ${index}`,
      minVersion: `1.${index}.0`,
    });

    expect(formatProviderUpdateRequiredNotice(claude([1, 2, 3].map(model)))).toBe(
      "Update Claude Code to v1.3.0 or newer to use Model 1, Model 2, and Model 3.",
    );
    expect(formatProviderUpdateRequiredNotice(claude([1, 2, 3, 4, 5].map(model)))).toBe(
      "Update Claude Code to v1.5.0 or newer to use Model 1, Model 2, Model 3, and 2 more.",
    );
  });

  it("names the CLI to update, falling back to the instance name and then the driver", () => {
    const models = [{ ...OPUS_5, minVersion: "v0.9.0" }];

    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("codex"),
        updateRequiredModels: models,
      }),
    ).toBe("Update the Codex CLI to v0.9.0 or newer to use Claude Opus 5.");
    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("opencode"),
        displayName: "OpenCode Work",
        updateRequiredModels: models,
      }),
    ).toBe("Update OpenCode Work to v0.9.0 or newer to use Claude Opus 5.");
    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("opencode"),
        updateRequiredModels: models,
      }),
    ).toBe("Update opencode to v0.9.0 or newer to use Claude Opus 5.");
  });
});
