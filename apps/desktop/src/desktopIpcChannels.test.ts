import { describe, expect, it } from "vite-plus/test";

import * as Channels from "./desktopIpcChannels.ts";
import { DESKTOP_WORKSPACE_IPC } from "./desktopWorkspaceChannels.ts";
import { PASTE_AS_TEXT_CHANNEL } from "./editMenu.ts";
import { DESKTOP_QUIT_GUARD_IPC } from "./quitGuardChannels.ts";
import { DESKTOP_SSH_IPC } from "./sshEnvironmentChannels.ts";
import { DESKTOP_STARTUP_MARKS_CHANNEL } from "./startupMarks.ts";
import { THREAD_NOTIFICATION_IPC } from "./threadNotificationChannels.ts";
import { WINDOW_CAPTURE_IPC } from "./windowCaptureChannels.ts";

function channelNames(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(channelNames);
  return [];
}

describe("desktop IPC channel names", () => {
  it("declares each channel once across every table", () => {
    const names = [
      ...channelNames(Channels),
      ...channelNames(DESKTOP_WORKSPACE_IPC),
      ...channelNames(DESKTOP_QUIT_GUARD_IPC),
      ...channelNames(DESKTOP_SSH_IPC),
      ...channelNames(THREAD_NOTIFICATION_IPC),
      ...channelNames(WINDOW_CAPTURE_IPC),
      DESKTOP_STARTUP_MARKS_CHANNEL,
      PASTE_AS_TEXT_CHANNEL,
    ];
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    expect(names.filter((name) => !name.startsWith("desktop:"))).toEqual([]);
  });
});
