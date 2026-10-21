/**
 * "Update everything": the plan for every connected device and the one run that
 * carries it out. Planning and execution live in `@ryco/client-runtime/updates`;
 * this module feeds them this app's environments, permissions, chats and desktop
 * updater, and keeps the run outside React so it survives the surfaces that show it.
 */
import type {
  UpdateEverythingIo,
  UpdateEverythingPlan,
  UpdateEverythingResult,
  UpdateEverythingRunState,
} from "@ryco/client-runtime/updates";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import { WS_METHODS, type EnvironmentId, type NodeUpdateState } from "@ryco/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { listEnvironmentConnections, readEnvironmentConnection } from "../environments/runtime";
import { setDesktopUpdateState } from "../rpc/desktopUpdateAtoms";
import { installDesktopAppUpdate } from "./desktopAppInstall";
import { canMutateNodeUpdates, mayCallNodeOwnerMethod } from "./nodeUpdatePermissions";
import { listNodeUpdateEnvironmentIds, nodeUpdateStore } from "./nodeUpdateStore";
import { createUpdateEverythingRunner } from "./updateEverythingRunner";
import {
  readUpdateEverythingInputs,
  readUpdateEverythingPlan,
  subscribeUpdateEverythingPlan,
} from "./updateEverythingSources";

export interface UpdateEverythingController {
  /** What a run would do now, for every connected device. */
  readonly plan: UpdateEverythingPlan;
  /** The active run, or the finished one until it is dismissed; `null` otherwise. */
  readonly run: UpdateEverythingRunState | null;
  /** The finished run's result, until it is dismissed. */
  readonly result: UpdateEverythingResult | null;
  readonly running: boolean;
  /**
   * Run the current plan; with `environmentIds`, only those devices. No-op while a run
   * is active.
   */
  readonly start: (options?: { readonly environmentIds?: ReadonlyArray<EnvironmentId> }) => void;
  /** Ask every node and this app's updater to check for updates now. */
  readonly checkAll: () => Promise<void>;
  readonly checking: boolean;
  /** Forget the finished run (the sidebar returns to its idle state). */
  readonly dismissRun: () => void;
}

const updateEverythingIo: UpdateEverythingIo = {
  updateProvider: async (environmentId, input) => {
    const server = ensureEnvironmentApi(environmentId).server;
    if (!server) throw new Error("Node provider settings are unavailable.");
    return server.updateProvider({ provider: input.provider, instanceId: input.instanceId });
  },
  updateNode: (environmentId, input) => nodeUpdateStore.update(environmentId, input),
  waitForNodeOutcome: (environmentId, input) =>
    nodeUpdateStore.waitForOutcome(environmentId, input),
  nodeUpdates: nodeUpdateStore,
  isStillAllowed: (environmentId) =>
    readEnvironmentConnection(environmentId) !== null && canMutateNodeUpdates(environmentId),
  installThisApp: async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return false;
    return installDesktopAppUpdate(bridge, { onState: setDesktopUpdateState });
  },
  newRequestId: () => crypto.randomUUID(),
};

/** How long "check for updates" waits for any one answer before it stops showing progress. */
const CHECK_TIMEOUT_MS = 60_000;

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isSocketConnected(environmentId: EnvironmentId): boolean {
  return getWsConnectionStatusForEnvironment(environmentId).phase === "connected";
}

/**
 * Every connected node this client may update checks for a release, every
 * connected node re-reads its providers (which recomputes their advisories),
 * and this desktop app's updater checks. Each failure stays with its own node;
 * the answers arrive through the states they refresh.
 */
async function checkEverything(): Promise<void> {
  const checks: Array<Promise<unknown>> = [];
  for (const environmentId of listNodeUpdateEnvironmentIds()) {
    if (!isSocketConnected(environmentId) || !canMutateNodeUpdates(environmentId)) continue;
    checks.push(nodeUpdateStore.check(environmentId));
  }
  const refreshed = new Set<EnvironmentId>();
  for (const { environmentId } of listEnvironmentConnections()) {
    if (refreshed.has(environmentId)) continue;
    refreshed.add(environmentId);
    if (!isSocketConnected(environmentId)) continue;
    if (!mayCallNodeOwnerMethod(WS_METHODS.serverRefreshProviders, environmentId)) continue;
    const server = readEnvironmentApi(environmentId)?.server;
    if (server) checks.push(Promise.resolve().then(() => server.refreshProviders({})));
  }
  const bridge = isElectron ? window.desktopBridge : undefined;
  if (bridge) {
    checks.push(bridge.checkForUpdate().then((result) => setDesktopUpdateState(result.state)));
  }
  await Promise.allSettled(checks.map((check) => settleWithin(check, CHECK_TIMEOUT_MS)));
}

/** The app's one run; module-level, so it outlives every surface that shows it. */
export const updateEverythingRunner = createUpdateEverythingRunner({
  readInputs: readUpdateEverythingInputs,
  io: updateEverythingIo,
  showResult: (description) => {
    toastManager.add(
      stackedThreadToast({
        type: description.type,
        title: description.title,
        ...(description.description === undefined ? {} : { description: description.description }),
        data: { hideCopyButton: description.type !== "error" },
      }),
    );
  },
  checkAll: checkEverything,
});

export function useUpdateEverything(): UpdateEverythingController {
  const plan = useSyncExternalStore(
    subscribeUpdateEverythingPlan,
    readUpdateEverythingPlan,
    readUpdateEverythingPlan,
  );
  const runState = useSyncExternalStore(
    updateEverythingRunner.subscribe,
    updateEverythingRunner.getSnapshot,
    updateEverythingRunner.getSnapshot,
  );
  return useMemo(
    () => ({
      plan,
      run: runState.run,
      result: runState.result,
      running: runState.running,
      start: updateEverythingRunner.start,
      checkAll: updateEverythingRunner.checkAll,
      checking: runState.checking,
      dismissRun: updateEverythingRunner.dismissRun,
    }),
    [plan, runState],
  );
}

/** One node's own update report (release, channel, installation, last check), or `null`. */
export function useNodeUpdateState(environmentId: EnvironmentId): NodeUpdateState | null {
  const read = useCallback(() => nodeUpdateStore.read(environmentId), [environmentId]);
  return useSyncExternalStore(nodeUpdateStore.subscribe, read, read);
}
