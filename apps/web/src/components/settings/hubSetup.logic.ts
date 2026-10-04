import type { DesktopHubLaunchConfig, HubIdentitySummary } from "@ryco/contracts";

import type { HubAction } from "./hubStatus";

/**
 * How this desktop puts its node on the Hub.
 *
 * `native-account` is the macOS flow: browser sign-in in Desktop main claims the
 * colocated node and verifies local trust without a device code. Every other
 * shipped desktop has no native account setup, so it enrols through the Hub's
 * device-code ceremony and an owner approves the exact fingerprint shown here.
 */
export type HubSetupPath = "native-account" | "device-code";

export interface HubSetupPresentation {
  readonly path: HubSetupPath;
  /** Whether the "Ryco account" row belongs on this desktop at all. */
  readonly showAccountRow: boolean;
  /** Account sign-in will enrol this node; manual enrolment controls stay hidden. */
  readonly automaticNativeSetup: boolean;
  /** Automatic setup is waiting for the account; the connection row offers nothing. */
  readonly automaticNativeSetupWaiting: boolean;
}

export function presentHubSetup(input: {
  readonly config: DesktopHubLaunchConfig | null;
  /** Whether the bridge exposes native account state and sign-in. */
  readonly bridgeOffersAccountSetup: boolean;
  readonly identity: HubIdentitySummary | null;
  readonly action: HubAction | null;
}): HubSetupPresentation {
  const { config } = input;
  // The bridge methods exist on every desktop build, so their presence alone
  // cannot say whether sign-in can ever finish here. Main's launch
  // configuration is the authority; a missing answer reads as unsupported so
  // the panel never strands an operator behind a flow that cannot start.
  const nativeAccount =
    config !== null &&
    config.origin !== null &&
    config.hostedIdentitySupported === true &&
    input.bridgeOffersAccountSetup;
  const automaticNativeSetup = nativeAccount && input.identity?.enrolled === "none";
  return {
    path: nativeAccount ? "native-account" : "device-code",
    showAccountRow: nativeAccount,
    automaticNativeSetup,
    automaticNativeSetupWaiting:
      automaticNativeSetup && (input.action === "enable" || input.action === "enroll"),
  };
}

/**
 * The Connection row's action once setup and saved launch changes are known.
 *
 * Automatic native setup waits on the account, so the row offers nothing.
 * While saved Hub settings wait on a restart, enrollment waits too: the
 * running connector enrols against the Hub it launched with, so an address
 * change saved meanwhile would leave the approved identity on a Hub the next
 * launch no longer uses. The row offers the restart instead.
 */
export function offeredHubAction(input: {
  readonly action: HubAction;
  readonly automaticNativeSetupWaiting: boolean;
  readonly restartRequired: boolean;
}): HubAction {
  if (input.automaticNativeSetupWaiting) return "none";
  if (input.restartRequired && input.action === "enroll") return "none";
  return input.action;
}

const ENROLL_AFTER_ENABLE_KEY = "ryco:hub-enroll-after-enable";
/** Long enough to survive a relaunch, short enough to never surprise anyone later. */
export const ENROLL_AFTER_ENABLE_TTL_MS = 10 * 60_000;

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Remember that the operator turned the connector on in order to enrol.
 *
 * Turning the connector on relaunches Ryco, which unmounts this panel. The
 * intent survives that relaunch so enrolment starts on its own once the
 * connector is ready, instead of asking for a second click. It records only a
 * timestamp: no device code, origin, or identity material.
 */
export function recordHubEnrollmentIntent(storage: IntentStorage | null, now: number): void {
  try {
    storage?.setItem(ENROLL_AFTER_ENABLE_KEY, String(now));
  } catch {
    // Storage can be unavailable; the operator can still start enrolment.
  }
}

/** Forget a pending intent, for example when enrolment was cancelled or disabled. */
export function clearHubEnrollmentIntent(storage: IntentStorage | null): void {
  try {
    storage?.removeItem(ENROLL_AFTER_ENABLE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Take a recorded intent exactly once.
 *
 * Returns true only for an intent younger than the TTL. Every read clears it,
 * so a cancelled or failed enrolment never restarts itself on the next visit.
 */
export function consumeHubEnrollmentIntent(storage: IntentStorage | null, now: number): boolean {
  let raw: string | null;
  try {
    raw = storage?.getItem(ENROLL_AFTER_ENABLE_KEY) ?? null;
  } catch {
    return false;
  }
  if (raw === null) return false;
  clearHubEnrollmentIntent(storage);
  const recordedAt = Number(raw);
  return (
    Number.isFinite(recordedAt) &&
    recordedAt <= now &&
    now - recordedAt <= ENROLL_AFTER_ENABLE_TTL_MS
  );
}
