import { describe, expect, it } from "vite-plus/test";

import {
  describeRunningFollowUp,
  effectiveSendShortcut,
  followUpInvertShortcutLabel,
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

describe("effectiveSendShortcut", () => {
  it("keeps Enter sending only on the phone tier without a mouse or trackpad", () => {
    expect(effectiveSendShortcut("mod-enter", { phoneTier: true, finePointer: false })).toBe(
      "enter",
    );
    // A narrow desktop window is the phone tier too, but it has a keyboard and a pointer.
    expect(effectiveSendShortcut("mod-enter", { phoneTier: true, finePointer: true })).toBe(
      "mod-enter",
    );
    // A tablet in the desktop layout offers the setting, so it holds.
    expect(
      effectiveSendShortcut("mod-enter-multiline", { phoneTier: false, finePointer: false }),
    ).toBe("mod-enter-multiline");
    expect(effectiveSendShortcut("mod-enter", { phoneTier: false, finePointer: true })).toBe(
      "mod-enter",
    );
  });
});

describe("resolveComposerEnter", () => {
  const resolve = (
    sendShortcut: "enter" | "mod-enter-multiline" | "mod-enter",
    prompt: string,
    keys: Parameters<typeof enter>[1],
    platform = MAC,
  ) => resolveComposerEnter({ event: enter(platform, keys), sendShortcut, prompt, platform });

  it("sends with Enter and inverts with Mod+Enter under the Enter setting", () => {
    for (const platform of [MAC, WINDOWS]) {
      for (const prompt of ["hi", "two\nlines"]) {
        expect(resolve("enter", prompt, {}, platform)).toEqual({ invertFollowUp: false });
        expect(resolve("enter", prompt, { mod: true }, platform)).toEqual({
          invertFollowUp: true,
        });
        expect(resolve("enter", prompt, { shift: true }, platform)).toBeNull();
        expect(resolve("enter", prompt, { mod: true, shift: true }, platform)).toBeNull();
      }
    }
  });

  it("sends with Mod+Enter and inverts with Mod+Shift+Enter under either Mod+Enter option", () => {
    for (const platform of [MAC, WINDOWS]) {
      for (const [sendShortcut, prompt] of [
        ["mod-enter", "one line"],
        ["mod-enter", "two\nlines"],
        ["mod-enter-multiline", "one line"],
        ["mod-enter-multiline", "two\nlines"],
      ] as const) {
        expect(resolve(sendShortcut, prompt, { shift: true }, platform)).toBeNull();
        // The shortcuts mean the same whatever the prompt's length, so a hint stays right.
        expect(resolve(sendShortcut, prompt, { mod: true }, platform)).toEqual({
          invertFollowUp: false,
        });
        expect(resolve(sendShortcut, prompt, { mod: true, shift: true }, platform)).toEqual({
          invertFollowUp: true,
        });
      }
      expect(resolve("mod-enter", "one line", {}, platform)).toBeNull();
      expect(resolve("mod-enter-multiline", "two\nlines", {}, platform)).toBeNull();
      // Enter still sends a one-line prompt under the multiline option.
      expect(resolve("mod-enter-multiline", "one line", {}, platform)).toEqual({
        invertFollowUp: false,
      });
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

describe("followUpInvertShortcutLabel", () => {
  it("names one shortcut per Send shortcut setting", () => {
    expect(followUpInvertShortcutLabel("enter", MAC)).toBe("⌘↵");
    expect(followUpInvertShortcutLabel("enter", WINDOWS)).toBe("Ctrl+Enter");
    for (const sendShortcut of ["mod-enter", "mod-enter-multiline"] as const) {
      expect(followUpInvertShortcutLabel(sendShortcut, MAC)).toBe("⇧⌘↵");
      expect(followUpInvertShortcutLabel(sendShortcut, WINDOWS)).toBe("Ctrl+Shift+Enter");
    }
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

  it("names Mod+Shift+Enter under either Mod+Enter option", () => {
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
    // Under the multiline option too: Mod+Enter sends a multiline prompt as it is.
    expect(
      describeRunningFollowUp({
        followUpBehavior: "queue",
        steerUnavailableReason: null,
        surfaceAllowsSteer: true,
        approvalRedirect: "decline",
        sendShortcut: "mod-enter-multiline",
        platform: MAC,
      }).placeholder,
    ).toBe("Send a message to decline and redirect · ⇧⌘↵ to queue instead");
  });
});
