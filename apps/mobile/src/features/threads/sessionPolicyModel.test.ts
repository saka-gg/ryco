import { describe, expect, it } from "vite-plus/test";

import { buildSessionPolicyModel, resolveSessionPolicySelection } from "./sessionPolicyModel";
import {
  CAUTION_RUNTIME_MODE,
  interactionModeConfig,
  runtimeModeConfig,
} from "./sessionPolicyPresentation";

function build(overrides: Partial<Parameters<typeof buildSessionPolicyModel>[0]> = {}) {
  return buildSessionPolicyModel({
    runtimeMode: "approval-required",
    interactionMode: "default",
    interactionModeSupported: true,
    askModeSupported: true,
    ...overrides,
  });
}

describe("session policy vocabulary", () => {
  it("matches the web labels verbatim, including the two that differ", () => {
    // The one entry where the sheet label and the pill label are not the same.
    expect(runtimeModeConfig["auto-accept-edits"].label).toBe("Auto-accept edits");
    expect(runtimeModeConfig["auto-accept-edits"].triggerLabel).toBe("Auto-accept");
    // The enum value is `default`; the word the user sees is "Build", not "Chat".
    expect(interactionModeConfig.default.label).toBe("Build");
  });

  it("marks full access as the caution mode and nothing else", () => {
    expect(CAUTION_RUNTIME_MODE).toBe("full-access");
    expect(runtimeModeConfig["full-access"].tone).toBe("caution");
    expect(runtimeModeConfig["approval-required"].tone).toBe("default");
    expect(runtimeModeConfig["auto-accept-edits"].tone).toBe("default");
    // Auto still stops for the risky calls, so it is not the caution mode.
    expect(runtimeModeConfig.auto.tone).toBe("default");
  });

  it("keeps declaration order as display order", () => {
    expect(build().access.segments.map((segment) => segment.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(build().mode?.segments.map((segment) => segment.value)).toEqual([
      "default",
      "plan",
      "ask",
    ]);
  });
});

describe("session policy model", () => {
  it("shows the short trigger label on the pill, not the full label", () => {
    const model = build({ runtimeMode: "auto-accept-edits" });
    expect(model.pillLabel).toBe("Auto-accept");
    expect(model.access.segments[1]?.label).toBe("Auto-accept edits");
  });

  it("gives every segment a short label rather than the full one", () => {
    const model = build();
    // "Auto-accept edits" does not survive a segment's share of a phone's
    // width; the short form is what the segment renders. Access is four-up
    // since `auto` joined it, so the budget here is tighter than the other
    // groups' three.
    expect(model.access.segments.map((segment) => segment.shortLabel)).toEqual([
      "Supervised",
      "Auto-accept",
      "Auto",
      "Full access",
    ]);
    // The full label survives for screen readers.
    expect(model.access.segments[1]?.label).toBe("Auto-accept edits");
    for (const segment of [...model.access.segments, ...(model.mode?.segments ?? [])]) {
      expect(segment.shortLabel.length).toBeLessThanOrEqual(11);
    }
  });

  it("carries the caution tone onto the pill when full access is selected", () => {
    expect(build({ runtimeMode: "full-access" }).pillTone).toBe("caution");
    expect(build({ runtimeMode: "approval-required" }).pillTone).toBe("default");
  });

  it("marks exactly one segment selected per group", () => {
    const model = build({ runtimeMode: "full-access", interactionMode: "plan" });
    expect(model.access.segments.filter((segment) => segment.selected).map((s) => s.value)).toEqual(
      ["full-access"],
    );
    expect(model.mode?.segments.filter((segment) => segment.selected).map((s) => s.value)).toEqual([
      "plan",
    ]);
  });

  it("hides the whole Mode group when the provider opts out", () => {
    expect(build({ interactionModeSupported: false }).mode).toBeNull();
    // Access is never hidden — every provider has a runtime mode.
    expect(build({ interactionModeSupported: false }).access.segments).toHaveLength(4);
  });

  it("disables only Ask when the provider does not support it, and says why", () => {
    const model = build({ askModeSupported: false });
    const ask = model.mode?.segments.find((segment) => segment.value === "ask");
    expect(ask?.disabled).toBe(true);
    expect(ask?.disabledReason).toBe("This provider does not support Ask mode.");
    expect(model.mode?.segments.find((segment) => segment.value === "plan")?.disabled).toBe(false);
    expect(model.access.segments.every((segment) => !segment.disabled)).toBe(true);
  });

  it("disables only Auto when the model cannot run it, and says why", () => {
    const reason = "Claude Opus 4.8 can't run in Auto mode on this provider.";
    const model = build({ autoModeUnavailableReason: reason });
    const auto = model.access.segments.find((segment) => segment.value === "auto");
    expect(auto?.disabled).toBe(true);
    expect(auto?.disabledReason).toBe(reason);
    expect(
      model.access.segments
        .filter((segment) => segment.value !== "auto")
        .every((segment) => !segment.disabled && segment.disabledReason === null),
    ).toBe(true);
    expect(model.readOnly).toBe(false);
    // Already in Auto: the segment stays selected, disabled, and explained.
    const selected = build({ runtimeMode: "auto", autoModeUnavailableReason: reason });
    expect(selected.access.segments.find((segment) => segment.value === "auto")).toMatchObject({
      selected: true,
      disabled: true,
      disabledReason: reason,
    });
  });

  it("keeps Auto enabled without a reason", () => {
    for (const model of [
      build(),
      build({ autoModeUnavailableReason: null }),
      build({ autoModeUnavailableReason: "  " }),
    ]) {
      expect(model.access.segments.find((segment) => segment.value === "auto")).toMatchObject({
        disabled: false,
        disabledReason: null,
      });
    }
  });

  it("lets the blocked reason win over the narrower Auto reason", () => {
    const model = build({
      autoModeUnavailableReason: "No Auto.",
      mutationBlockedReason: "Offline.",
    });
    expect(model.access.segments.find((segment) => segment.value === "auto")?.disabledReason).toBe(
      "Offline.",
    );
  });

  it("disables every segment with the given reason when mutation is blocked", () => {
    const model = build({ mutationBlockedReason: "Reconnecting to the node." });
    expect(model.readOnly).toBe(true);
    expect(model.readOnlyReason).toBe("Reconnecting to the node.");
    for (const segment of [...model.access.segments, ...(model.mode?.segments ?? [])]) {
      expect(segment.disabled).toBe(true);
      expect(segment.disabledReason).toBe("Reconnecting to the node.");
    }
  });

  it("lets the blocked reason win over the narrower ask reason", () => {
    const model = build({ askModeSupported: false, mutationBlockedReason: "Offline." });
    expect(model.mode?.segments.find((segment) => segment.value === "ask")?.disabledReason).toBe(
      "Offline.",
    );
  });

  it("treats a whitespace-only blocked reason as not blocked", () => {
    const model = build({ mutationBlockedReason: "   " });
    expect(model.readOnly).toBe(false);
    expect(model.access.segments.every((segment) => !segment.disabled)).toBe(true);
  });

  it("names both current values for screen readers, and omits Mode when hidden", () => {
    expect(
      build({ runtimeMode: "full-access", interactionMode: "plan" }).pillAccessibilityLabel,
    ).toBe("Session policy. Access: Full access. Mode: Plan.");
    expect(
      build({ runtimeMode: "full-access", interactionModeSupported: false }).pillAccessibilityLabel,
    ).toBe("Session policy. Access: Full access.");
  });
});

describe("resolveSessionPolicySelection", () => {
  it("returns the value for an enabled, unselected segment", () => {
    const model = build({ runtimeMode: "approval-required" });
    expect(resolveSessionPolicySelection(model.access, "full-access")).toBe("full-access");
  });

  it("ignores a tap on the already-selected segment", () => {
    const model = build({ runtimeMode: "approval-required" });
    expect(resolveSessionPolicySelection(model.access, "approval-required")).toBeNull();
  });

  it("ignores a tap on a disabled segment", () => {
    const blocked = build({ mutationBlockedReason: "Offline." });
    expect(resolveSessionPolicySelection(blocked.access, "full-access")).toBeNull();

    const noAsk = build({ askModeSupported: false });
    expect(noAsk.mode && resolveSessionPolicySelection(noAsk.mode, "ask")).toBeNull();

    const noAuto = build({ autoModeUnavailableReason: "No Auto." });
    expect(resolveSessionPolicySelection(noAuto.access, "auto")).toBeNull();
  });

  it("ignores a value that is not in the group", () => {
    const model = build();
    expect(resolveSessionPolicySelection(model.access, "nonsense" as never)).toBeNull();
  });
});
