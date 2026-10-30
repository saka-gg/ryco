import { HostedHubApiError, type NativePushHubSupport } from "@ryco/client-runtime/authorization";
import { isAuthRpcError, isUnsupportedRpcError } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import type { PushAlertKind, PushDeviceStatus, PushHubDelivery } from "@ryco/contracts/push";

/**
 * Background alerts (`docs/push-alerts.md`): the node seals an alert to this
 * device and the Hub carries it to APNs, so it arrives while Ryco is closed.
 * This is the decision logic; `backgroundAlerts.ts` runs it against the Hub,
 * the nodes and the native push key.
 */

/** Every kind the app's own alerts know; the node drops action kinds for a viewer. */
export const BACKGROUND_ALERT_KINDS: ReadonlyArray<PushAlertKind> = [
  "approval",
  "input",
  "plan-ready",
  "completed",
  "failed",
  "stopped",
];

/** The node holds `foreground` for 45 seconds; the app repeats it well inside that. */
export const PUSH_PRESENCE_REFRESH_MS = 30_000;
/** A Hub without push is asked again at most this often, on a foreground or a settings visit. */
export const HUB_PUSH_CAPABILITY_RECHECK_MS = 60 * 60_000;
/** A Hub that could not be reached is asked again after this, at the next trigger. */
export const HUB_PUSH_CAPABILITY_RETRY_MS = 60_000;

/** What this build can do before any Hub or node is asked. */
export type BackgroundAlertsSupport =
  | "supported"
  /** Not iOS: push alerts reach iPhones only for now. */
  | "unsupported-platform"
  /** A Personal Team build cannot sign the notification service extension. */
  | "personal-team"
  /** The build has no extension or shared keychain group. */
  | "unavailable-build";

export type BackgroundAlertsHubStatus =
  | "unknown"
  | "signed-out"
  | "checking"
  /** The capability could not be read; asked again on the next foreground. */
  | "unreachable"
  | Exclude<NativePushHubSupport, "available">
  /** The Hub can send to this build; nothing registered yet. */
  | "available"
  | "registering"
  | "registered"
  /** The Hub has no active enrollment for this device's session yet. */
  | "enrollment-pending"
  | "failed";

/** This device's own part: permission, the APNs token, the push key. */
export type BackgroundAlertsDeviceStatus =
  | "idle"
  | "permission-denied"
  | "token-unavailable"
  | "key-unavailable"
  | "ready";

export type EnvironmentPushState =
  | { readonly status: "registering" }
  | {
      readonly status: "registered";
      readonly kinds: ReadonlyArray<PushAlertKind>;
      readonly hubDelivery: PushHubDelivery;
    }
  /** A node from before push alerts: `push.registerDevice` is unknown. */
  | { readonly status: "update-needed" }
  /** Not a Hub channel of an account-enrolled device, or the node is not on a Hub. */
  | { readonly status: "ineligible" }
  | { readonly status: "failed" };

export interface BackgroundAlertsSnapshot {
  /** The user turned them on, with thread alerts. */
  readonly enabled: boolean;
  readonly support: BackgroundAlertsSupport;
  readonly hub: BackgroundAlertsHubStatus;
  readonly device: BackgroundAlertsDeviceStatus;
  readonly environments: ReadonlyMap<EnvironmentId, EnvironmentPushState>;
}

export function initialBackgroundAlertsSnapshot(
  support: BackgroundAlertsSupport,
): BackgroundAlertsSnapshot {
  return { enabled: false, support, hub: "unknown", device: "idle", environments: new Map() };
}

export function backgroundAlertsSupport(input: {
  readonly platform: string;
  readonly personalTeamBuild: boolean;
  readonly keyStoreAvailable: boolean;
}): BackgroundAlertsSupport {
  if (input.platform !== "ios") return "unsupported-platform";
  if (input.personalTeamBuild) return "personal-team";
  return input.keyStoreAvailable ? "supported" : "unavailable-build";
}

export function environmentPushStateFromStatus(status: PushDeviceStatus): EnvironmentPushState {
  if (!status.eligible) return { status: "ineligible" };
  if (!status.registered) return { status: "failed" };
  return { status: "registered", kinds: status.kinds, hubDelivery: status.hubDelivery };
}

function errorTag(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { readonly _tag?: unknown })._tag
    : undefined;
}

/**
 * A node refusing registration: an older node does not know the method, and a
 * node answers `PushRpcError` (or an access refusal) on a channel that cannot
 * receive push, such as a direct or locally approved connection.
 */
export function environmentPushStateFromError(error: unknown): EnvironmentPushState {
  if (isUnsupportedRpcError(error)) return { status: "update-needed" };
  if (errorTag(error) === "PushRpcError" || isAuthRpcError(error)) return { status: "ineligible" };
  return { status: "failed" };
}

