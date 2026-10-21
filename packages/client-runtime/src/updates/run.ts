import type {
  EnvironmentId,
  NodeUpdateInput,
  NodeUpdateState,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUpdatedPayload,
} from "@ryco/contracts";

import { forEachWithConcurrency } from "../concurrency.ts";
import {
  readProviderUpdateResult,
  type ProviderUpdateResultStatus,
} from "../connection/providerMaintenance.ts";
import {
  readNodeUpdateOutcome,
  type NodeUpdateOutcomeResult,
  type NodeUpdateStore,
} from "../state/nodeUpdate/store.ts";
import type {
  PlannedProviderUpdate,
  UpdateEverythingDevicePlan,
  UpdateEverythingPlan,
} from "./plan.ts";

export type UpdateEverythingDeviceStatus =
  | "queued"
  | "providers"
  | "waiting"
  | "updating"
  | "restarting"
  | "done"
  | "failed"
  | "postponed"
  | "skipped"
  | "unknown";

export interface UpdateEverythingDeviceRunState {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: UpdateEverythingDeviceStatus;
  readonly message: string | null;
  readonly providerFailures: ReadonlyArray<string>;
}

export interface UpdateEverythingRunState {
  readonly phase: "providers" | "nodes" | "this-app" | "finished";
  readonly devices: ReadonlyArray<UpdateEverythingDeviceRunState>;
  readonly startedAt: number;
}

export interface UpdateEverythingIo {
  readonly updateProvider: (
    environmentId: EnvironmentId,
    input: { readonly provider: ProviderDriverKind; readonly instanceId: ProviderInstanceId },
  ) => Promise<ServerProviderUpdatedPayload>;
  readonly updateNode: (
    environmentId: EnvironmentId,
    input: NodeUpdateInput,
  ) => Promise<NodeUpdateState>;
  readonly waitForNodeOutcome: NodeUpdateStore["waitForOutcome"];
  /** Re-checked right before every dispatch (connection/authority may have changed since the plan). */
  readonly isStillAllowed: (environmentId: EnvironmentId) => boolean;
  /** Downloads (if needed) and installs this desktop app's update; resolves false on failure. Only called last. */
  readonly installThisApp: () => Promise<boolean>;
  readonly newRequestId: () => string;
  readonly now?: () => number;
  /**
   * Optional: follows each updating node's run (`waiting` for a desktop app's
   * countdown, `restarting`) between dispatch and outcome.
   */
  readonly nodeUpdates?: Pick<NodeUpdateStore, "read" | "subscribe">;
}

export interface UpdateEverythingResult {
  readonly updatedNodes: number;
  readonly updatedProviders: number;
  readonly failures: ReadonlyArray<string>;
  readonly postponed: ReadonlyArray<string>;
  readonly unknown: ReadonlyArray<string>;
  /**
   * Planned updates that never started: cancelled, or the device lost connection or
   * permission. Always set by `runUpdateEverything`.
   */
  readonly skipped?: ReadonlyArray<string>;
}

export interface UpdateEverythingRunOptions {
  readonly onProgress: (state: UpdateEverythingRunState) => void;
  readonly signal?: AbortSignal;
  /** Provider updates in flight at once across all devices; 1–8, default 3. */
  readonly providerConcurrency?: number;
}

export const UPDATE_EVERYTHING_PROVIDER_CONCURRENCY = 3;

const CANCELLED_MESSAGE = "Cancelled before it started.";
const NOT_ALLOWED_MESSAGE = "Lost the connection or permission to update this node.";
const LOST_PROVIDER_ANSWER_MESSAGE =
  "The update's answer was lost. Check the provider before retrying.";

type NodeOutcome = NodeUpdateOutcomeResult["outcome"] | "skipped";

