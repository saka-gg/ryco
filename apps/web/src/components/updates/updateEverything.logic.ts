/**
 * What the "Update everything" surfaces show, derived from the plan and the run
 * (`@ryco/client-runtime/updates`): the sidebar pill, one card per device, the
 * plan dialog and Settings → Updates. Pure, so every wording and state mapping is
 * tested without rendering.
 */
import {
  describeUpdateEverythingResult,
  isOneClickNodeUpdate,
  type UpdateEverythingDevicePlan,
  type UpdateEverythingDeviceRunState,
  type UpdateEverythingDeviceStatus,
  type UpdateEverythingPlan,
  type UpdateEverythingResult,
  type UpdateEverythingRunState,
} from "@ryco/client-runtime/updates";
import type { DesktopUpdateState, EnvironmentId, NodeUpdateState } from "@ryco/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

export const UPDATE_EVERYTHING_TITLE = "Update everything";

/** How long a successful run's pill stays before it clears itself. */
export const UPDATE_EVERYTHING_SUCCESS_VISIBLE_MS = 4_000;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// ---- Plan -------------------------------------------------------------------------------

/** Whether one click updates anything on this device now (a provider or its Ryco). */
export function deviceHasOneClickWork(device: UpdateEverythingDevicePlan): boolean {
  return (
    device.skippedReason === null &&
    (device.providers.length > 0 || isOneClickNodeUpdate(device.node))
  );
}

function planUpdatesThisApp(plan: UpdateEverythingPlan): boolean {
  return plan.devices.some(
    (device) => device.skippedReason === null && device.node.kind === "this-app",
  );
}

/** The dialog's subtitle: the order a run goes in. */
export function updateEverythingSubtitle(plan: UpdateEverythingPlan): string {
  const order = "Providers update first, then each node restarts on the new Ryco.";
  return planUpdatesThisApp(plan) ? `${order} This app restarts last.` : order;
}

/** One sentence for what the plan would do; the pill's tooltip and the settings toolbar. */
export function updateEverythingPlanSummary(plan: UpdateEverythingPlan): string {
  if (plan.devices.length === 0) return "No devices connected.";
  let nodes = 0;
  let providers = 0;
  for (const device of plan.devices) {
    if (device.skippedReason !== null) continue;
    if (isOneClickNodeUpdate(device.node)) nodes += 1;
    providers += device.providers.length;
  }
  const parts = [
    ...(nodes > 0 ? [plural(nodes, "Ryco update")] : []),
    ...(providers > 0 ? [plural(providers, "provider update")] : []),
  ];
  const manual =
    plan.manualCount > 0
      ? `${plural(plan.manualCount, "update")} ${plan.manualCount === 1 ? "needs" : "need"} a manual step.`
      : null;
  if (parts.length === 0) return manual ?? "Everything is up to date.";
  const ready = `${parts.join(" and ")} ready.`;
  return manual === null ? ready : `${ready} ${manual}`;
}

/**
 * Identity of what one click would update now. A dismissed pill stays hidden until
 * it changes (a new release, another provider, another device).
 */
export function updateEverythingPlanKey(plan: UpdateEverythingPlan): string {
  return plan.devices
    .filter(deviceHasOneClickWork)
    .map((device) => {
      const node = isOneClickNodeUpdate(device.node)
        ? `ryco@${"toVersion" in device.node ? device.node.toVersion : ""}`
        : "";
      const providers = device.providers
        .map((provider) => `${provider.instanceId}@${provider.toVersion ?? ""}`)
        .toSorted()
        .join(",");
      return `${device.environmentId}:${node}:${providers}`;
    })
    .toSorted()
    .join("|");
}

// ---- Chats ------------------------------------------------------------------------------

/** The warning on a device whose Ryco restarts while chats run there. */
export function chatRestartWarning(count: number, continuesAfterRestart: boolean): string | null {
  if (count <= 0) return null;
  const running = `${plural(count, "chat")} running.`;
  const single = count === 1;
  const outcome = continuesAfterRestart
    ? `${single ? "It continues" : "They continue"} after the restart.`
    : `${single ? "It" : "They"} will be interrupted.`;
  return `${running} ${outcome}`;
}

