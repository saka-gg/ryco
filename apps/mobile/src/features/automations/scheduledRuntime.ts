// The phone's scheduled tasks runtime: one cache of every checkout's automation snapshot
// (the web's counts loader, which keeps what it read), the commands that change schedules,
// and the decisions on their proposals. Policy stays on the node: the phone only sends the
// user's explicit save, cancel, retry, read, approve or reject, through the same request id
// rule as the web (`createAutomationRequestIds`).

import {
  AUTOMATION_DECISION_UNCONFIRMED,
  createAutomationRequestIds,
  sendAutomationCommand,
  type AutomationCommandDraft,
} from "@ryco/client-runtime/state/automations/commands";
import {
  automationCheckoutKey,
  checkoutAutomationCounts,
  createAutomationCountsLoader,
  type AutomationCheckoutRef,
  type AutomationCountsEntry,
  type AutomationCountsState,
} from "@ryco/client-runtime/state/automations/projectCounts";
import type { AgentControlProposalId, EnvironmentId } from "@ryco/contracts";
import { AutomationCentreSnapshot } from "@ryco/contracts/automation-centre";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { registerEnvironmentDevicePurge } from "../../persistence/environmentDevicePurge";
import { awaitSavedQueryStore } from "../../rpc/savedQueries";
import { schemaSavedQueryCodec } from "../../rpc/savedQueryCodec";
import { uuidv4 } from "../../lib/uuid";
import { useAgentControlStore } from "../../state/agentControlRuntime";
import { readEnvironmentMutationReady } from "../../state/environmentMutationReady";
import { changedAutomationProjects } from "./scheduledModel";

/** Said when the machine has no connection to send a change through. */
export const SCHEDULE_RECONNECT = "Reconnect to this machine to change its schedules.";

function readSnapshot(checkout: AutomationCheckoutRef) {
  // Never throws: the Tasks tab asks during reconnects too.
  try {
    return (
      readEnvironmentApi(checkout.environmentId)?.automationCentre?.snapshot({
        projectId: checkout.projectId,
      }) ?? null
    );
  } catch {
    return null;
  }
}

const loader = createAutomationCountsLoader({ readSnapshot });
const requestIds = createAutomationRequestIds(uuidv4);

// ---------------------------------------------------------------------------
// Saved snapshots: each checkout's last answer is kept on the device (the saved
// query store, under its rules) and shown until the node answers, or while it
// cannot. A saved entry carries `fetchedAt: 0`; every action still goes to the
// node, which decides.
// ---------------------------------------------------------------------------

const SAVED_SNAPSHOT = schemaSavedQueryCodec(AutomationCentreSnapshot, 1);
const savedKeyOf = (key: string) => `automations\u0000${key}`;
let savedEntries: ReadonlyMap<string, AutomationCountsEntry> = new Map();
const savedLookedUp = new Set<string>();
/** The snapshot object last handed to the store per checkout: each answer is saved once. */
const savedSnapshots = new Map<string, unknown>();
const savedListeners = new Set<() => void>();
const publishSaved = (next: ReadonlyMap<string, AutomationCountsEntry>) => {
  savedEntries = next;
  for (const listener of savedListeners) listener();
};

/** Reads the saved snapshot of each checkout not looked up yet. */
export function loadSavedScheduled(checkouts: ReadonlyArray<AutomationCheckoutRef>): void {
  for (const checkout of checkouts) {
    const key = automationCheckoutKey(checkout.environmentId, checkout.projectId);
    if (savedLookedUp.has(key)) continue;
    savedLookedUp.add(key);
    void awaitSavedQueryStore()
      .then((store) => store?.load(checkout.environmentId, savedKeyOf(key), SAVED_SNAPSHOT.version))
      .then((saved) => {
        if (!saved || !savedLookedUp.has(key)) return;
        const snapshot = SAVED_SNAPSHOT.decode(saved.payload);
        if (snapshot === null) return;
        const next = new Map(savedEntries);
        next.set(key, {
          status: "ready",
          snapshot,
          counts: checkoutAutomationCounts({
            projectId: checkout.projectId,
            snapshot,
            nowMs: Date.now(),
          }),
          fetchedAt: 0,
        });
        publishSaved(next);
      })
      .catch(() => undefined);
  }
}

// Each live answer is saved (and replaces the saved entry).
loader.subscribe(() => {
  for (const [key, entry] of loader.getState().entries) {
    if (entry.status !== "ready" || savedSnapshots.get(key) === entry.snapshot) continue;
    savedSnapshots.set(key, entry.snapshot);
    const environmentId = key.split("\u0000")[0] as EnvironmentId;
    const snapshot = entry.snapshot;
    void awaitSavedQueryStore().then((store) =>
      store?.save(environmentId, savedKeyOf(key), SAVED_SNAPSHOT.version, () =>
        SAVED_SNAPSHOT.encode(snapshot),
      ),
    );
  }
});

// Forgetting a node (or its device data) forgets its saved schedules here too.
registerEnvironmentDevicePurge((environmentId) => {
  const prefix = `${environmentId}\u0000`;
  for (const key of [...savedLookedUp]) if (key.startsWith(prefix)) savedLookedUp.delete(key);
  for (const key of [...savedSnapshots.keys()]) {
    if (key.startsWith(prefix)) savedSnapshots.delete(key);
  }
  publishSaved(new Map([...savedEntries].filter(([key]) => !key.startsWith(prefix))));
});

const subscribeEntries = (listener: () => void) => {
  const unsubscribeLoader = loader.subscribe(listener);
  savedListeners.add(listener);
  return () => {
    unsubscribeLoader();
    savedListeners.delete(listener);
  };
};

