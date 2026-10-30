import type { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { PushAlertKind, PushDeviceStatus, PushHubDelivery } from "@ryco/contracts/push";

import { HostedHubApiError } from "../../authorization/api.ts";
import type { NativePushHubSupport } from "../../authorization/nativePush.ts";
import { isUnsupportedRpcError } from "../../errors/transportError.ts";
import { isAuthRpcError } from "../../rpc/wsTransport.ts";

/**
 * Background alerts (`docs/push-alerts.md`): the node seals an alert to this
 * device and the Hub carries it to APNs, so it arrives while the app is
 * closed. This is the decision logic; `backgroundAlerts.ts` runs it against the
 * Hub, the nodes and the native push key. How a client words it is its own.
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
