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
  createAutomationCountsLoader,
  type AutomationCheckoutRef,
  type AutomationCountsState,
} from "@ryco/client-runtime/state/automations/projectCounts";
import type { AgentControlProposalId, EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "../../connection/environmentApi";
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

/** Every checkout's snapshot read so far, by `automationCheckoutKey`. */
export function useScheduledEntries(): AutomationCountsState {
  return useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);
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