interface DeviceTrack {
  readonly device: UpdateEverythingDevicePlan;
  status: UpdateEverythingDeviceStatus;
  message: string | null;
  readonly providerFailures: string[];
  readonly providerUnknown: string[];
  readonly providerSkipped: string[];
  readonly providersUpdated: string[];
  providersLeft: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function hasNodeWork(device: UpdateEverythingDevicePlan): boolean {
  return (
    device.skippedReason === null &&
    (device.node.kind === "one-click" || device.node.kind === "this-app")
  );
}

function idleMessage(device: UpdateEverythingDevicePlan): string {
  if (device.skippedReason !== null) return device.skippedReason;
  if (device.node.kind === "manual" || device.manualProviders.length > 0) {
    return "Needs a manual update.";
  }
  if (device.node.kind === "unknown") return device.node.reason;
  return "Up to date.";
}

function tagOf(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null
    ? (cause as { readonly _tag?: unknown })._tag
    : undefined;
}

/** A node that answered `server.updateNode` with a refusal never started the update. */
function nodeRefusal(cause: unknown): string | null {
  const tag = tagOf(cause);
  if (tag === "NodeUpdateError") {
    const reason = (cause as { readonly reason?: unknown }).reason;
    return typeof reason === "string" && reason.length > 0
      ? reason
      : "The node refused the update.";
  }
  if (tag === "AuthRpcError") return "Only this node's owner can update it.";
  return null;
}

function nodeTarget(device: UpdateEverythingDevicePlan): string {
  return device.node.kind === "one-click" || device.node.kind === "this-app"
    ? device.node.toVersion
    : "";
}

/**
 * Runs a reviewed plan: every one-click provider update first (bounded across
 * all devices), then every remote node's own update at once, each followed to
 * its outcome, then the desktop app this UI runs inside, last, since its
 * relaunch ends the run. Before every dispatch the signal and `isStillAllowed`
 * are checked again; nothing already dispatched is cancelled or retried. A
 * lost answer is `unknown`. Per-device failures never reject; they are
 * collected in the result.
 */
export async function runUpdateEverything(
  plan: UpdateEverythingPlan,
  io: UpdateEverythingIo,
  options: UpdateEverythingRunOptions,
): Promise<UpdateEverythingResult> {
  const concurrency = options.providerConcurrency ?? UPDATE_EVERYTHING_PROVIDER_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new RangeError("Provider update concurrency must be an integer between 1 and 8.");
  }
  const signal = options.signal;
  const startedAt = (io.now ?? Date.now)();
  let phase: UpdateEverythingRunState["phase"] = "providers";
  let updatedNodes = 0;
  let updatedProviders = 0;
  const failures: string[] = [];
  const postponed: string[] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];

  const tracks: DeviceTrack[] = plan.devices.map((device) => {
    const working = device.skippedReason === null && device.providers.length > 0;
    const queued = working || hasNodeWork(device);
    return {
      device,
      status: queued ? "queued" : "skipped",
      message: queued ? null : idleMessage(device),
      providerFailures: [],
      providerUnknown: [],
      providerSkipped: [],
      providersUpdated: [],
      providersLeft: working ? device.providers.length : 0,
    };
  });

  const emit = () => {
    const state: UpdateEverythingRunState = Object.freeze({
      phase,
      startedAt,
      devices: Object.freeze(
        tracks.map((track) =>
          Object.freeze({
            environmentId: track.device.environmentId,
            label: track.device.label,
            status: track.status,
            message: track.message,
            providerFailures: Object.freeze([...track.providerFailures]),
          }),
        ),
      ),
    });
    try {
      options.onProgress(state);
    } catch {
      // A failing progress listener must not stop the run.
    }
  };
  const set = (
    track: DeviceTrack,
    status: UpdateEverythingDeviceStatus,
    message: string | null,
  ) => {
    if (track.status === status && track.message === message) return;
    track.status = status;
    track.message = message;
    emit();
  };
  const isAllowed = (environmentId: EnvironmentId) => {
    try {
      return io.isStillAllowed(environmentId);
    } catch {
      return false;
    }
  };

  // ---- Providers -------------------------------------------------------------------------

  /** Where the device stands on its providers alone, once they all finished. */
  const providerVerdict = (
    track: DeviceTrack,
  ): { readonly status: UpdateEverythingDeviceStatus; readonly message: string | null } => {
    if (track.providerFailures.length > 0) {
      return {
        status: "failed",
        message: `${plural(track.providerFailures.length, "provider update")} failed.`,
      };
    }
    if (track.providerUnknown.length > 0) {
      return {
        status: "unknown",
        message: `${plural(track.providerUnknown.length, "provider update")} didn't report a result.`,
      };
    }
    if (track.providersUpdated.length > 0) {
      return { status: "done", message: `Updated ${track.providersUpdated.join(", ")}.` };
    }
    if (track.providerSkipped.length > 0) {
      return { status: "skipped", message: track.providerSkipped[0]! };
    }
    return { status: "done", message: "Already up to date." };
  };

  const recordProvider = (
    track: DeviceTrack,
    provider: PlannedProviderUpdate,
    status: ProviderUpdateResultStatus | "skipped",
    message: string | null,
  ) => {
    const where = `${track.device.label} · ${provider.displayName}`;
    switch (status) {
      case "succeeded":
        updatedProviders += 1;
        track.providersUpdated.push(provider.displayName);
        break;
      case "unchanged":
        break;
      case "failed": {
        const reason = message ?? "The update failed.";
        track.providerFailures.push(`${provider.displayName}: ${reason}`);
        failures.push(`${where}: ${reason}`);
        break;
      }
      case "unknown": {
        const reason = message ?? LOST_PROVIDER_ANSWER_MESSAGE;
        track.providerUnknown.push(provider.displayName);
        unknown.push(`${where}: ${reason}`);
        break;
      }
      case "skipped": {
        const reason = message ?? CANCELLED_MESSAGE;
        track.providerSkipped.push(reason);
        skipped.push(`${where}: ${reason}`);
        break;
      }
    }
    track.providersLeft -= 1;
    if (track.providersLeft > 0) return;
    if (hasNodeWork(track.device)) {
      set(track, "queued", null);
      return;
    }
    const verdict = providerVerdict(track);
    set(track, verdict.status, verdict.message);
  };

  const jobs = tracks.flatMap((track) =>
    track.providersLeft > 0 ? track.device.providers.map((provider) => ({ track, provider })) : [],
  );

  emit();
  await forEachWithConcurrency(jobs.length, concurrency, async (index) => {
    const { track, provider } = jobs[index]!;
    const environmentId = track.device.environmentId;
    if (signal?.aborted) {
      recordProvider(track, provider, "skipped", CANCELLED_MESSAGE);
      return;
    }
    if (!isAllowed(environmentId)) {
      recordProvider(track, provider, "skipped", NOT_ALLOWED_MESSAGE);
      return;
    }
    set(track, "providers", `Updating ${provider.displayName}…`);
    let result: { readonly status: ProviderUpdateResultStatus; readonly message: string | null };
    try {
      result = readProviderUpdateResult(
        await io.updateProvider(environmentId, {
          provider: provider.driver,
          instanceId: provider.instanceId,
        }),
        provider,
      );
    } catch {
      // Even a lost answer may follow a finished install: never retried.
      result = { status: "unknown", message: LOST_PROVIDER_ANSWER_MESSAGE };
    }
    recordProvider(track, provider, result.status, result.message);
  });

  // ---- Nodes -----------------------------------------------------------------------------

  const finishNode = (track: DeviceTrack, outcome: NodeOutcome, message: string | null) => {
    const label = track.device.label;
    const target = nodeTarget(track.device);
    switch (outcome) {
      case "succeeded":
        updatedNodes += 1;
        break;
      case "failed":
        failures.push(`${label} · Ryco: ${message ?? "The update failed."}`);
        break;
      case "postponed":
        postponed.push(label);
        break;
      case "unknown":
        unknown.push(`${label} · Ryco: ${message ?? "The node did not report back."}`);
        break;
      case "skipped":
        skipped.push(`${label} · Ryco: ${message ?? CANCELLED_MESSAGE}`);
        break;
    }
    if (outcome === "failed") {
      set(track, "failed", message ?? "The update failed.");
      return;
    }
    if (outcome === "postponed") {
      set(track, "postponed", message ?? "Someone at that machine postponed the restart.");
      return;
    }
    if (outcome === "unknown") {
      set(track, "unknown", message ?? "The node did not report back.");
      return;
    }
    const providers = track.device.providers.length > 0 ? providerVerdict(track) : null;
    if (outcome === "succeeded") {
      const updated = `Updated Ryco to ${target}.`;
      if (providers?.status === "failed" || providers?.status === "unknown") {
        set(track, providers.status, `${updated} ${providers.message}`);
      } else {
        set(track, "done", updated);
      }
      return;
    }
    // Skipped: what its providers did still counts.
    if (providers?.status === "failed" || providers?.status === "unknown") {
      set(track, providers.status, providers.message);
    } else {
      set(track, "skipped", message ?? CANCELLED_MESSAGE);
    }
  };

  const reflectRun = (track: DeviceTrack, state: NodeUpdateState | null, requestId: string) => {
    if (state === null || state.run.requestId !== requestId) return;
    const target = nodeTarget(track.device);
    switch (state.run.status) {
      case "preparing":
        set(
          track,
          "updating",
          state.run.progressPercent === null
            ? `Installing Ryco ${target}…`
            : `Downloading Ryco ${target}… ${Math.round(state.run.progressPercent)}%`,
        );
        return;
      case "verifying":
        set(track, "updating", `Checking Ryco ${target}…`);
        return;
      case "waiting":
        set(track, "waiting", "Restarts shortly unless someone there postpones it.");
        return;
      case "restarting":
        set(track, "restarting", `Restarting on Ryco ${target}…`);
        return;
      default:
        return;
    }
  };

  const runNode = async (track: DeviceTrack): Promise<void> => {
    const environmentId = track.device.environmentId;
    if (signal?.aborted) {
      finishNode(track, "skipped", CANCELLED_MESSAGE);
      return;
    }
    if (!isAllowed(environmentId)) {
      finishNode(track, "skipped", NOT_ALLOWED_MESSAGE);
      return;
    }
    const targetVersion = nodeTarget(track.device);
    const requestId = io.newRequestId();
    set(track, "updating", `Installing Ryco ${targetVersion}…`);
    let settled = false;
    const stopObserving =
      io.nodeUpdates?.subscribe(() => {
        if (!settled) reflectRun(track, io.nodeUpdates!.read(environmentId), requestId);
      }) ?? (() => undefined);
    try {
      let immediate: NodeUpdateOutcomeResult | null = null;
      try {
        const accepted = await io.updateNode(environmentId, { targetVersion, requestId });
        immediate = readNodeUpdateOutcome(accepted, { requestId, targetVersion });
        if (immediate === null) reflectRun(track, accepted, requestId);
      } catch (cause) {
        const refusal = nodeRefusal(cause);
        // Anything else may be the node going down mid-answer: its own report decides.
        if (refusal !== null) immediate = { outcome: "failed", message: refusal };
      }
      let outcome: NodeUpdateOutcomeResult;
      try {
        outcome =
          immediate ??
          (await io.waitForNodeOutcome(environmentId, {
            requestId,
            targetVersion,
            ...(signal === undefined ? {} : { signal }),
          }));
      } catch {
        outcome = { outcome: "unknown", message: "Lost track of the update." };
      }
      settled = true;
      finishNode(track, outcome.outcome, outcome.message);
    } finally {
      settled = true;
      stopObserving();
    }
  };

  phase = "nodes";
  emit();
  await Promise.all(
    tracks
      .filter((track) => hasNodeWork(track.device) && track.device.node.kind === "one-click")
      .map(runNode),
  );

  // ---- This app, last ----------------------------------------------------------------------

  const thisApp = tracks.find(
    (track) => hasNodeWork(track.device) && track.device.node.kind === "this-app",
  );
  if (thisApp) {
    if (signal?.aborted) {
      finishNode(thisApp, "skipped", CANCELLED_MESSAGE);
    } else {
      phase = "this-app";
      thisApp.status = "updating";
      thisApp.message = `Installing Ryco ${nodeTarget(thisApp.device)}. This app restarts when it's done.`;
      emit();
      let installed = false;
      try {
        installed = await io.installThisApp();
      } catch {
        installed = false;
      }
      if (installed) finishNode(thisApp, "succeeded", null);
      else finishNode(thisApp, "failed", "Couldn't install the app update.");
    }
  }

  phase = "finished";
  emit();
  return Object.freeze({
    updatedNodes,
    updatedProviders,
    failures: Object.freeze(failures),
    postponed: Object.freeze(postponed),
    unknown: Object.freeze(unknown),
    skipped: Object.freeze(skipped),
  });
}
