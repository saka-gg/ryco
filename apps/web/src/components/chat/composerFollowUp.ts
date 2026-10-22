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
 * What Enter does in the focused composer: `null` leaves it to the editor, which adds a new line.
 * Otherwise it sends, and `invertFollowUp` asks for the opposite of the follow-up setting (it only
 * matters while a turn runs). One rule decides the inversion: Mod+Enter where Enter sends,
 * Mod+Shift+Enter where sending itself needs Mod+Enter. Shift+Enter alone always adds a line.
 */
export function resolveComposerEnter(input: {
  readonly event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">;
  readonly sendShortcut: SendShortcut;
  /** The text the editor holds now. */
  readonly prompt: string;
  readonly platform?: string;
}): { readonly invertFollowUp: boolean } | null {
  const mod = isModKey(input.event, input.platform);
  if (!sendRequiresModifier(input.sendShortcut, input.prompt)) {
    return input.event.shiftKey ? null : { invertFollowUp: mod };
  }
  return mod ? { invertFollowUp: input.event.shiftKey } : null;
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

/** How the follow-up setting's opposite is reached, for its settings row. */
export function describeFollowUpInversion(
  sendShortcut: SendShortcut,
  platform: string = navigator.platform,
): string {
  const oneLine = modEnterShortcutLabel(platform, sendRequiresModifier(sendShortcut, ""));
  if (sendShortcut !== "mod-enter-multiline") return `${oneLine} does the opposite.`;
  const multiline = modEnterShortcutLabel(platform, true);
  return `${oneLine} does the opposite, or ${multiline} in a multiline prompt.`;
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
 * setting says: it declines the waiting approvals first, or follows an earlier redirect. The
 * placeholder shows in an empty composer, so it names the shortcut for a one-line prompt.
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
  // The shortcut that does the opposite of the follow-up setting (`resolveComposerEnter`).
  const shortcut = modEnterShortcutLabel(
    input.platform,
    sendRequiresModifier(input.sendShortcut ?? "enter", ""),
  );
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
