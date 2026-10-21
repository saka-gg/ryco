import type {
  DesktopUpdateState,
  EnvironmentId,
  NodeInstallation,
  NodeUpdateState,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@ryco/contracts";

import {
  isProviderUpdateEligible,
  isProviderUpdateManual,
  providerUpdateVersions,
} from "../connection/providerMaintenance.ts";
import { deriveProviderInstanceEntries } from "../state/composer/providerInstances.ts";

export interface UpdateEverythingEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** The caller may run owner mutations on this node now (server.updateNode / server.updateProvider). */
  readonly canMutate: boolean;
  /** This UI runs inside the desktop app whose own backend this environment is. */
  readonly hostedByThisApp: boolean;
  readonly serverVersion: string | null;
  /** `capabilities.nodeSelfUpdate`. */
  readonly supportsNodeUpdate: boolean;
  readonly nodeUpdate: NodeUpdateState | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Provider instances with a running turn; never updated mid-turn. */
  readonly busyProviderInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly runningChatCount: number;
  readonly continueThreadsAfterRestart: boolean;
}

export type UpdateEverythingLocalApp = Pick<
  DesktopUpdateState,
  | "enabled"
  | "status"
  | "currentVersion"
  | "availableVersion"
  | "downloadedVersion"
  | "downloadPercent"
> | null;

export type PlannedNodeUpdate =
  | {
      readonly kind: "one-click";
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly via: "desktop-app" | "package-manager";
    }
  | { readonly kind: "this-app"; readonly fromVersion: string; readonly toVersion: string }
  | {
      readonly kind: "manual";
      readonly fromVersion: string | null;
      readonly toVersion: string | null;
      readonly reason: string;
      readonly command: string | null;
    }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "unknown"; readonly version: string | null; readonly reason: string };

export interface PlannedProviderUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
}

export interface PlannedManualProviderUpdate extends PlannedProviderUpdate {
  readonly command: string | null;
  readonly message: string | null;
}

export interface UpdateEverythingDevicePlan {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** "Desktop app", "This app", "CLI service · npm", "CLI · bun", "CLI · source checkout", "CLI · npx", "CLI" … */
  readonly installationLabel: string;
  readonly node: PlannedNodeUpdate;
  /** One click updates them. */
  readonly providers: ReadonlyArray<PlannedProviderUpdate>;
  readonly manualProviders: ReadonlyArray<PlannedManualProviderUpdate>;
  /** Non-null when nothing on this device can run now (offline, no permission). */
  readonly skippedReason: string | null;
  readonly runningChatCount: number;
  readonly continuesChatsAfterRestart: boolean;
}

export interface UpdateEverythingPlan {
  readonly devices: ReadonlyArray<UpdateEverythingDevicePlan>;
  /** One-click provider updates plus one-click and this-app node updates. */
  readonly oneClickCount: number;
  readonly manualCount: number;
  /** `oneClickCount > 0`. */
  readonly hasWork: boolean;
}

export const NODE_TOO_OLD_TO_UPDATE_REASON =
  "This node's Ryco is too old to update itself. Update it once by hand.";
export const DEVICE_OFFLINE_REASON = "Not connected right now.";
export const DEVICE_NOT_OWNER_REASON = "Only this node's owner can update it.";

const RUNNING_NODE_UPDATE_STATUSES: ReadonlySet<NodeUpdateState["run"]["status"]> = new Set([
  "preparing",
  "verifying",
  "waiting",
  "restarting",
]);

/** How the device's Ryco is installed, for display next to its name. */
export function describeNodeInstallation(input: {
  readonly hostedByThisApp: boolean;
  readonly installation: NodeInstallation | null;
}): string {
  if (input.hostedByThisApp) return "This app";
  const installation = input.installation;
  if (installation === null) return "Unknown install";
  const cli = installation.service === null ? "CLI" : "CLI service";
  switch (installation.kind) {
    case "desktop-app":
      return "Desktop app";
    case "npm-global":
      return `${cli} · npm`;
    case "bun-global":
      return `${cli} · bun`;
    case "pnpm-global":
      return `${cli} · pnpm`;
    case "source-checkout":
      return `${cli} · source checkout`;
    case "ephemeral":
      return `${cli} · npx`;
    case "unknown":
      return cli;
  }
}