// ---- Run --------------------------------------------------------------------------------

const ACTIVE_STATUSES: ReadonlySet<UpdateEverythingDeviceStatus> = new Set([
  "providers",
  "updating",
  "waiting",
  "restarting",
]);

const FINISHED_STATUSES: ReadonlySet<UpdateEverythingDeviceStatus> = new Set([
  "done",
  "failed",
  "postponed",
  "skipped",
  "unknown",
]);

export function isRunActive(run: UpdateEverythingRunState | null): boolean {
  return run !== null && run.phase !== "finished";
}

/**
 * The devices a run set out to update. A device with nothing to do starts out
 * `skipped`; one that loses its connection mid-run turns `skipped` later. Folding
 * every state the run reports into this set keeps the latter in the count.
 */
export interface UpdateEverythingRunParticipants {
  readonly startedAt: number;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

/** Returns `previous` itself when nothing changed, so callers can compare by identity. */
export function nextRunParticipants(
  previous: UpdateEverythingRunParticipants | null,
  run: UpdateEverythingRunState | null,
): UpdateEverythingRunParticipants | null {
  if (run === null) return null;
  const known = previous?.startedAt === run.startedAt ? previous.environmentIds : [];
  const added = run.devices
    .filter((device) => device.status !== "skipped" && !known.includes(device.environmentId))
    .map((device) => device.environmentId);
  if (previous !== null && previous.startedAt === run.startedAt && added.length === 0) {
    return previous;
  }
  return { startedAt: run.startedAt, environmentIds: [...known, ...added] };
}

export interface UpdateEverythingRunProgress {
  readonly done: number;
  readonly total: number;
  /** 0–1; a device in progress counts half. */
  readonly fraction: number;
  /** The device the run is busy with, else the next one queued. */
  readonly current: UpdateEverythingDeviceRunState | null;
}

export function runProgress(
  run: UpdateEverythingRunState,
  participants: UpdateEverythingRunParticipants | null,
): UpdateEverythingRunProgress {
  const ids =
    participants?.startedAt === run.startedAt
      ? participants.environmentIds
      : run.devices
          .filter((device) => device.status !== "skipped")
          .map((device) => device.environmentId);
  const members = run.devices.filter((device) => ids.includes(device.environmentId));
  const done = members.filter((device) => FINISHED_STATUSES.has(device.status)).length;
  const active = members.filter((device) => ACTIVE_STATUSES.has(device.status));
  const total = members.length;
  return {
    done,
    total,
    fraction: total === 0 ? 1 : Math.min(1, (done + active.length / 2) / total),
    current: active[0] ?? members.find((device) => device.status === "queued") ?? null,
  };
}

/** One entry per device the surfaces list: the run's devices in order, then any new ones. */
export interface UpdateEverythingDeviceEntry {
  readonly environmentId: EnvironmentId;
  readonly device: UpdateEverythingDevicePlan | null;
  readonly run: UpdateEverythingDeviceRunState | null;
}

export function updateEverythingDeviceEntries(
  plan: UpdateEverythingPlan,
  run: UpdateEverythingRunState | null,
): ReadonlyArray<UpdateEverythingDeviceEntry> {
  if (run === null) {
    return plan.devices.map((device) => ({
      environmentId: device.environmentId,
      device,
      run: null,
    }));
  }
  const planned = new Map(plan.devices.map((device) => [device.environmentId, device] as const));
  const inRun = new Set(run.devices.map((device) => device.environmentId));
  return [
    ...run.devices.map((device) => ({
      environmentId: device.environmentId,
      device: planned.get(device.environmentId) ?? null,
      run: device,
    })),
    ...plan.devices
      .filter((device) => !inRun.has(device.environmentId))
      .map((device) => ({ environmentId: device.environmentId, device, run: null })),
  ];
}

// ---- Device card ------------------------------------------------------------------------

export type UpdateDotTone = "muted" | "success" | "primary" | "warning" | "error";

export const DEVICE_STATUS_LABELS: Readonly<Record<UpdateEverythingDeviceStatus, string>> = {
  queued: "Waiting",
  providers: "Updating providers",
  updating: "Updating Ryco",
  waiting: "Restarting soon",
  restarting: "Restarting",
  done: "Done",
  failed: "Failed",
  postponed: "Postponed",
  skipped: "Skipped",
  unknown: "No answer",
};

const DEVICE_STATUS_TONES: Readonly<Record<UpdateEverythingDeviceStatus, UpdateDotTone>> = {
  queued: "muted",
  providers: "primary",
  updating: "primary",
  waiting: "primary",
  restarting: "primary",
  done: "success",
  failed: "error",
  postponed: "warning",
  skipped: "muted",
  unknown: "warning",
};

export type DeviceVersionView =
  | {
      readonly kind: "change";
      readonly from: string | null;
      readonly to: string;
      /** A one-click update: the target reads as the good outcome. */
      readonly emphasize: boolean;
    }
  | { readonly kind: "current"; readonly version: string };

export interface DeviceProviderLineView {
  readonly key: string;
  readonly name: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface DeviceManualItemView {
  readonly key: string;
  readonly text: string;
  readonly command: string | null;
}

export interface DeviceStatusView {
  readonly label: string;
  readonly message: string | null;
  readonly tone: UpdateDotTone;
  readonly active: boolean;
  readonly failures: ReadonlyArray<string>;
}

export interface UpdateDeviceCardView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly installationLabel: string | null;
  readonly dot: UpdateDotTone;
  readonly pulse: boolean;
  readonly version: DeviceVersionView | null;
  readonly providers: ReadonlyArray<DeviceProviderLineView>;
  readonly chatWarning: string | null;
  /** Plain lines: why nothing runs there, or that it is up to date. */
  readonly notes: ReadonlyArray<string>;
  readonly manual: ReadonlyArray<DeviceManualItemView>;
  /** The run's live status for this device; `null` outside a run. */
  readonly status: DeviceStatusView | null;
  /** One click would update something here (Settings offers a per-device button). */
  readonly canUpdate: boolean;
}

function nodeVersionView(device: UpdateEverythingDevicePlan): DeviceVersionView | null {
  const node = device.node;
  switch (node.kind) {
    case "one-click":
    case "this-app":
      return { kind: "change", from: node.fromVersion, to: node.toVersion, emphasize: true };
    case "manual":
      if (node.toVersion !== null) {
        return { kind: "change", from: node.fromVersion, to: node.toVersion, emphasize: false };
      }
      return node.fromVersion === null ? null : { kind: "current", version: node.fromVersion };
    case "current":
      return { kind: "current", version: node.version };
    case "unknown":
      return node.version === null ? null : { kind: "current", version: node.version };
  }
}

function manualItems(device: UpdateEverythingDevicePlan): DeviceManualItemView[] {
  const items: DeviceManualItemView[] = [];
  if (device.node.kind === "manual") {
    items.push({ key: "ryco", text: device.node.reason, command: device.node.command });
  }
  for (const provider of device.manualProviders) {
    items.push({
      key: provider.instanceId,
      text:
        provider.command === null && provider.message !== null
          ? `${provider.displayName}: ${provider.message}`
          : `${provider.displayName} needs a manual update.`,
      command: provider.command,
    });
  }
  return items;
}

function deviceNotes(device: UpdateEverythingDevicePlan, manualCount: number): string[] {
  const notes: string[] = [];
  if (device.skippedReason !== null) notes.push(device.skippedReason);
  if (device.node.kind === "unknown" && device.node.reason !== device.skippedReason) {
    notes.push(device.node.reason);
  }
  if (
    notes.length === 0 &&
    device.node.kind === "current" &&
    device.providers.length === 0 &&
    manualCount === 0
  ) {
    notes.push("Up to date.");
  }
  return notes;
}

function idleDot(device: UpdateEverythingDevicePlan, manualCount: number): UpdateDotTone {
  if (device.skippedReason !== null) return "muted";
  if (deviceHasOneClickWork(device)) return "muted";
  if (manualCount > 0) return "warning";
  return device.node.kind === "current" ? "success" : "muted";
}

export function describeDeviceStatus(run: UpdateEverythingDeviceRunState): DeviceStatusView {
  return {
    label: DEVICE_STATUS_LABELS[run.status],
    message: run.message,
    tone: DEVICE_STATUS_TONES[run.status],
    active: ACTIVE_STATUSES.has(run.status),
    failures: run.providerFailures,
  };
}

export function describeDeviceCard(entry: UpdateEverythingDeviceEntry): UpdateDeviceCardView {
  const { device, run } = entry;
  const status = run === null ? null : describeDeviceStatus(run);
  if (device === null) {
    return {
      environmentId: entry.environmentId,
      label: run?.label ?? "Device",
      installationLabel: null,
      dot: status?.tone ?? "muted",
      pulse: status?.active ?? false,
      version: null,
      providers: [],
      chatWarning: null,
      notes: [],
      manual: [],
      status,
      canUpdate: false,
    };
  }
  const manual = manualItems(device);
  const restarts = device.skippedReason === null && isOneClickNodeUpdate(device.node);
  return {
    environmentId: device.environmentId,
    label: device.label,
    installationLabel: device.installationLabel,
    dot: status?.tone ?? idleDot(device, manual.length),
    pulse: status?.active ?? false,
    version: nodeVersionView(device),
    providers: device.providers.map((provider) => ({
      key: provider.instanceId,
      name: provider.displayName,
      from: provider.fromVersion,
      to: provider.toVersion,
    })),
    chatWarning: restarts
      ? chatRestartWarning(device.runningChatCount, device.continuesChatsAfterRestart)
      : null,
    // The run's own message already says it ("Skipped · Up to date.").
    notes: deviceNotes(device, manual.length).filter((note) => note !== status?.message),
    manual,
    status,
    canUpdate: deviceHasOneClickWork(device),
  };
}

// ---- Node report ------------------------------------------------------------------------

const CHANNEL_LABELS: Readonly<Record<NodeUpdateState["channel"], string>> = {
  latest: "Stable",
  nightly: "Nightly",
};

/** "Stable channel · checked 5m ago" from a node's own update report. */
export function nodeUpdateMetaLabel(
  state: Pick<NodeUpdateState, "channel" | "checkedAt"> | null,
  nowMs: number,
): string | null {
  if (state === null) return null;
  const channel = `${CHANNEL_LABELS[state.channel]} channel`;
  const checked =
    state.checkedAt === null
      ? "not checked yet"
      : `checked ${formatRelativeTimeLabel(state.checkedAt, nowMs)}`;
  return `${channel} · ${checked}`;
}

// ---- Result -----------------------------------------------------------------------------

export type UpdateResultTone = "success" | "warning" | "error";

export interface UpdateResultView {
  readonly tone: UpdateResultTone;
  readonly title: string;
  readonly description: string | null;
}

/** A finished run in one line, or `null` when it did nothing at all. */
export function describeRunResult(result: UpdateEverythingResult | null): UpdateResultView | null {
  if (result === null) return null;
  const description = describeUpdateEverythingResult(result);
  if (description === null) return null;
  return {
    tone: description.type,
    title: description.title,
    description: description.description ?? null,
  };
}

// ---- Sidebar pill -----------------------------------------------------------------------

export type UpdatePillTone = "primary" | "success" | "warning" | "error";
export type UpdatePillIcon = "download" | "progress" | "done" | "problem";

export interface UpdatePillView {
  readonly kind: "running" | "finished" | "downloading" | "providers" | "available";
  readonly tone: UpdatePillTone;
  readonly icon: UpdatePillIcon;
  readonly title: string;
  /** Trailing figure: the update count, done/total, or a download percentage. */
  readonly count: string | null;
  /** `count` in words, for the accessible name. */
  readonly countLabel: string | null;
  /** 0–1 for the thin bar under the pill; `null` hides the bar. */
  readonly progress: number | null;
  /** Tooltip and accessible description. */
  readonly description: string;
  /**
   * `plan`: hide until what one click would update changes; `run`: forget the
   * finished run.
   */
  readonly dismiss: "plan" | "run" | null;
  readonly autoDismissMs: number | null;
}

export type UpdatePillDesktopState = Pick<
  DesktopUpdateState,
  "enabled" | "status" | "availableVersion" | "downloadPercent"
> | null;

export interface UpdatePillInput {
  readonly plan: UpdateEverythingPlan;
  readonly run: UpdateEverythingRunState | null;
  readonly result: UpdateEverythingResult | null;
  readonly participants: UpdateEverythingRunParticipants | null;
  /** This desktop app's own updater; `null` outside the desktop app. */
  readonly desktopUpdate: UpdatePillDesktopState;
  /** Providers updating outside a run (from their settings or the launch toast). */
  readonly providerUpdatesInProgress: ReadonlyArray<string>;
  readonly dismissedPlanKey: string | null;
}

/**
 * The one sidebar pill, by priority: a running update, a finished run's outcome,
 * this app's download started by hand, provider updates started elsewhere, then
 * what one click would update.
 */
export function getUpdatePillView(input: UpdatePillInput): UpdatePillView | null {
  const { plan, run } = input;
  if (run !== null && isRunActive(run)) {
    const progress = runProgress(run, input.participants);
    return {
      kind: "running",
      tone: "primary",
      icon: "progress",
      title:
        progress.current === null ? "Updating everything" : `Updating ${progress.current.label}`,
      count: `${progress.done}/${progress.total}`,
      countLabel: `${progress.done} of ${progress.total} done`,
      progress: progress.fraction,
      description:
        progress.current?.message ??
        `${progress.done} of ${plural(progress.total, "device")} done.`,
      dismiss: null,
      autoDismissMs: null,
    };
  }

  const outcome = run === null ? null : describeRunResult(input.result);
  if (outcome !== null) {
    return {
      kind: "finished",
      tone: outcome.tone,
      icon: outcome.tone === "success" ? "done" : "problem",
      title: outcome.title,
      count: null,
      countLabel: null,
      progress: null,
      description: outcome.description ?? outcome.title,
      dismiss: "run",
      autoDismissMs: outcome.tone === "success" ? UPDATE_EVERYTHING_SUCCESS_VISIBLE_MS : null,
    };
  }

  const desktop = input.desktopUpdate;
  if (desktop?.enabled && desktop.status === "downloading") {
    const percent =
      typeof desktop.downloadPercent === "number"
        ? Math.max(0, Math.min(100, Math.floor(desktop.downloadPercent)))
        : null;
    const release = desktop.availableVersion === null ? "Ryco" : `Ryco ${desktop.availableVersion}`;
    return {
      kind: "downloading",
      tone: "primary",
      icon: "download",
      title: `Downloading ${release}`,
      count: percent === null ? null : `${percent}%`,
      countLabel: null,
      progress: percent === null ? null : percent / 100,
      description: `Downloading ${release} for this app${percent === null ? "…" : ` (${percent}%)`}.`,
      dismiss: null,
      autoDismissMs: null,
    };
  }

  const providers = input.providerUpdatesInProgress;
  if (providers.length > 0) {
    return {
      kind: "providers",
      tone: "primary",
      icon: "progress",
      title:
        providers.length === 1
          ? `Updating ${providers[0]}`
          : `Updating ${providers.length} providers`,
      count: null,
      countLabel: null,
      progress: null,
      description: `${joinNames(providers)} ${providers.length === 1 ? "update is" : "updates are"} in progress.`,
      dismiss: null,
      autoDismissMs: null,
    };
  }

  if (plan.hasWork && updateEverythingPlanKey(plan) !== input.dismissedPlanKey) {
    return {
      kind: "available",
      tone: "primary",
      icon: "download",
      title: UPDATE_EVERYTHING_TITLE,
      count: String(plan.oneClickCount),
      countLabel: plural(plan.oneClickCount, "update"),
      progress: null,
      description: updateEverythingPlanSummary(plan),
      dismiss: "plan",
      autoDismissMs: null,
    };
  }
  return null;
}
