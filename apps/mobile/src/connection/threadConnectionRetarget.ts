import type { HostedHubState } from "@ryco/client-runtime/authorization";
import { hostedHubStore } from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";

import {
  getCachedHubNodeRoster,
  subscribeCachedHubNodeRoster,
  type CachedHubNodeRecord,
} from "../hostedHub/nodeRoster";
import { isMobileHostedModeAvailable } from "../hostedHub/runtime";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { acquireMobileHostedNode } from "../hostedHub/acquireNode";

/**
 * Wave 3a: opening a thread re-targets the hosted connection to the node that
 * thread lives on. This module owns the decision ("should this environment
 * become the hosted selection, and if not, why not?") and the debounced,
 * cancel-safe engine that acts on it. Nothing else triggers a retarget — not
 * scroll, not inbox rendering, not prefetch.
 *
 * Two things this module deliberately does NOT do:
 *
 * - It adds no second activation or readiness path. The one mobile acquisition
 *   actuator delegates to Wave 3b's coordinator, which drives the existing
 *   fail-closed activation pipeline (ticket → relay channel → state sync →
 *   readiness gates). Readiness is observable only through the hosted store.
 * - It never treats the `selectNode` promise as a success signal.
 *   `selectNode` resolves as soon as `connectPrimaryEnvironment()` is invoked,
 *   long before any socket or handshake exists, and resolves identically on
 *   every one of its silent no-op guard returns. The intent stays pending until
 *   a store evaluation observes the selection actually landed.
 */

export type ThreadConnectionDegradedReason =
  | "revoked"
  | "node-missing"
  | "directory-unavailable"
  | "signed-out"
  | "hosted-unavailable";

export type ThreadConnectionRetargetDecision =
  | { readonly kind: "none" }
  | { readonly kind: "wait" }
  | { readonly kind: "retarget"; readonly nodeId: string }
  | { readonly kind: "degraded"; readonly reason: ThreadConnectionDegradedReason };

type RetargetStateInput = Pick<
  HostedHubState,
  | "accountStatus"
  | "directoryStatus"
  | "browserStatus"
  | "selectedNode"
  | "selectionStatus"
  | "nodes"
>;

export interface ThreadConnectionRetargetInput {
  readonly environmentId: EnvironmentId;
  readonly hasDirectEnvironment: boolean;
  /** Omitted by legacy fixtures; false means the selected cursor was evicted. */
  readonly hasHostedConnection?: boolean;
  readonly hostedAvailable: boolean;
  readonly state: RetargetStateInput;
  readonly rosterEntry: CachedHubNodeRecord | null;
}

/**
 * Decide what an opened thread's environment needs from the hosted plane.
 *
 * The rule order is load-bearing; each branch names the constraint it encodes.
 * The `retarget` branch is the important one: its preconditions are exactly
 * `selectNode`'s own guard set (`authorization/state.ts` `selectNode`), so a
 * dispatched retarget can never land on a silent no-op. `threadConnection
 * Retarget.test.ts` asserts that mirroring as a property over the whole
 * decision table.
 */