/** What the node's own report says, for a node this UI does not run inside. */
function planFromNodeState(state: NodeUpdateState): PlannedNodeUpdate {
  if (RUNNING_NODE_UPDATE_STATUSES.has(state.run.status)) {
    return {
      kind: "unknown",
      version: state.currentVersion,
      reason: `Already updating to ${state.run.targetVersion ?? "a new release"}.`,
    };
  }
  if (state.availability === "current") return { kind: "current", version: state.currentVersion };
  if (state.availability === "behind_latest" && state.latestVersion !== null) {
    if (state.canUpdate) {
      return {
        kind: "one-click",
        fromVersion: state.currentVersion,
        toVersion: state.latestVersion,
        via: state.installation.kind === "desktop-app" ? "desktop-app" : "package-manager",
      };
    }
    return {
      kind: "manual",
      fromVersion: state.currentVersion,
      toVersion: state.latestVersion,
      reason: state.manualReason ?? "This node can't update itself.",
      command: state.manualCommand,
    };
  }
  return {
    kind: "unknown",
    version: state.currentVersion,
    reason: "The newest Ryco release isn't known yet.",
  };
}

/** A newer release this app's updater found or already downloaded. */
function newerLocalAppVersion(localApp: NonNullable<UpdateEverythingLocalApp>): string | null {
  const candidate = localApp.downloadedVersion ?? localApp.availableVersion;
  return candidate !== null && candidate !== localApp.currentVersion ? candidate : null;
}

/**
 * The desktop app this UI runs inside is never updated through `server.updateNode`
 * (its relaunch would end the run early): its own updater installs it, last.
 */
function planThisApp(
  environment: UpdateEverythingEnvironmentInput,
  localApp: UpdateEverythingLocalApp,
): PlannedNodeUpdate {
  const state = environment.nodeUpdate;
  if (localApp?.enabled) {
    const reported =
      state?.availability === "behind_latest" && state.latestVersion !== localApp.currentVersion
        ? state.latestVersion
        : null;
    const target = newerLocalAppVersion(localApp) ?? reported;
    if (target !== null) {
      return { kind: "this-app", fromVersion: localApp.currentVersion, toVersion: target };
    }
    if (localApp.status === "up-to-date" || state?.availability === "current") {
      return { kind: "current", version: localApp.currentVersion };
    }
    return {
      kind: "unknown",
      version: localApp.currentVersion,
      reason:
        localApp.status === "error"
          ? "This app couldn't check for updates."
          : "This app hasn't checked for updates yet.",
    };
  }
  // No updater here (a development build, or updates turned off): never one click.
  const version = localApp?.currentVersion ?? state?.currentVersion ?? environment.serverVersion;
  if (state?.availability === "behind_latest" && state.latestVersion !== null) {
    return {
      kind: "manual",
      fromVersion: version,
      toVersion: state.latestVersion,
      reason:
        state.manualReason ?? "Updates are off for this app. Install the new release by hand.",
      command: state.manualCommand,
    };
  }
  if (state?.availability === "current") return { kind: "current", version: state.currentVersion };
  return { kind: "unknown", version, reason: "Updates are off for this app." };
}

function planNode(
  environment: UpdateEverythingEnvironmentInput,
  localApp: UpdateEverythingLocalApp,
): PlannedNodeUpdate {
  if (environment.hostedByThisApp) return planThisApp(environment, localApp);
  if (!environment.supportsNodeUpdate) {
    return {
      kind: "unknown",
      version: environment.serverVersion,
      reason: NODE_TOO_OLD_TO_UPDATE_REASON,
    };
  }
  if (environment.nodeUpdate === null) {
    return {
      kind: "unknown",
      version: environment.serverVersion,
      reason: "This node hasn't reported its Ryco release yet.",
    };
  }
  return planFromNodeState(environment.nodeUpdate);
}

