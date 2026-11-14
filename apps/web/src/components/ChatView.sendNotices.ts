import type { DevicePromptScreenshotNotice } from "../hooks/chatSendShared";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Tells why a send went without the simulator screenshot its prompt asked for. */
export function notifyDevicePromptScreenshot(notice: DevicePromptScreenshotNotice): void {
  toastManager.add(
    stackedThreadToast(
      notice.kind === "skipped"
        ? {
            type: "warning",
            title: "The simulator screenshot was skipped",
            description: `This message already has ${notice.maxAttachments} attachments.`,
          }
        : {
            type: "warning",
            title: "Couldn’t attach the simulator screen",
            description:
              notice.reason === "no-attached-device"
                ? "Open the Simulator workspace and choose a device first."
                : notice.reason === "device-not-booted"
                  ? "The selected simulator is still starting."
                  : "The current simulator screen could not be attached.",
          },
    ),
  );
}
