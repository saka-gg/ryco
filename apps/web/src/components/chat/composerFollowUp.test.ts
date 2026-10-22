import { describe, expect, it } from "vite-plus/test";

import {
  describeFollowUpInversion,
  describeRunningFollowUp,
  resolveComposerEnter,
  sendRequiresModifier,
} from "./composerFollowUp";

const MAC = "MacIntel";
const WINDOWS = "Win32";

/** Enter with the given modifiers, "mod" being the platform's own (Cmd on Mac, Ctrl elsewhere). */
const enter = (
  platform: string,
  keys: { readonly mod?: boolean; readonly shift?: boolean; readonly ctrl?: boolean } = {},
) => {
  const mac = platform === MAC;
  return {
    metaKey: mac ? keys.mod === true : false,
    ctrlKey: mac ? keys.ctrl === true : keys.mod === true,
    shiftKey: keys.shift === true,
  };
};

describe("sendRequiresModifier", () => {
  it("needs the modifier always, for multiline prompts, or never", () => {
    expect(sendRequiresModifier("enter", "two\nlines")).toBe(false);
    expect(sendRequiresModifier("mod-enter-multiline", "one line")).toBe(false);
    expect(sendRequiresModifier("mod-enter-multiline", "two\nlines")).toBe(true);
    expect(sendRequiresModifier("mod-enter-multiline", "carriage\rreturn")).toBe(true);
    expect(sendRequiresModifier("mod-enter", "")).toBe(true);
  });
});

describe("resolveComposerEnter", () => {
  const resolve = (
    sendShortcut: "enter" | "mod-enter-multiline" | "mod-enter",
    prompt: string,
    keys: Parameters<typeof enter>[1],
    platform = MAC,
  ) => resolveComposerEnter({ event: enter(platform, keys), sendShortcut, prompt, platform });

  it("sends with Enter and inverts with Mod+Enter when Enter sends", () => {
    for (const platform of [MAC, WINDOWS]) {
      expect(resolve("enter", "hi", {}, platform)).toEqual({ invertFollowUp: false });
      expect(resolve("enter", "hi", { mod: true }, platform)).toEqual({ invertFollowUp: true });
      expect(resolve("enter", "hi", { shift: true }, platform)).toBeNull();
      expect(resolve("enter", "hi", { mod: true, shift: true }, platform)).toBeNull();
      expect(resolve("mod-enter-multiline", "one line", {}, platform)).toEqual({
        invertFollowUp: false,
      });
      expect(resolve("mod-enter-multiline", "one line", { mod: true }, platform)).toEqual({
        invertFollowUp: true,
      });
    }
  });

  it("sends with Mod+Enter and inverts with Mod+Shift+Enter when sending needs Mod+Enter", () => {
    for (const platform of [MAC, WINDOWS]) {
      for (const [sendShortcut, prompt] of [
        ["mod-enter", "one line"],
        ["mod-enter-multiline", "two\nlines"],
      ] as const) {
        expect(resolve(sendShortcut, prompt, {}, platform)).toBeNull();
        expect(resolve(sendShortcut, prompt, { shift: true }, platform)).toBeNull();
        expect(resolve(sendShortcut, prompt, { mod: true }, platform)).toEqual({
          invertFollowUp: false,
        });
        expect(resolve(sendShortcut, prompt, { mod: true, shift: true }, platform)).toEqual({
          invertFollowUp: true,
        });
      }
    }
  });

  it("uses Cmd on Mac and Ctrl elsewhere, never both together", () => {
    expect(resolve("enter", "hi", { ctrl: true })).toEqual({ invertFollowUp: false });
    expect(resolve("enter", "hi", { mod: true, ctrl: true })).toEqual({ invertFollowUp: false });
    expect(resolve("mod-enter", "hi", { ctrl: true })).toBeNull();
    expect(resolve("mod-enter", "hi", { mod: true, ctrl: true })).toBeNull();
    expect(
      resolveComposerEnter({
        event: { metaKey: true, ctrlKey: false, shiftKey: false },
        sendShortcut: "mod-enter",
        prompt: "hi",
        platform: WINDOWS,
      }),
    ).toBeNull();
  });
});

describe("describeFollowUpInversion", () => {
  it("names the shortcut the Send shortcut setting leaves for the opposite", () => {
    expect(describeFollowUpInversion("enter", MAC)).toBe("⌘↵ does the opposite.");
    expect(describeFollowUpInversion("enter", WINDOWS)).toBe("Ctrl+Enter does the opposite.");
    expect(describeFollowUpInversion("mod-enter", MAC)).toBe("⇧⌘↵ does the opposite.");
    expect(describeFollowUpInversion("mod-enter", WINDOWS)).toBe(
      "Ctrl+Shift+Enter does the opposite.",
    );
    expect(describeFollowUpInversion("mod-enter-multiline", MAC)).toBe(
      "⌘↵ does the opposite, or ⇧⌘↵ in a multiline prompt.",
    );
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

  it("redirects while approvals wait, whatever the setting, when the redirect applies", () => {
    for (const followUpBehavior of ["queue", "steer"] as const) {
      expect(
        describeRunningFollowUp({
          followUpBehavior,
          steerUnavailableReason: null,
          surfaceAllowsSteer: true,
          approvalRedirect: "decline",
          platform: MAC,
        }),
      ).toEqual({
        effective: "steer",
        placeholder: "Send a message to decline and redirect · ⌘↵ to queue instead",
        redirectsApproval: true,
      });
    }
    // No redirect (an approval being answered, one of an ended runtime): the setting decides.
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        approvalRedirect: "none",
        platform: MAC,
      }),
    ).toEqual({ effective: "queue", placeholder: "Queue a follow-up · ⌘↵ to steer" });
    expect(
      describeRunningFollowUp({
        followUpBehavior: "steer",
        steerUnavailableReason: "This provider cannot steer.",
        surfaceAllowsSteer: true,
        approvalRedirect: "decline",
        platform: MAC,
      }),
    ).toEqual({ effective: "queue", placeholder: "Queue a follow-up · steering unavailable" });
  });

  it("steers after an earlier redirect declined without sending", () => {
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        approvalRedirect: "steer",
        platform: MAC,
      }),
    ).toEqual({ effective: "steer", placeholder: "Steer this turn · ⌘↵ to queue instead" });
  });

  it("names Mod+Shift+Enter when sending needs Mod+Enter", () => {
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        sendShortcut: "mod-enter",
        platform: MAC,
      }).placeholder,
    ).toBe("Queue a follow-up · ⇧⌘↵ to steer");
    expect(
      describeRunningFollowUp({
        followUpBehavior: "steer",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        sendShortcut: "mod-enter",
        platform: WINDOWS,
      }).placeholder,
    ).toBe("Steer this turn · Ctrl+Shift+Enter to queue instead");
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        approvalRedirect: "decline",
        sendShortcut: "mod-enter",
        platform: MAC,
      }).placeholder,
    ).toBe("Send a message to decline and redirect · ⇧⌘↵ to queue instead");
    // The placeholder shows in an empty composer: one line, where Mod+Enter still inverts.
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        sendShortcut: "mod-enter-multiline",
        platform: MAC,
      }).placeholder,
    ).toBe("Queue a follow-up · ⌘↵ to steer");
  });
});
