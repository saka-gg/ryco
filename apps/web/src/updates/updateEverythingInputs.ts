import type {
  UpdateEverythingEnvironmentInput,
  UpdateEverythingLocalApp,
  UpdateEverythingPlan,
} from "@ryco/client-runtime/updates";
import type {
  DesktopUpdateState,
  EnvironmentId,
  NodeUpdateState,
  ServerConfig,
} from "@ryco/contracts";

import type { EnvironmentTurnActivity } from "../desktopRelaunchGuard.logic";

/** What this app knows about one connection, read from the stores that own it. */
export interface UpdateEverythingEnvironmentSource {
  readonly environmentId: EnvironmentId;
  /** The runtime descriptor's label (the primary's, or a saved environment's), if any. */
  readonly descriptorLabel: string | null;
  /** The connection's own label, the last resort. */
  readonly connectionLabel: string | null;
  /** The node's last known server config; `null` while it has reported none. */
  readonly config: ServerConfig | null;
  /**
   * Its socket is connected and its shell snapshot is live, so its rows tell
   * which turns run there.
   */
  readonly live: boolean;
  /** This client may update the node and its providers now. */
  readonly canMutate: boolean;
  readonly nodeUpdate: NodeUpdateState | null;
}

export interface UpdateEverythingInputSources {
  /** The runtime's connections, in its order. */
  readonly environments: ReadonlyArray<UpdateEverythingEnvironmentSource>;
  /** Interruptible turns per environment (see `collectInterruptibleTurnsByEnvironment`). */
  readonly activity: ReadonlyMap<EnvironmentId, EnvironmentTurnActivity>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** This UI runs inside the desktop app, whose own backend is the primary environment. */
  readonly isElectron: boolean;
}

export const UNNAMED_NODE_LABEL = "Connected node";

const NO_TURNS: EnvironmentTurnActivity = Object.freeze({
  runningChatCount: 0,
  busyProviderInstanceIds: Object.freeze([]),
});

function firstLabel(...candidates: ReadonlyArray<string | null | undefined>): string {
  for (const candidate of candidates) {
    const label = candidate?.trim();
    if (label) return label;
  }
  return UNNAMED_NODE_LABEL;
}

/**
 * The planner's view of every connection: one entry per environment (the
 * first connection listed wins), none for a node that has not reported a
 * config yet, since nothing about it is known. A node whose rows are not live
 * counts as not connected, so a run never acts on it while its running turns
 * are unknown.
 */
export function assembleUpdateEverythingInputs(
  sources: UpdateEverythingInputSources,
): ReadonlyArray<UpdateEverythingEnvironmentInput> {
  const seen = new Set<EnvironmentId>();
  const inputs: UpdateEverythingEnvironmentInput[] = [];
  for (const source of sources.environments) {
    if (seen.has(source.environmentId)) continue;
    seen.add(source.environmentId);
    const config = source.config;
    if (config === null) continue;
    const activity = source.live
      ? (sources.activity.get(source.environmentId) ?? NO_TURNS)
      : NO_TURNS;
    inputs.push({
      environmentId: source.environmentId,
      label: firstLabel(source.descriptorLabel, config.environment?.label, source.connectionLabel),
      connected: source.live,
      canMutate: source.canMutate,
      hostedByThisApp:
        sources.isElectron &&
        sources.primaryEnvironmentId !== null &&
        source.environmentId === sources.primaryEnvironmentId,
      serverVersion: config.environment?.serverVersion ?? null,
      supportsNodeUpdate: config.environment?.capabilities?.nodeSelfUpdate === true,
      nodeUpdate: source.nodeUpdate,
      providers: config.providers,
      busyProviderInstanceIds: activity.busyProviderInstanceIds,
      runningChatCount: activity.runningChatCount,
      continueThreadsAfterRestart: config.settings?.continueThreadsAfterRestart === true,
    });
  }
  return inputs;
}

/** This desktop app's updater, as the planner reads it; `null` outside the desktop app. */
export function selectUpdateEverythingLocalApp(
  state: DesktopUpdateState | null,
  isElectron: boolean,
): UpdateEverythingLocalApp {
  if (!isElectron || state === null) return null;
  return {
    enabled: state.enabled,
    status: state.status,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    downloadedVersion: state.downloadedVersion,
    downloadPercent: state.downloadPercent,
  };
}

/** Only the listed environments; every environment without a list. */
export function selectUpdateEverythingEnvironments(
  environments: ReadonlyArray<UpdateEverythingEnvironmentInput>,
  environmentIds: ReadonlyArray<EnvironmentId> | undefined,
): ReadonlyArray<UpdateEverythingEnvironmentInput> {
  if (environmentIds === undefined) return environments;
  const wanted = new Set(environmentIds);
  return environments.filter((environment) => wanted.has(environment.environmentId));
}

/** Plans are small frozen values: equal JSON means nothing a surface shows changed. */
export function sameUpdateEverythingPlan(
  left: UpdateEverythingPlan,
  right: UpdateEverythingPlan,
): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}
