import type { FollowUpBehavior, SendShortcut } from "@ryco/contracts";
import {
  APPROVAL_REDIRECT_PLACEHOLDER,
  type ApprovalRedirect,
} from "@ryco/client-runtime/state/composer";

import { formatShortcutLabel } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

/** Exactly the platform's mod key: Cmd on Mac, Ctrl elsewhere; both together count as neither. */
function isModKey(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform: string = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** Whether sending `prompt` needs Mod+Enter under the Send shortcut setting. */
export function sendRequiresModifier(sendShortcut: SendShortcut, prompt: string): boolean {
  return (
    sendShortcut === "mod-enter" ||
    (sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt))
  );
}

/**
 * Whether the opposite of the follow-up setting is Mod+Shift+Enter rather than Mod+Enter. It
 * depends on the setting alone, never on the prompt, so the shortcut a hint names stays right as
 * the prompt grows: under either Mod+Enter option Mod+Enter is the plain send.
 */
function invertsFollowUpWithShift(sendShortcut: SendShortcut): boolean {
  return sendShortcut !== "enter";
}

/**
 * The Send shortcut in effect on this device. The frozen phone tier hides the setting, so there, on
 * a touch screen without a mouse or trackpad, Enter keeps sending. The tier follows the viewport,
 * so a narrow desktop window or a tablet with a trackpad keeps the setting.
 */
export function effectiveSendShortcut(
  sendShortcut: SendShortcut,
  device: { readonly phoneTier: boolean; readonly finePointer: boolean },
): SendShortcut {
  return device.phoneTier && !device.finePointer ? "enter" : sendShortcut;
}

/**
 * What Enter does in a focused prompt input: `null` leaves it to the input, which adds a new line.
 * Otherwise it sends, and `invertFollowUp` asks for the opposite of the follow-up setting (only the
 * chat composer uses it, while a turn runs). Shift+Enter alone always adds a line. The opposite is
 * Mod+Enter under the Enter setting and Mod+Shift+Enter under either Mod+Enter option.
 */
export function resolveComposerEnter(input: {
  readonly event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">;
  readonly sendShortcut: SendShortcut;
  /** The text the input holds now. */
  readonly prompt: string;
  readonly platform?: string;
}): { readonly invertFollowUp: boolean } | null {
  const { event, sendShortcut } = input;
  const mod = isModKey(event, input.platform);
  if (!invertsFollowUpWithShift(sendShortcut)) {
    return event.shiftKey ? null : { invertFollowUp: mod };
  }
  if (mod) return { invertFollowUp: event.shiftKey };
  return event.shiftKey || sendRequiresModifier(sendShortcut, input.prompt)
    ? null
    : { invertFollowUp: false };
}

/**
 * Mod+Enter, or Mod+Shift+Enter with `shift`, as the composer shows it: "⌘↵" / "Ctrl+Enter",
 * "⇧⌘↵" / "Ctrl+Shift+Enter".
 */
export function modEnterShortcutLabel(
  platform: string = navigator.platform,
  shift = false,
): string {
  const label = formatShortcutLabel(
    { key: "enter", metaKey: false, ctrlKey: false, shiftKey: shift, altKey: false, modKey: true },
    platform,
  );
  return isMacPlatform(platform) ? label.replace(/Enter$/, "↵") : label;
}

/** The shortcut that does the opposite of the follow-up setting (`resolveComposerEnter`). */
export function followUpInvertShortcutLabel(
  sendShortcut: SendShortcut,
  platform: string = navigator.platform,
): string {
  return modEnterShortcutLabel(platform, invertsFollowUpWithShift(sendShortcut));
}

export interface RunningFollowUpDescription {
  /** What Enter does while the turn runs. */
  readonly effective: "queue" | "steer";
  /** Composer placeholder; null where the hint is not shown (the frozen phone tier). */
  readonly placeholder: string | null;
  /** Enter declines the waiting approvals and steers the message into the turn. */
  readonly redirectsApproval?: true;
}

/**
 * The running-state placeholder: the effective Enter action and the alternate shortcut. Steering
 * that is unavailable for the current selection degrades to queueing and says so. A send that
 * redirects (`resolveApprovalRedirect`, the same decision the send makes) steers whatever the
 * setting says: it declines the waiting approvals first, or follows an earlier redirect.
 */
export function describeRunningFollowUp(input: {
  readonly followUpBehavior: FollowUpBehavior;
  readonly steerUnavailableReason: string | null;
  readonly surfaceAllowsSteer: boolean;
  readonly approvalRedirect?: ApprovalRedirect["kind"];
  readonly sendShortcut?: SendShortcut;
  readonly platform?: string;
}): RunningFollowUpDescription {
  if (!input.surfaceAllowsSteer) return { effective: "queue", placeholder: null };
  const shortcut = followUpInvertShortcutLabel(input.sendShortcut ?? "enter", input.platform);
  const steerAvailable = input.steerUnavailableReason === null;
  if (input.approvalRedirect === "decline" && steerAvailable) {
    return {
      effective: "steer",
      placeholder: `${APPROVAL_REDIRECT_PLACEHOLDER} · ${shortcut} to queue instead`,
      redirectsApproval: true,
    };
  }
  if (input.followUpBehavior === "steer" || input.approvalRedirect === "steer") {
    return steerAvailable
      ? { effective: "steer", placeholder: `Steer this turn · ${shortcut} to queue instead` }
      : { effective: "queue", placeholder: "Queue a follow-up · steering unavailable" };
  }
  return {
    effective: "queue",
    placeholder: steerAvailable ? `Queue a follow-up · ${shortcut} to steer` : "Queue a follow-up",
  };
}
