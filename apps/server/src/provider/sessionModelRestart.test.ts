import { type ModelSelection, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelSelectionChangeRestartsSession } from "./sessionModelRestart.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const selection = (
  options?: ModelSelection["options"],
  model = "claude-opus-4-6",
  instanceId = claude,
): ModelSelection => ({ instanceId, model, ...(options !== undefined ? { options } : {}) });

const restarts = (
  previous: ModelSelection | undefined,
  requested: ModelSelection | undefined,
  driver: string | null = "claudeAgent",
) => modelSelectionChangeRestartsSession({ driver, previous, requested });

describe("modelSelectionChangeRestartsSession", () => {
  it("keeps a Claude session whose selection changes only Fast mode", () => {
    expect(restarts(selection(), selection([{ id: "fastMode", value: true }]))).toBe(false);
    expect(
      restarts(
        selection([
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        selection([
          { id: "effort", value: "high" },
          { id: "fastMode", value: false },
        ]),
      ),
    ).toBe(false);
    expect(restarts(selection([{ id: "fastMode", value: true }]), selection([]))).toBe(false);
  });

  it("restarts a Claude session for any other change, Fast mode with it or not", () => {
    for (const requested of [
      selection(undefined, "claude-sonnet-4-6"),
      selection([{ id: "effort", value: "low" }]),
      selection([{ id: "thinking", value: false }]),
      selection([{ id: "contextWindow", value: "1m" }]),
      selection(undefined, "claude-opus-4-6", ProviderInstanceId.make("claude_work")),
      selection(
        [
          { id: "effort", value: "low" },
          { id: "fastMode", value: true },
        ],
        "claude-opus-4-6",
      ),
    ]) {
      expect(restarts(selection(), requested)).toBe(true);
    }
    // Nothing applied yet: the session cannot be known to match.
    expect(restarts(undefined, selection())).toBe(true);
  });

  it("restarts nothing without a requested selection, or on other drivers", () => {
    expect(restarts(selection(), undefined)).toBe(false);
    expect(restarts(selection(), selection())).toBe(false);
    expect(restarts(selection(), selection(undefined, "gpt-5.5"), "codex")).toBe(false);
    expect(restarts(selection(), selection(undefined, "gpt-5.5"), null)).toBe(false);
  });
});
