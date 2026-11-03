import type {
  BackgroundAlertsSnapshot,
  BackgroundAlertsSupport,
} from "@ryco/client-runtime/notifications/push";
import type { EnvironmentId } from "@ryco/contracts";

/**
 * Background alerts on the phone (`docs/push-alerts.md`): what this build can
 * do, and how the settings row words the shared state. The registration
 * policy itself is `@ryco/client-runtime/notifications/push`.
 */

export function backgroundAlertsSupport(input: {
  readonly platform: string;
  readonly personalTeamBuild: boolean;
  readonly keyStoreAvailable: boolean;
}): BackgroundAlertsSupport {
  if (input.platform !== "ios") return "unsupported-platform";
  if (input.personalTeamBuild) return "personal-team";
  return input.keyStoreAvailable ? "supported" : "unavailable-build";
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
