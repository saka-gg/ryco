import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { ClientSettingsSchema } from "@ryco/contracts/settings";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadNotificationKind } from "../threads/threadNotifications.ts";
import {
  planThreadAlert,
  THREAD_ALERT_COPY,
  THREAD_NOTIFICATION_MODE_OPTIONS,
  threadNotificationModeOf,
  threadNotificationModePatch,
  threadNotificationTag,
  type ThreadAlertPlanInput,
} from "./threadNotificationPreferences.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

function ref(environmentId: string, threadId: string) {
  return { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) };
}

describe("thread notification mode", () => {
  it("stores every mode in the two switches and reads it back", () => {
    for (const { value } of THREAD_NOTIFICATION_MODE_OPTIONS) {
      expect(threadNotificationModeOf(threadNotificationModePatch(value))).toBe(value);
    }
    expect(threadNotificationModePatch("sound")).toEqual({
      notifyOnTurnCompleteWhenUnfocused: false,
      threadNotificationSound: true,
    });
  });

  it("reads settings saved with only the desktop switch as notifications or off", () => {
    expect(threadNotificationModeOf(decodeClientSettings({}))).toBe("notifications");
    expect(
      threadNotificationModeOf(decodeClientSettings({ notifyOnTurnCompleteWhenUnfocused: true })),
    ).toBe("notifications");
    expect(
      threadNotificationModeOf(decodeClientSettings({ notifyOnTurnCompleteWhenUnfocused: false })),
    ).toBe("off");
  });
});

describe("threadNotificationTag", () => {
  it("is a stable 16-character hex hash of the environment and thread", () => {
    const tag = threadNotificationTag(ref("environment-a", "thread-1"));
    expect(tag).toMatch(/^[0-9a-f]{16}$/u);
    expect(threadNotificationTag(ref("environment-a", "thread-1"))).toBe(tag);
    expect(threadNotificationTag(ref("environment-b", "thread-1"))).not.toBe(tag);
    expect(threadNotificationTag(ref("environment-a", "thread-2"))).not.toBe(tag);
  });

  it("is FNV-1a 64 over environment:thread", () => {
    expect(threadNotificationTag(ref("a", "b"))).toBe("e661911904a01160");
  });
});

describe("THREAD_ALERT_COPY", () => {
  it("plays the completion sound only for finished threads", () => {
    expect(
      Object.entries(THREAD_ALERT_COPY)
        .filter(([, copy]) => copy.sound === "completion")
        .map(([kind]) => kind),
    ).toEqual(["completed"]);
  });
});

describe("planThreadAlert", () => {
  const base: ThreadAlertPlanInput = {
    mode: "notifications-and-sound",
    toasts: true,
    appFocused: true,
    threadVisible: false,
    kind: "completed",
    delegated: false,
  };

  it("toasts and sounds while Ryco is in front and the thread is elsewhere", () => {
    expect(planThreadAlert(base)).toEqual({
      sound: true,
      toast: true,
      system: false,
      badge: false,
    });
  });

  it("stays quiet about the thread you are looking at", () => {
    expect(planThreadAlert({ ...base, threadVisible: true })).toEqual({
      sound: false,
      toast: false,
      system: false,
      badge: false,
    });
  });

  it("notifies, badges and sounds while Ryco is in the background", () => {
    for (const threadVisible of [false, true]) {
      expect(planThreadAlert({ ...base, appFocused: false, threadVisible })).toEqual({
        sound: true,
        toast: false,
        system: true,
        badge: true,
      });
    }
  });

  it("follows the mode and the toast switch", () => {
    const background = { ...base, appFocused: false };
    expect(planThreadAlert({ ...background, mode: "off" })).toMatchObject({
      sound: false,
      system: false,
      badge: false,
    });
    expect(planThreadAlert({ ...background, mode: "notifications" })).toMatchObject({
      sound: false,
      system: true,
    });
    expect(planThreadAlert({ ...background, mode: "sound" })).toMatchObject({
      sound: true,
      system: false,
      badge: false,
    });
    expect(planThreadAlert({ ...base, mode: "off" }).toast).toBe(true);
    expect(planThreadAlert({ ...base, toasts: false }).toast).toBe(false);
  });

  it("alerts for a delegated thread only when it waits for you", () => {
    const delivered = (kind: ThreadNotificationKind) =>
      Object.values(planThreadAlert({ ...base, delegated: true, kind })).some(Boolean);
    expect(delivered("approval")).toBe(true);
    expect(delivered("input")).toBe(true);
    expect(delivered("plan-ready")).toBe(false);
    expect(delivered("completed")).toBe(false);
    expect(delivered("failed")).toBe(false);
  });
});
