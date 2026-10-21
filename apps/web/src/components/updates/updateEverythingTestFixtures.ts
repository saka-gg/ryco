import type {
  UpdateEverythingDevicePlan,
  UpdateEverythingDeviceRunState,
  UpdateEverythingPlan,
  UpdateEverythingRunState,
} from "@ryco/client-runtime/updates";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";

export const M4_ID = EnvironmentId.make("env-m4");
export const THIS_MAC_ID = EnvironmentId.make("env-this-mac");
export const LINUX_ID = EnvironmentId.make("env-linux");
export const OFFLINE_ID = EnvironmentId.make("env-offline");

export function devicePlan(
  overrides: Partial<UpdateEverythingDevicePlan> &
    Pick<UpdateEverythingDevicePlan, "environmentId">,
): UpdateEverythingDevicePlan {
  return {
    label: "Device",
    installationLabel: "CLI service · npm",
    node: { kind: "current", version: "0.1.35" },
    providers: [],
    manualProviders: [],
    skippedReason: null,
    runningChatCount: 0,
    continuesChatsAfterRestart: false,
    ...overrides,
  };
}

/** A CLI node behind on Ryco and two providers, with a chat that survives the restart. */
export const M4_DEVICE = devicePlan({
  environmentId: M4_ID,
  label: "MacBook Pro M4",
  installationLabel: "CLI service · npm",
  node: { kind: "one-click", fromVersion: "0.1.33", toVersion: "0.1.35", via: "package-manager" },
  providers: [
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude Code",
      fromVersion: "2.1.40",
      toVersion: "2.1.44",
    },
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      fromVersion: "0.130",
      toVersion: "0.132",
    },
  ],
  manualProviders: [
    {
      instanceId: ProviderInstanceId.make("copilot"),
      driver: ProviderDriverKind.make("copilot"),
      displayName: "Copilot",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      command: "npm i -g @github/copilot",
      message: null,
    },
  ],
  runningChatCount: 1,
  continuesChatsAfterRestart: true,
});

/** The desktop app this UI runs inside: updated last, by its own updater. */
export const THIS_MAC_DEVICE = devicePlan({
  environmentId: THIS_MAC_ID,
  label: "This Mac",
  installationLabel: "This app",
  node: { kind: "this-app", fromVersion: "0.1.34", toVersion: "0.1.35" },
  providers: [
    {
      instanceId: ProviderInstanceId.make("opencode"),
      driver: ProviderDriverKind.make("opencode"),
      displayName: "OpenCode",
      fromVersion: "1.18.2",
      toVersion: "1.18.9",
    },
  ],
});

/** Up to date; nothing to do. */
export const LINUX_DEVICE = devicePlan({
  environmentId: LINUX_ID,
  label: "Linux box",
  installationLabel: "CLI · source checkout",
  node: { kind: "current", version: "0.1.35" },
});

/** Not connected: nothing runs there now. */
export const OFFLINE_DEVICE = devicePlan({
  environmentId: OFFLINE_ID,
  label: "Studio PC",
  installationLabel: "CLI",
  node: { kind: "unknown", version: "0.1.30", reason: "Not connected right now." },
  skippedReason: "Not connected right now.",
});

export function updatePlan(
  devices: ReadonlyArray<UpdateEverythingDevicePlan>,
): UpdateEverythingPlan {
  let oneClickCount = 0;
  let manualCount = 0;
  for (const device of devices) {
    const nodeWork =
      device.skippedReason === null &&
      (device.node.kind === "one-click" || device.node.kind === "this-app");
    oneClickCount += device.providers.length + (nodeWork ? 1 : 0);
    manualCount += device.manualProviders.length + (device.node.kind === "manual" ? 1 : 0);
  }
  return { devices, oneClickCount, manualCount, hasWork: oneClickCount > 0 };
}

export const FULL_PLAN = updatePlan([THIS_MAC_DEVICE, LINUX_DEVICE, M4_DEVICE, OFFLINE_DEVICE]);

export const EMPTY_PLAN: UpdateEverythingPlan = {
  devices: [],
  oneClickCount: 0,
  manualCount: 0,
  hasWork: false,
};

export function runDevice(
  device: UpdateEverythingDevicePlan,
  status: UpdateEverythingDeviceRunState["status"],
  message: string | null = null,
  providerFailures: ReadonlyArray<string> = [],
): UpdateEverythingDeviceRunState {
  return {
    environmentId: device.environmentId,
    label: device.label,
    status,
    message,
    providerFailures,
  };
}

export function runState(
  devices: ReadonlyArray<UpdateEverythingDeviceRunState>,
  phase: UpdateEverythingRunState["phase"] = "nodes",
  startedAt = 1_000,
): UpdateEverythingRunState {
  return { phase, devices, startedAt };
}