export function deriveThreadConnectionRetarget(
  input: ThreadConnectionRetargetInput,
): ThreadConnectionRetargetDecision {
  const { environmentId, hasDirectEnvironment, hostedAvailable, state, rosterEntry } = input;

  // 1. The direct plane owns this environment id. Dual-plane is fatal: the
  //    hosted connection would be built and then rejected by
  //    `supervisor.register` (connection/supervision.ts:431), leaking a live
  //    socket with no owner. Same guard as hostedHub/nodeLifecycle.ts:36.
  if (hasDirectEnvironment) return { kind: "none" };

  // 2. Already targeted — unless the selection is terminally dead. The relay
  //    reports revocation by patching `selectionStatus` while `selectedNode`
  //    stays set until the next 20s directory poll tears it down; declaring
  //    satisfaction inside that window would consume the one-shot intent with
  //    no stated reason. A healthy match is how a landed retarget is
  //    recognised — the engine consumes its intent here, never on the
  //    `selectNode` promise resolving. A terminal match falls through so the
  //    directory rules can name the reason or retarget a re-enrolled
  //    replacement.
  const selectionTerminal =
    state.selectionStatus === "revoked" ||
    state.selectionStatus === "authorization-removed" ||
    state.selectionStatus === "incompatible";
  if (
    state.selectedNode?.environmentId === environmentId &&
    !selectionTerminal &&
    input.hasHostedConnection !== false
  ) {
    return { kind: "none" };
  }

  // 3. Plane evidence. The persisted roster and the live directory are the
  //    only proofs an environment is hub-hosted — but their *absence* is
  //    authoritative only once someone could have answered. At cold start the
  //    roster hydrates from SQLite behind fire-and-forget dynamic imports and
  //    the directory starts empty, and the engine consumes a "none"
  //    terminally, so deciding "not our plane" from that silence would
  //    permanently strand a deep-linked thread. Prefer a live (non-revoked)
  //    directory record so a revoked entry cannot shadow its re-enrolled
  //    replacement (web's nodeRouteOrchestrator does the same).
  const directoryNode =
    state.nodes.find(
      (candidate) => candidate.environmentId === environmentId && candidate.revokedAt === null,
    ) ??
    state.nodes.find((candidate) => candidate.environmentId === environmentId) ??
    null;
  if (!rosterEntry && !directoryNode) {
    // No hosted surface can ever answer on this build; roster hydration is
    // the only thing that could still prove hub-ness, and the engine
    // re-evaluates when it does.
    if (!hostedAvailable) return { kind: "none" };
    if (state.accountStatus !== "authenticated") {
      // A sign-in in flight may yet produce a directory; a terminal account
      // state cannot prove hub-ness for an unknown environment either way.
      return state.accountStatus === "authenticating" || state.accountStatus === "signing-out"
        ? { kind: "wait" }
        : { kind: "none" };
    }
    return state.directoryStatus === "ready" ? { kind: "none" } : { kind: "wait" };
  }

  // 4. The roster knows the node, but this build/device cannot open hosted
  //    sessions at all (no hosted config, or no usable hardware key). Fail
  //    closed with a stated reason rather than a spinner that never settles.
  if (!hostedAvailable) return { kind: "degraded", reason: "hosted-unavailable" };

  // 5. Account. Signed out / expired / unavailable are terminal for this
  //    attempt and the user has an action to take; the signing-in and
  //    signing-out transients resolve on their own, so wait them out.
  if (state.accountStatus !== "authenticated") {
    if (
      state.accountStatus === "signed-out" ||
      state.accountStatus === "session-expired" ||
      state.accountStatus === "unavailable"
    ) {
      return { kind: "degraded", reason: "signed-out" };
    }
    return { kind: "wait" };
  }

  // 6. Directory. "stale" means the last refresh failed: the node list cannot
  //    be trusted to decide anything, so fail closed exactly like web does
  //    (hostedHub/nodeRouteOrchestrator.ts:239). "idle"/"loading" are the
  //    bootstrap transients and simply have no answer yet.
  if (state.directoryStatus === "stale") {
    return { kind: "degraded", reason: "directory-unavailable" };
  }
  if (state.directoryStatus !== "ready") return { kind: "wait" };

  // 7. Browser status leaves "current" on every app background and comes back
  //    on resume. A retarget requested inside that window is a bounded wait,
  //    never a failure (web's comment at nodeRouteOrchestrator.ts:244-250).
  if (state.browserStatus !== "current") return { kind: "wait" };

  // 8. Directory is authoritative, so absence and revocation are now facts
  //    rather than transients, and both are terminal for the opened thread.
  if (!directoryNode) return { kind: "degraded", reason: "node-missing" };
  if (directoryNode.revokedAt !== null) return { kind: "degraded", reason: "revoked" };

  // 9. Retarget. Presence-offline still retargets: a thread tap is interactive
  //    intent, matching web's `interactiveNodeId` path skipping the presence
  //    fail-fast (nodeRouteOrchestrator.ts:261-265). Offline belongs on the row
  //    as provenance, not as a gate on the tap.
  //
  //    One exception keeps the guard mirror intact: a terminal selection (rule
  //    2's fall-through) whose own node the directory still lists as live is a
  //    contradiction the 20s poll resolves — and `selectNode` would silently
  //    no-op on its already-selected (id, environmentId) match, so dispatching
  //    it is forbidden. Wait for the poll.
  if (
    state.selectedNode?.id === directoryNode.id &&
    state.selectedNode.environmentId === directoryNode.environmentId &&
    input.hasHostedConnection !== false
  ) {
    return { kind: "wait" };
  }
  return { kind: "retarget", nodeId: directoryNode.id };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ThreadConnectionRetargetEngine {
  /** Declare intent to be connected to `environmentId`. Returns a release fn. */
  open(environmentId: EnvironmentId): () => void;
  readDegradedReason(environmentId: EnvironmentId): ThreadConnectionDegradedReason | null;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

interface RetargetStoreLike {
  readonly getState: () => HostedHubState;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ThreadConnectionRetargetTimers {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

export interface ThreadConnectionRetargetEngineDeps {
  readonly store: RetargetStoreLike;
  readonly selectNode: (nodeId: string) => Promise<void>;
  readonly hasDirectEnvironment: (environmentId: EnvironmentId) => boolean;
  readonly hasHostedConnection?: (environmentId: EnvironmentId) => boolean;
  readonly hostedAvailable: () => boolean;
  readonly getRosterEntry: (environmentId: EnvironmentId) => CachedHubNodeRecord | null;
  /**
   * Roster change notifications. The roster hydrates from SQLite outside the
   * hosted store, so a cold-start intent parked on "wait" would otherwise only
   * re-evaluate when the store happens to move; hydration itself must count.
   */
  readonly subscribeRoster?: (listener: () => void) => () => void;
  /** Trailing debounce window. Long enough to swallow an A→B tap-through. */
  readonly debounceMs?: number;
  readonly timers?: ThreadConnectionRetargetTimers;
}

/**
 * Every cross-node thread open waits this long before `selectNode` starts, so
 * it is kept as short as still coalesces a programmatic or double-tap A→B into
 * one relay ticket (and drops a back-swipe-before-dispatch to none). A leading
 * dispatch for an idle engine was considered and rejected: it would spend a
 * ticket on A in exactly the A→B case this window exists to collapse.
 */
export const THREAD_CONNECTION_RETARGET_DEBOUNCE_MS = 100;

const defaultTimers: ThreadConnectionRetargetTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * The retarget engine.
 *
 * Exactly one *pending intent* exists at a time: the environment of the most
 * recently opened thread. A newer `open` replaces an older undispatched intent
 * outright, which is what makes "open A then immediately B" cost one relay
 * ticket instead of two — the transition queue in
 * `authorization/environment.ts` would serialize both, but each dispatched
 * `selectNode` still buys a real teardown and turn-up, so superseded targets
 * have to be dropped *before* dispatch.
 *
 * The intent is one-shot. Once the selection lands the engine consumes it and
 * goes idle; it never reconciles afterwards, so a later manual node selection
 * away from this environment is not fought.
 */
export function createThreadConnectionRetargetEngine(
  deps: ThreadConnectionRetargetEngineDeps,
): ThreadConnectionRetargetEngine {
  const timers = deps.timers ?? defaultTimers;
  const debounceMs = deps.debounceMs ?? THREAD_CONNECTION_RETARGET_DEBOUNCE_MS;

  const openCounts = new Map<EnvironmentId, number>();
  const reasons = new Map<EnvironmentId, ThreadConnectionDegradedReason>();
  const listeners = new Set<() => void>();

  /** The single desired environment, or null when the engine is idle. */
  let intent: EnvironmentId | null = null;
  /**
   * The node the current intent has already been dispatched for, or null when
   * it has not been dispatched yet. Also the anti-storm guard: re-evaluating an
   * intent whose dispatch has already gone out must not send it again, because
   * satisfaction is observed through the store and can lag the dispatch.
   */
  let dispatchedNodeId: string | null = null;
  let debounceTimer: unknown = null;
  /** Node id whose `selectNode` dispatch is in flight; enforces single-flight. */
  let inFlightNodeId: string | null = null;
  let storeUnsubscribe: (() => void) | null = null;
  let rosterUnsubscribe: (() => void) | null = null;
  let evaluateScheduled = false;
  let disposed = false;

  function notify(): void {
    // Snapshot so a listener that unsubscribes during dispatch cannot mutate
    // the set being iterated.
    for (const listener of Array.from(listeners)) listener();
  }

  function publishReason(
    environmentId: EnvironmentId,
    reason: ThreadConnectionDegradedReason,
  ): void {
    if (reasons.get(environmentId) === reason) return;
    reasons.set(environmentId, reason);
    notify();
  }

  function clearReason(environmentId: EnvironmentId): void {
    if (!reasons.delete(environmentId)) return;
    notify();
  }

  function cancelDebounce(): void {
    if (debounceTimer === null) return;
    timers.clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function armDebounce(): void {
    cancelDebounce();
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      evaluate();
    }, debounceMs);
  }

  function ensureStoreSubscription(): void {
    if (disposed) return;
    storeUnsubscribe ??= deps.store.subscribe(scheduleEvaluate);
    rosterUnsubscribe ??= deps.subscribeRoster?.(scheduleEvaluate) ?? null;
  }

  function clearIntent(): void {
    intent = null;
    dispatchedNodeId = null;
    cancelDebounce();
    // One-shot: with no intent there is nothing to reconcile, and a standing
    // subscription here would be the "fights the manual selection" bug.
    storeUnsubscribe?.();
    storeUnsubscribe = null;
    rosterUnsubscribe?.();
    rosterUnsubscribe = null;
  }

  /**
   * Store notifications arrive in bursts (one `patchState` per lifecycle step)
   * and can be published mid-transition. Coalescing onto a microtask means
   * every evaluation reads settled state, mirroring web's `scheduleReconcile`.
   */
  function scheduleEvaluate(): void {
    if (evaluateScheduled || disposed) return;
    evaluateScheduled = true;
    queueMicrotask(() => {
      evaluateScheduled = false;
      evaluate();
    });
  }

  function evaluate(): void {
    if (disposed) return;
    const environmentId = intent;
    if (environmentId === null) return;
    // A store change during the debounce window must not pre-empt the trailing
    // fire; the window exists precisely to let a newer open supersede this one.
    if (debounceTimer !== null) return;

    const decision = deriveThreadConnectionRetarget({
      environmentId,
      hasDirectEnvironment: deps.hasDirectEnvironment(environmentId),
      ...(deps.hasHostedConnection
        ? { hasHostedConnection: deps.hasHostedConnection(environmentId) }
        : {}),
      hostedAvailable: deps.hostedAvailable(),
      state: deps.store.getState(),
      rosterEntry: deps.getRosterEntry(environmentId),
    });

    switch (decision.kind) {
      case "none":
        // Satisfied, or never ours. Either way the intent is done.
        clearReason(environmentId);
        clearIntent();
        return;
      case "wait":
        // Keep the intent pending; the store subscription re-evaluates.
        return;
      case "degraded":
        // Publish and keep re-evaluating: a recovered directory or a resumed
        // session clears the reason and dispatches. Terminal reasons simply
        // keep re-deriving to the same answer, which costs nothing.
        publishReason(environmentId, decision.reason);
        return;
      case "retarget": {
        clearReason(environmentId);
        // Already sent for this intent. `selectNode` patches the selection
        // synchronously, but the store notification that proves it is a
        // separate turn; without this guard the dispatch's own `finally` would
        // re-derive the same answer and dispatch again, forever.
        if (dispatchedNodeId === decision.nodeId) return;
        // Single-flight. A second concurrent dispatch would race the transition
        // queue's teardown ordering for no benefit; the in-flight `finally`
        // re-evaluates and picks up whatever the intent is by then.
        if (inFlightNodeId !== null) return;
        const nodeId = decision.nodeId;
        inFlightNodeId = nodeId;
        dispatchedNodeId = nodeId;
        void deps
          .selectNode(nodeId)
          .catch(() => undefined)
          .finally(() => {
            if (inFlightNodeId === nodeId) inFlightNodeId = null;
            // Not a success signal — just the moment another dispatch becomes
            // permissible. Satisfaction is observed through the store.
            evaluate();
          });
        return;
      }
    }
  }

  return {
    open(environmentId) {
      if (disposed) return () => undefined;
      openCounts.set(environmentId, (openCounts.get(environmentId) ?? 0) + 1);
      if (intent !== environmentId) {
        // Latest wins, entirely: the older undispatched target is dropped
        // before it can cost a relay ticket.
        intent = environmentId;
        dispatchedNodeId = null;
      }
      ensureStoreSubscription();
      armDebounce();

      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        const remaining = (openCounts.get(environmentId) ?? 1) - 1;
        if (remaining > 0) {
          openCounts.set(environmentId, remaining);
          return;
        }
        // Refcounted because one environment can be mounted twice at once —
        // ThreadFilesRouteScreen mounts ThreadDetailScreen alongside itself on
        // iPad, and a `StackActions.replace` remounts before it unmounts.
        openCounts.delete(environmentId);
        clearReason(environmentId);
        if (intent === environmentId && dispatchedNodeId === null) clearIntent();
        // A dispatched retarget is never undone: automatic selection is as
        // sticky as a manual tap, and unwinding it would tear down a
        // connection the user may have navigated onwards into.
      };
    },

    readDegradedReason(environmentId) {
      return reasons.get(environmentId) ?? null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      cancelDebounce();
      storeUnsubscribe?.();
      storeUnsubscribe = null;
      rosterUnsubscribe?.();
      rosterUnsubscribe = null;
      intent = null;
      dispatchedNodeId = null;
      inFlightNodeId = null;
      openCounts.clear();
      reasons.clear();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// App singleton
// ---------------------------------------------------------------------------

let mobileEngine: ThreadConnectionRetargetEngine | null = null;

/**
 * The app's engine, built on first use.
 *
 * Every real dependency is resolved *per invocation* inside the closures, never
 * captured at module load: `createMobileConnectionRegistry()` must be called
 * lazily (the same rule hostedHub/nodeLifecycle.ts follows), and hosted
 * availability flips once the device key resolves during bootstrap.
 */
export function ensureMobileThreadConnectionRetargetEngine(): ThreadConnectionRetargetEngine {
  if (mobileEngine) return mobileEngine;
  mobileEngine = createThreadConnectionRetargetEngine({
    store: hostedHubStore,
    // Wave 3b preserves 3a's decision model and replaces only its actuator:
    // the same retarget decision now acquires/touches a bounded connection.
    selectNode: acquireMobileHostedNode,
    hasDirectEnvironment: (environmentId) =>
      createMobileConnectionRegistry().catalog.get(environmentId) !== null,
    hasHostedConnection: (environmentId) =>
      createMobileConnectionRegistry().driver.supervisor.read(environmentId)?.kind === "primary",
    hostedAvailable: () => isMobileHostedModeAvailable(),
    getRosterEntry: (environmentId) =>
      getCachedHubNodeRoster().find((record) => record.environmentId === environmentId) ?? null,
    subscribeRoster: subscribeCachedHubNodeRoster,
  });
  return mobileEngine;
}

export function resetMobileThreadConnectionRetargetEngineForTests(): void {
  mobileEngine?.dispose();
  mobileEngine = null;
}