/** What the Hub's refusal of a registration means; codes are the public `push-hub` ones. */
export function hubRegistrationFailure(error: unknown): BackgroundAlertsHubStatus {
  if (!(error instanceof HostedHubApiError)) return "failed";
  if (error.status === 404) return "hub-unsupported";
  if (error.wireCode === "push_enrollment_required" || error.code === "push_enrollment_required") {
    return "enrollment-pending";
  }
  if (error.wireCode === "push_topic_unsupported" || error.code === "push_topic_unsupported") {
    return "topic-unsupported";
  }
  return "failed";
}

/**
 * Push covers this environment's alerts of `kind` while the app is in the
 * background: the Hub took this device's token, the node registered its key
 * for the kind, and its Hub accepted the node's last signal. Only then does
 * the app stop posting its own background alert, so the two never double up
 * and none is lost.
 */
export function isBackgroundPushConfirmed(
  snapshot: BackgroundAlertsSnapshot,
  environmentId: EnvironmentId,
  kind: PushAlertKind,
): boolean {
  if (!snapshot.enabled || snapshot.hub !== "registered" || snapshot.device !== "ready") {
    return false;
  }
  const environment = snapshot.environments.get(environmentId);
  return (
    environment?.status === "registered" &&
    environment.hubDelivery === "available" &&
    environment.kinds.includes(kind)
  );
}

export interface BackgroundAlertsRow {
  /** Show the row at all: never on platforms without push. */
  readonly visible: boolean;
  /** The switch can be turned on; turning it off always works. */
  readonly canEnable: boolean;
  readonly detail: string;
}

const RETRY = "Ryco tries again when you come back to the app.";

function machineList(labels: ReadonlyArray<string>): string {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** The settings row for background alerts. */
export function describeBackgroundAlerts(
  snapshot: BackgroundAlertsSnapshot,
  labelOf: (environmentId: EnvironmentId) => string,
): BackgroundAlertsRow {
  const blocked = (detail: string): BackgroundAlertsRow => ({
    visible: true,
    canEnable: false,
    detail,
  });
  switch (snapshot.support) {
    case "unsupported-platform":
      return { visible: false, canEnable: false, detail: "" };
    case "personal-team":
      return blocked("Not in this build: a Personal Team build cannot receive push.");
    case "unavailable-build":
      return blocked("Not in this build.");
    case "supported":
      break;
  }
  switch (snapshot.hub) {
    case "signed-out":
      return blocked("Sign in to your Hub to get alerts while Ryco is closed.");
    case "hub-unsupported":
      return blocked("Your Hub doesn't send background alerts yet.");
    case "platform-unsupported":
    case "topic-unsupported":
      return blocked("Your Hub can't send background alerts to this build.");
    default:
      break;
  }
  const row = (detail: string): BackgroundAlertsRow => ({ visible: true, canEnable: true, detail });
  if (!snapshot.enabled) {
    return row(
      snapshot.hub === "unreachable"
        ? `Couldn't reach your Hub. ${RETRY}`
        : "Also alert this iPhone while Ryco is closed, through your Hub.",
    );
  }
  switch (snapshot.device) {
    case "permission-denied":
      return row("Allow notifications for Ryco in Settings.");
    case "token-unavailable":
      return row(`This iPhone has no push token yet. ${RETRY}`);
    case "key-unavailable":
      return row("Ryco couldn't create the alert key on this iPhone.");
    default:
      break;
  }
  switch (snapshot.hub) {
    case "unknown":
    case "checking":
    case "available":
    case "registering":
      return row("Turning on…");
    case "unreachable":
      return row(`Couldn't reach your Hub. ${RETRY}`);
    case "enrollment-pending":
      return row("Waiting for this iPhone to finish signing in to your Hub.");
    case "failed":
      return row(`Couldn't turn on background alerts. ${RETRY}`);
    default:
      break;
  }
  const outdated: string[] = [];
  const hubWithoutAlerts: string[] = [];
  const on: string[] = [];
  for (const [environmentId, environment] of snapshot.environments) {
    if (environment.status === "update-needed") outdated.push(labelOf(environmentId));
    if (environment.status !== "registered") continue;
    if (environment.hubDelivery === "hub-unsupported")
      hubWithoutAlerts.push(labelOf(environmentId));
    else on.push(labelOf(environmentId));
  }
  if (outdated.length > 0) {
    return row(
      `Update ${machineList(outdated)} for background alerts${on.length > 0 ? `; on for ${machineList(on)}` : ""}.`,
    );
  }
  if (hubWithoutAlerts.length > 0 && on.length === 0) {
    return row("Your Hub doesn't send background alerts yet.");
  }
  if (on.length === 0) return row("On. Each machine joins when Ryco connects to it.");
  return row(`On for ${machineList(on)}.`);
}
