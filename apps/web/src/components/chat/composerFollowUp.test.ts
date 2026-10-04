import { describe, expect, it } from "vite-plus/test";

import { describeRunningFollowUp, isFollowUpInvertModifier } from "./composerFollowUp";

const MAC = "MacIntel";
const WINDOWS = "Win32";

describe("isFollowUpInvertModifier", () => {
  it("uses Cmd on Mac and Ctrl elsewhere, never both together", () => {
    expect(isFollowUpInvertModifier({ metaKey: true, ctrlKey: false }, MAC)).toBe(true);
    expect(isFollowUpInvertModifier({ metaKey: false, ctrlKey: true }, MAC)).toBe(false);
    expect(isFollowUpInvertModifier({ metaKey: true, ctrlKey: true }, MAC)).toBe(false);
    expect(isFollowUpInvertModifier({ metaKey: false, ctrlKey: true }, WINDOWS)).toBe(true);
    expect(isFollowUpInvertModifier({ metaKey: true, ctrlKey: false }, WINDOWS)).toBe(false);
    expect(isFollowUpInvertModifier({ metaKey: true, ctrlKey: true }, WINDOWS)).toBe(false);
    expect(isFollowUpInvertModifier({ metaKey: false, ctrlKey: false }, WINDOWS)).toBe(false);
  });
});

describe("describeRunningFollowUp", () => {
  const describe_ = (
    followUpBehavior: "queue" | "steer",
    steerUnavailableReason: string | null,
    platform = MAC,
  ) =>
    describeRunningFollowUp({
      followUpBehavior,
      steerUnavailableReason,
      surfaceAllowsSteer: true,
      platform,
    });

  it("shows the effective action and the alternate shortcut", () => {
    expect(describe_("steer", null)).toEqual({
      effective: "steer",
      placeholder: "Steer this turn · ⌘↵ to queue instead",
    });
    expect(describe_("queue", null)).toEqual({
      effective: "queue",
      placeholder: "Queue a follow-up · ⌘↵ to steer",
    });
    expect(describe_("queue", null, WINDOWS).placeholder).toBe(
      "Queue a follow-up · Ctrl+Enter to steer",
    );
  });

  it("falls back to queueing when steering is unavailable", () => {
    expect(describe_("steer", "This provider does not support active-turn steering.")).toEqual({
      effective: "queue",
      placeholder: "Queue a follow-up · steering unavailable",
    });
    expect(describe_("queue", "Not running.")).toEqual({
      effective: "queue",
      placeholder: "Queue a follow-up",
    });
  });

  it("shows no hint on the phone tier", () => {
    expect(
      describeRunningFollowUp({
        followUpBehavior: "steer",
        steerUnavailableReason: null,
        surfaceAllowsSteer: false,
        platform: MAC,
      }),
    ).toEqual({ effective: "queue", placeholder: null });
  });
});
