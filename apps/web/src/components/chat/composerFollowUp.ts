import type { FollowUpBehavior } from "@ryco/contracts";

import { formatShortcutLabel } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

/**
 * Mod+Enter in the focused composer is reserved: while a turn runs it does the opposite of the
 * follow-up setting. Exactly the platform's mod key; both modifiers together is not an inversion.
 */
export function isFollowUpInvertModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform: string = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** The alternate-action shortcut as shown in the composer ("⌘↵" / "Ctrl+Enter"). */
export function followUpInvertShortcutLabel(platform: string = navigator.platform): string {
  const label = formatShortcutLabel(
    {
      key: "enter",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    platform,
  );
  return isMacPlatform(platform) ? label.replace(/Enter$/, "↵") : label;
}

export interface RunningFollowUpDescription {
  /** What Enter does while the turn runs. */
  readonly effective: "queue" | "steer";
  /** Composer placeholder; null where the hint is not shown (the frozen phone tier). */
  readonly placeholder: string | null;
}

/**
 * The running-state placeholder: the effective Enter action and the alternate shortcut. Steering
 * that is unavailable for the current selection degrades to queueing and says so.
 */
export function describeRunningFollowUp(input: {
  readonly followUpBehavior: FollowUpBehavior;
  readonly steerUnavailableReason: string | null;
  readonly surfaceAllowsSteer: boolean;
  readonly platform?: string;
}): RunningFollowUpDescription {
  if (!input.surfaceAllowsSteer) return { effective: "queue", placeholder: null };
  const shortcut = followUpInvertShortcutLabel(input.platform);
  const steerAvailable = input.steerUnavailableReason === null;
  if (input.followUpBehavior === "steer") {
    return steerAvailable
      ? { effective: "steer", placeholder: `Steer this turn · ${shortcut} to queue instead` }
      : { effective: "queue", placeholder: "Queue a follow-up · steering unavailable" };
  }
  return {
    effective: "queue",
    placeholder: steerAvailable ? `Queue a follow-up · ${shortcut} to steer` : "Queue a follow-up",
  };
}
