import { useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import { UNIFIED_WORKSPACE_MAX_CONNECTIONS } from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import type { HostedDemandCandidates } from "../home/useHostedDemandCandidates";
import { mobileAppLifecycle } from "../../platform/appLifecycle";
import { createTaskConnectionDemand } from "./taskConnectionDemandModel";

// The app's one owner of the Tasks surfaces' Hub connection leases
// (`taskConnectionDemandModel.ts` decides which). Surfaces register the
// machines they show; the leases follow the union of what is registered.

/** One slot of the warm set stays free for the selected machine and thread work. */
const LIVE_SLOTS = UNIFIED_WORKSPACE_MAX_CONNECTIONS - 1;
/** A machine not read this long after its lease started is skipped for this visit. */
const ROTATION_TIMEOUT_MS = 20_000;
/** A machine being written to stays live this long after the last write asked for it. */
const PROMOTION_MS = 60_000;

interface Registration {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly priority: ReadonlyArray<EnvironmentId>;
}

const registrations = new Map<symbol, Registration>();
const promotions = new Map<EnvironmentId, number>();
let hub: HostedDemandCandidates = { authority: null, current: false, candidates: [] };
let reachable: ReadonlySet<EnvironmentId> = new Set();
const reachableListeners = new Set<() => void>();
let scheduled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatching: (() => void) | null = null;

const demand = createTaskConnectionDemand({
  retain: (environmentId) =>
    mobileHostedConnectionScopes.retain(environmentId, { type: "local-tasks" }),
  liveSlots: LIVE_SLOTS,
  rotationTimeoutMs: ROTATION_TIMEOUT_MS,
});

const readAt = (environmentId: EnvironmentId) =>
  useLocalTasksStore.getState().byEnvironment[environmentId]?.readAt ?? null;

function watch(): void {
  if (stopWatching) return;
  const stopLifecycle = mobileAppLifecycle.subscribe(schedule);
  // A read landing ends a machine's turn in the rotation.
  const stopTasks = useLocalTasksStore.subscribe((state, previous) => {
    if (state.byEnvironment !== previous.byEnvironment) schedule();
  });
  stopWatching = () => {
    stopLifecycle();
    stopTasks();
  };
}

function reconcile(): void {
  scheduled = false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const now = Date.now();
  for (const [environmentId, until] of promotions) {
    if (until <= now) promotions.delete(environmentId);
  }
  const wanted: EnvironmentId[] = [];
  const priority = new Set<EnvironmentId>(promotions.keys());
  for (const registration of registrations.values()) {
    wanted.push(...registration.environmentIds);
    for (const environmentId of registration.priority) priority.add(environmentId);
  }
  wanted.unshift(...promotions.keys());
  const ids = (pick: (candidate: HostedDemandCandidates["candidates"][number]) => boolean) =>
    new Set(hub.candidates.filter(pick).map((candidate) => candidate.environmentId));
  // A promotion alone keeps it going: a sheet's last save still goes out after the sheet closed.
  const active =
    (registrations.size > 0 || promotions.size > 0) &&
    mobileAppLifecycle.isForeground() &&
    hub.current;
  const plan = demand.update({
    active,
    authority: hub.authority,
    wanted,
    priority,
    eligible: ids((candidate) => candidate.eligible),
    connected: ids((candidate) => candidate.ready),
    failed: ids((candidate) => candidate.failed),
    readAt,
    now,
  });
  if (registrations.size === 0 && promotions.size === 0) {
    stopWatching?.();
    stopWatching = null;
  } else {
    watch();
  }
  const wakeAt = Math.min(plan.checkAt ?? Infinity, ...promotions.values());
  if (Number.isFinite(wakeAt)) timer = setTimeout(reconcile, Math.max(0, wakeAt - now));
}

/** Coalesced: a surface re-registering in one render never drops and re-takes its leases. */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(reconcile);
}

/** Registers the Hub machines a mounted Tasks surface shows; `priority` ones are kept live. */
export function registerTaskConnectionDemand(
  environmentIds: ReadonlyArray<EnvironmentId>,
  priority: ReadonlyArray<EnvironmentId> = [],
): () => void {
  const token = Symbol("task-demand");
  registrations.set(token, { environmentIds, priority });
  schedule();
  return () => {
    registrations.delete(token);
    schedule();
  };
}

/** The Hub's view of its machines, from a mounted surface (`useHostedDemandCandidates`). */
export function setTaskDemandHub(next: HostedDemandCandidates): void {
  if (next === hub) return;
  hub = next;
  const nextReachable = new Set(
    next.candidates
      .filter((candidate) => candidate.eligible)
      .map((candidate) => candidate.environmentId),
  );
  if (
    nextReachable.size !== reachable.size ||
    [...nextReachable].some((environmentId) => !reachable.has(environmentId))
  ) {
    reachable = nextReachable;
    for (const listener of reachableListeners) listener();
  }
  schedule();
}

/**
 * A Hub machine the Hub lists online and this phone may connect to, though it
 * may not hold a connection right now (its slot went to another machine).
 */
export function isTaskMachineReachable(environmentId: EnvironmentId): boolean {
  return reachable.has(environmentId);
}

export function useReachableTaskMachines(): ReadonlySet<EnvironmentId> {
  return useSyncExternalStore(
    (listener) => {
      reachableListeners.add(listener);
      return () => reachableListeners.delete(listener);
    },
    () => reachable,
    () => reachable,
  );
}

/** Keeps a Hub machine live for a while: a write to it is on its way. */
export function promoteTaskMachine(environmentId: EnvironmentId): void {
  promotions.set(environmentId, Date.now() + PROMOTION_MS);
  schedule();
}

/** Pull to refresh: every Hub machine not live now is read once more. */
export function rereadTaskMachines(): void {
  demand.rescan();
  schedule();
}
