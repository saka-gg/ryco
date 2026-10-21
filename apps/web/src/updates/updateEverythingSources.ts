/**
 * The live inputs of "Update everything": every connection the environment
 * runtime holds, read from the stores that own its config, permissions, chats
 * and update state. The plan is kept as an external store that follows those
 * stores only while something renders it, and keeps its identity while the
 * plan reads the same, so a provider-status push or a streamed turn that
 * changes nothing a surface shows re-renders nothing.
 */
import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  subscribeEnvironmentServerConfigs,
  wsConnectionStatusForEnvironmentAtom,
} from "@ryco/client-runtime/rpc";
import type { SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import {
  buildUpdateEverythingPlan,
  type UpdateEverythingEnvironmentInput,
  type UpdateEverythingLocalApp,
  type UpdateEverythingPlan,
} from "@ryco/client-runtime/updates";
import type { EnvironmentId } from "@ryco/contracts";

import {
  collectInterruptibleTurnsByEnvironment,
  type EnvironmentTurnActivity,
} from "../desktopRelaunchGuard.logic";
import { isElectron } from "../env";
import { readNodeServerConfig } from "../environments/nodeServerConfig";
import {
  readPrimaryEnvironmentDescriptor,
  subscribePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import {
  followDesktopUpdateState,
  getDesktopUpdateState,
  subscribeDesktopUpdateState,
} from "../rpc/desktopUpdateAtoms";
import {
  selectBootstrapCompleteForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { canMutateNodeUpdates, subscribeNodeMethodPermissions } from "./nodeUpdatePermissions";
import { nodeUpdateStore } from "./nodeUpdateStore";
import {
  assembleUpdateEverythingInputs,
  sameUpdateEverythingPlan,
  selectUpdateEverythingLocalApp,
  type UpdateEverythingEnvironmentSource,
} from "./updateEverythingInputs";

let activityCache: {
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly activity: ReadonlyMap<EnvironmentId, EnvironmentTurnActivity>;
} | null = null;

/** Interruptible turns per environment, recounted only when the rows change. */
function readTurnActivity(
  threads: ReadonlyArray<SidebarThreadOrStub>,
): ReadonlyMap<EnvironmentId, EnvironmentTurnActivity> {
  if (activityCache?.threads !== threads) {
    activityCache = { threads, activity: collectInterruptibleTurnsByEnvironment(threads) };
  }
  return activityCache.activity;
}

function readDescriptorLabel(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
): string | null {
  if (environmentId === primaryEnvironmentId) {
    return readPrimaryEnvironmentDescriptor()?.label ?? null;
  }
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor?.label ?? null;
}

/** Every input of the plan as the stores hold them now. */
export function readUpdateEverythingInputs(): {
  readonly environments: ReadonlyArray<UpdateEverythingEnvironmentInput>;
  readonly localApp: UpdateEverythingLocalApp;
} {
  const state = useStore.getState();
  const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const environments: UpdateEverythingEnvironmentSource[] = listEnvironmentConnections().map(
    (connection) => {
      const environmentId = connection.environmentId;
      return {
        environmentId,
        descriptorLabel: readDescriptorLabel(environmentId, primaryEnvironmentId),
        connectionLabel: connection.knownEnvironment.label,
        config: readNodeServerConfig(environmentId),
        live:
          getWsConnectionStatusForEnvironment(environmentId).phase === "connected" &&
          selectBootstrapCompleteForEnvironment(state, environmentId),
        canMutate: canMutateNodeUpdates(environmentId),
        nodeUpdate: nodeUpdateStore.read(environmentId),
      };
    },
  );
  return {
    environments: assembleUpdateEverythingInputs({
      environments,
      activity: readTurnActivity(selectSidebarThreadsAcrossEnvironments(state)),
      primaryEnvironmentId,
      isElectron,
    }),
    localApp: selectUpdateEverythingLocalApp(getDesktopUpdateState(), isElectron),
  };
}

function computePlan(): UpdateEverythingPlan {
  return buildUpdateEverythingPlan(readUpdateEverythingInputs());
}

/**
 * Follows every store the plan reads; `invalidate` runs when any of them may
 * have changed what it reads. Per-environment socket status is followed for
 * exactly the environments connected now.
 */
function subscribePlanSources(invalidate: () => void): () => void {
  const socketSubscriptions = new Map<EnvironmentId, () => void>();
  const syncSocketSubscriptions = () => {
    const current = new Set(listEnvironmentConnections().map((c) => c.environmentId));
    for (const [environmentId, unsubscribe] of socketSubscriptions) {
      if (current.has(environmentId)) continue;
      unsubscribe();
      socketSubscriptions.delete(environmentId);
    }
    for (const environmentId of current) {
      if (socketSubscriptions.has(environmentId)) continue;
      socketSubscriptions.set(
        environmentId,
        appAtomRegistry.subscribe(wsConnectionStatusForEnvironmentAtom(environmentId), invalidate),
      );
    }
  };
  syncSocketSubscriptions();

  // The thread store changes with every streamed event; only its rows and
  // each connection's shell readiness feed the plan.
  let lastThreads: unknown = null;
  let lastLiveKey = "";
  const readThreadKey = () => {
    const state = useStore.getState();
    const threads = selectSidebarThreadsAcrossEnvironments(state);
    const liveKey = listEnvironmentConnections()
      .map((c) => (selectBootstrapCompleteForEnvironment(state, c.environmentId) ? "1" : "0"))
      .join("");
    const changed = threads !== lastThreads || liveKey !== lastLiveKey;
    lastThreads = threads;
    lastLiveKey = liveKey;
    return changed;
  };
  readThreadKey();

  const unsubscribes = [
    subscribeEnvironmentConnections(() => {
      syncSocketSubscriptions();
      invalidate();
    }),
    subscribeEnvironmentServerConfigs(invalidate),
    subscribeNodeMethodPermissions(invalidate),
    subscribePrimaryEnvironmentDescriptor(invalidate),
    nodeUpdateStore.subscribe(invalidate),
    subscribeDesktopUpdateState(invalidate),
    useStore.subscribe(() => {
      if (readThreadKey()) invalidate();
    }),
    // Keeps this app's updater state current while the plan is shown.
    isElectron ? followDesktopUpdateState() : () => undefined,
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const unsubscribe of socketSubscriptions.values()) unsubscribe();
    socketSubscriptions.clear();
  };
}

const planListeners = new Set<() => void>();
let stopPlanSources: (() => void) | null = null;
let planDirty = true;
let currentPlan: UpdateEverythingPlan | null = null;

function invalidatePlan(): void {
  planDirty = true;
  for (const listener of Array.from(planListeners)) listener();
}

/**
 * The plan now, the same object while it reads the same. While nothing
 * subscribes, every read recomputes it: nothing tells it the stores changed.
 */
export function readUpdateEverythingPlan(): UpdateEverythingPlan {
  if (currentPlan !== null && !planDirty) return currentPlan;
  const next = computePlan();
  if (currentPlan === null || !sameUpdateEverythingPlan(currentPlan, next)) currentPlan = next;
  planDirty = stopPlanSources === null;
  return currentPlan;
}

export function subscribeUpdateEverythingPlan(listener: () => void): () => void {
  planListeners.add(listener);
  if (stopPlanSources === null) {
    planDirty = true;
    stopPlanSources = subscribePlanSources(invalidatePlan);
  }
  return () => {
    planListeners.delete(listener);
    if (planListeners.size > 0 || stopPlanSources === null) return;
    const stop = stopPlanSources;
    stopPlanSources = null;
    planDirty = true;
    stop();
  };
}
