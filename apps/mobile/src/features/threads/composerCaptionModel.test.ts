import { describe, expect, it } from "vite-plus/test";

import {
  composerAccessGlyph,
  composerCaptionLabel,
  composerEffortControl,
  composerModeGlyph,
  composerPrimaryAction,
} from "./composerCaptionModel";
import { buildSessionPolicyModel } from "./sessionPolicyModel";

const policy = (
  runtimeMode: "approval-required" | "auto" | "full-access",
  mode: "default" | "plan",
) =>
  buildSessionPolicyModel({
    runtimeMode,
    interactionMode: mode,
    interactionModeSupported: true,
    askModeSupported: false,
  });

describe("composer caption", () => {
  it("shows a lock, or an amber bolt for Full access", () => {
    expect(composerAccessGlyph(policy("approval-required", "default"))).toEqual({
      icon: "lock",
      caution: false,
    });
    expect(composerAccessGlyph(policy("auto", "default")).icon).toBe("lock");
    expect(composerAccessGlyph(policy("full-access", "default"))).toEqual({
      icon: "bolt.fill",
      caution: true,
    });
  });

  it("shows the selected mode, Plan marked", () => {
    expect(composerModeGlyph(policy("auto", "default"))).toEqual({
      icon: "hammer",
      label: "Build",
      plan: false,
    });
    expect(composerModeGlyph(policy("auto", "plan"))?.plan).toBe(true);
    expect(
      composerModeGlyph(
        buildSessionPolicyModel({
          runtimeMode: "auto",
          interactionMode: "default",
          interactionModeSupported: false,
          askModeSupported: false,
        }),
      ),
    ).toBeNull();
  });

  it("names the model and its effort", () => {
    expect(composerCaptionLabel({ pillLabel: "Opus 5.5", pillReasoningLabel: "High" })).toBe(
      "Opus 5.5 · High",
    );
    expect(composerCaptionLabel({ pillLabel: "GPT-5.6", pillReasoningLabel: null })).toBe(
      "GPT-5.6",
    );
  });

  it("finds the effort select among the model's options", () => {
    const effort = {
      id: "effort",
      label: "Effort",
      kind: "select" as const,
      choices: [],
      enabled: false,
    };
    const fast = {
      id: "fast",
      label: "Fast",
      kind: "boolean" as const,
      choices: [],
      enabled: true,
    };
    expect(composerEffortControl({ options: [fast, effort] })).toBe(effort);
    expect(composerEffortControl({ options: [fast] })).toBeNull();
  });

  it("ends the capsule with send, stop or the mic", () => {
    expect(
      composerPrimaryAction({ dictating: false, hasContent: true, running: true, canStop: true }),
    ).toBe("send");
    expect(
      composerPrimaryAction({ dictating: false, hasContent: false, running: true, canStop: true }),
    ).toBe("stop");
    expect(
      composerPrimaryAction({ dictating: false, hasContent: false, running: true, canStop: false }),
    ).toBe("mic");
    expect(
      composerPrimaryAction({ dictating: false, hasContent: false, running: false, canStop: true }),
    ).toBe("mic");
    expect(
      composerPrimaryAction({ dictating: true, hasContent: true, running: true, canStop: true }),
    ).toBe("mic");
  });
});