function planProviders(environment: UpdateEverythingEnvironmentInput): {
  readonly oneClick: ReadonlyArray<PlannedProviderUpdate>;
  readonly manual: ReadonlyArray<PlannedManualProviderUpdate>;
} {
  const entries = deriveProviderInstanceEntries(environment.providers);
  const oneClick: PlannedProviderUpdate[] = [];
  const manual: PlannedManualProviderUpdate[] = [];
  const seen = new Set<ProviderInstanceId>();
  environment.providers.forEach((provider, index) => {
    if (seen.has(provider.instanceId)) return;
    seen.add(provider.instanceId);
    const planned: PlannedProviderUpdate = Object.freeze({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: entries[index]!.displayName,
      ...providerUpdateVersions(provider),
    });
    if (isProviderUpdateEligible(provider, environment.busyProviderInstanceIds)) {
      oneClick.push(planned);
    } else if (isProviderUpdateManual(provider)) {
      manual.push(
        Object.freeze({
          ...planned,
          command: provider.versionAdvisory?.updateCommand ?? null,
          message: provider.versionAdvisory?.message ?? null,
        }),
      );
    }
  });
  return { oneClick: Object.freeze(oneClick), manual: Object.freeze(manual) };
}

function skippedReasonFor(environment: UpdateEverythingEnvironmentInput): string | null {
  if (!environment.connected) return DEVICE_OFFLINE_REASON;
  if (!environment.canMutate) return DEVICE_NOT_OWNER_REASON;
  return null;
}

/** Whether running the plan updates this node (`one-click` or `this-app`). */
export function isOneClickNodeUpdate(node: PlannedNodeUpdate): boolean {
  return node.kind === "one-click" || node.kind === "this-app";
}

function planDevice(
  environment: UpdateEverythingEnvironmentInput,
  localApp: UpdateEverythingLocalApp,
): UpdateEverythingDevicePlan {
  const skippedReason = skippedReasonFor(environment);
  const planned = planNode(environment, localApp);
  const providers = planProviders(environment);
  // A device nothing can run on now keeps its manual items but offers no one-click work.
  const node: PlannedNodeUpdate =
    skippedReason !== null && (planned.kind === "one-click" || planned.kind === "this-app")
      ? { kind: "unknown", version: planned.fromVersion, reason: skippedReason }
      : planned;
  return Object.freeze({
    environmentId: environment.environmentId,
    label: environment.label,
    installationLabel: describeNodeInstallation({
      hostedByThisApp: environment.hostedByThisApp,
      installation: environment.nodeUpdate?.installation ?? null,
    }),
    node: Object.freeze(node),
    providers: skippedReason === null ? providers.oneClick : Object.freeze([]),
    manualProviders: providers.manual,
    skippedReason,
    runningChatCount: environment.runningChatCount,
    continuesChatsAfterRestart: environment.continueThreadsAfterRestart,
  });
}

/**
 * What "Update everything" would do on every listed environment: provider CLIs
 * one click can update, the node's own Ryco (the desktop app hosting this UI
 * as `this-app`), and what someone has to update by hand. Pure; the order is
 * this app first, then by label.
 */
export function buildUpdateEverythingPlan(input: {
  readonly environments: ReadonlyArray<UpdateEverythingEnvironmentInput>;
  readonly localApp: UpdateEverythingLocalApp;
}): UpdateEverythingPlan {
  const ordered = input.environments.toSorted(
    (left, right) =>
      Number(right.hostedByThisApp) - Number(left.hostedByThisApp) ||
      left.label.localeCompare(right.label) ||
      (left.environmentId < right.environmentId
        ? -1
        : left.environmentId > right.environmentId
          ? 1
          : 0),
  );
  const devices = ordered.map((environment) => planDevice(environment, input.localApp));
  let oneClickCount = 0;
  let manualCount = 0;
  for (const device of devices) {
    oneClickCount += device.providers.length + (isOneClickNodeUpdate(device.node) ? 1 : 0);
    manualCount += device.manualProviders.length + (device.node.kind === "manual" ? 1 : 0);
  }
  return Object.freeze({
    devices: Object.freeze(devices),
    oneClickCount,
    manualCount,
    hasWork: oneClickCount > 0,
  });
}