let merged: {
  readonly live: AutomationCountsState;
  readonly saved: ReadonlyMap<string, AutomationCountsEntry>;
  readonly state: AutomationCountsState;
} | null = null;

/** The node's answers, with the saved one standing in where none (or no usable one) came yet. */
function readEntries(): AutomationCountsState {
  const live = loader.getState();
  if (merged?.live === live && merged.saved === savedEntries) return merged.state;
  let state = live;
  if (savedEntries.size > 0) {
    const entries = new Map(savedEntries);
    for (const [key, entry] of live.entries) {
      if (entry.status === "ready" || !entries.has(key)) entries.set(key, entry);
    }
    state = { entries, loading: live.loading };
  }
  merged = { live, saved: savedEntries, state };
  return state;
}

/** Every checkout's snapshot read so far (or saved on this device), by `automationCheckoutKey`. */
export function useScheduledEntries(): AutomationCountsState {
  return useSyncExternalStore(subscribeEntries, readEntries, readEntries);
}

let savedEnvironments: {
  readonly entries: ReadonlyMap<string, AutomationCountsEntry>;
  readonly set: ReadonlySet<string>;
} | null = null;

function readSavedEnvironments(): ReadonlySet<string> {
  if (savedEnvironments?.entries !== savedEntries) {
    const set = new Set([...savedEntries.keys()].map((key) => key.split("\u0000")[0] ?? ""));
    savedEnvironments = { entries: savedEntries, set };
  }
  return savedEnvironments.set;
}

const subscribeSaved = (listener: () => void) => {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
};

/** Environments with a saved snapshot: listed even before they connect. */
export function useSavedScheduleEnvironments(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeSaved, readSavedEnvironments, readSavedEnvironments);
}

/** The checkouts the open screens list: a queue change re-reads the ones it concerns. */
let listed: ReadonlyArray<AutomationCheckoutRef> = [];

/**
 * Reads the listed checkouts whose snapshot is missing or older than a minute (or, with
 * `fresh`, all of them), and keeps them as the ones a queue change re-reads.
 */
export function requestScheduled(
  checkouts: ReadonlyArray<AutomationCheckoutRef>,
  options: { readonly fresh?: boolean } = {},
): void {
  listed = checkouts;
  startQueueWatch();
  loader.request(checkouts, options.fresh ? { maxAgeMs: 0 } : undefined);
}

function rereadCheckout(
  environmentId: EnvironmentId,
  projectId: AutomationCheckoutRef["projectId"],
) {
  loader.request([{ environmentId, projectId }], { maxAgeMs: 0 });
}

let queueWatch: (() => void) | null = null;

/*
 * A schedule change or a run moving through the queue re-reads its project's snapshot, the
 * way the web dialog re-reads on every queue change; an attempt whose answer was lost but
 * whose proposal landed gets a new request id from now on.
 */
function startQueueWatch() {
  if (queueWatch) return;
  queueWatch = useAgentControlStore.subscribe((state, previous) => {
    for (const [environmentId, queue] of Object.entries(state.queueByEnvironmentId)) {
      const before = previous.queueByEnvironmentId[environmentId];
      if (queue === before) continue;
      requestIds.absorbQueue(Object.values(queue.proposalsById));
      const projects = changedAutomationProjects(queue.proposalsById, before?.proposalsById);
      if (projects.size === 0) continue;
      loader.request(
        listed.filter(
          (checkout) =>
            checkout.environmentId === environmentId && projects.has(checkout.projectId),
        ),
        { maxAgeMs: 0 },
      );
    }
  });
}

export type ScheduleActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Saves, cancels, retries or marks a run read; the checkout is read again after. */
export async function sendScheduleCommand(
  environmentId: EnvironmentId,
  draft: AutomationCommandDraft,
): Promise<ScheduleActionResult> {
  const api = readEnvironmentApi(environmentId)?.automationCentre;
  // The screens gate on `scheduleAccessOf`; this holds when one acted on a stale render.
  if (!api || !readEnvironmentMutationReady(environmentId))
    return { ok: false, error: SCHEDULE_RECONNECT };
  const result = await sendAutomationCommand({
    ids: requestIds,
    command: (command) => api.command(command),
    draft,
  });
  rereadCheckout(environmentId, draft.projectId);
  return result;
}

/** Approves or rejects a run waiting for approval or a proposed schedule change. */
export async function decideScheduleProposal(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: AutomationCheckoutRef["projectId"];
  readonly proposalId: AgentControlProposalId;
  readonly decision: "accept" | "reject";
}): Promise<ScheduleActionResult> {
  const api = readEnvironmentApi(input.environmentId)?.agentControl;
  if (!api || !readEnvironmentMutationReady(input.environmentId))
    return { ok: false, error: SCHEDULE_RECONNECT };
  try {
    await (input.decision === "accept"
      ? api.acceptProposal({ proposalId: input.proposalId })
      : api.rejectProposal({ proposalId: input.proposalId }));
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error && cause.message ? cause.message : AUTOMATION_DECISION_UNCONFIRMED,
    };
  } finally {
    rereadCheckout(input.environmentId, input.projectId);
  }
}

/** Expired or failed schedule proposals the user dismissed, and missed-run notices, this session. */
export const useDismissedScheduleProposals = create<{
  readonly ids: ReadonlySet<AgentControlProposalId>;
}>()(() => ({ ids: new Set() }));

export function dismissScheduleProposals(ids: ReadonlyArray<AgentControlProposalId>): void {
  useDismissedScheduleProposals.setState((state) => ({ ids: new Set([...state.ids, ...ids]) }));
}
