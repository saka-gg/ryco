import {
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX,
  type AgentControlProposal,
  type AgentControlProposalStreamEvent,
  type EnvironmentId,
} from "@ryco/contracts";
import { isTerminalAgentControlStatus } from "@ryco/client-runtime/state/agentControl";
import { create } from "zustand";

import { readEnvironmentApiForConnection } from "../../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../../environments/runtime";

/**
 * Finished schedule proposals (create, change, pause, resume, cancel) of one
 * device, by automation id: the newest per automation. Finished documents are
 * final, so keeping one never goes stale.
 */
export type ScheduleProposalHistory = Readonly<Record<string, AgentControlProposal>>;

/** Automations remembered per device before the least recently updated are let go. */
export const SCHEDULE_PROPOSAL_HISTORY_LIMIT = 200;

const EMPTY_HISTORY: ScheduleProposalHistory = {};

function scheduleAutomationIdOf(proposal: AgentControlProposal): string | null {
  const plan = proposal.plan;
  return plan.kind === "createAutomation" ||
    plan.kind === "updateAutomation" ||
    plan.kind === "cancelAutomation"
    ? plan.automationId
    : null;
}

/* The schedule model's order for "newest proposal of an automation". */
const isNewer = (candidate: AgentControlProposal, current: AgentControlProposal) =>
  (candidate.createdAt.localeCompare(current.createdAt) ||
    candidate.proposalId.localeCompare(current.proposalId)) > 0;

function pruned(history: Record<string, AgentControlProposal>): ScheduleProposalHistory {
  const entries = Object.entries(history);
  if (entries.length <= SCHEDULE_PROPOSAL_HISTORY_LIMIT) return history;
  return Object.fromEntries(
    entries
      .toSorted(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, SCHEDULE_PROPOSAL_HISTORY_LIMIT),
  );
}

/**
 * Folds proposals into a device's history: only finished schedule proposals,
 * and only when newer than the one already kept for that automation. Returns
 * the same object when nothing changed.
 */
export function absorbScheduleProposals(
  history: ScheduleProposalHistory,
  proposals: readonly AgentControlProposal[],
): ScheduleProposalHistory {
  let next: Record<string, AgentControlProposal> | null = null;
  for (const proposal of proposals) {
    if (!isTerminalAgentControlStatus(proposal.status)) continue;
    const automationId = scheduleAutomationIdOf(proposal);
    if (automationId === null) continue;
    const current = (next ?? history)[automationId];
    if (current && (current.proposalId === proposal.proposalId || !isNewer(proposal, current)))
      continue;
    next ??= { ...history };
    next[automationId] = proposal;
  }
  return next ? pruned(next) : history;
}

/** Every proposal document a queue stream event carries. */
export function proposalsOfStreamEvent(
  event: AgentControlProposalStreamEvent,
): readonly AgentControlProposal[] {
  return event.type === "snapshot"
    ? [...event.queue.active, ...event.queue.recent]
    : [event.proposal];
}

interface ScheduleProposalHistoryState {
  readonly byEnvironment: Readonly<Record<string, ScheduleProposalHistory>>;
}

/**
 * Session memory of finished schedule proposals per device. The shared Agent
 * Control queue keeps only its newest finished proposals of every kind — a
 * busy schedule's run proposals push an expired schedule change out within
 * hours — while "Proposal expired · Propose again" must stay until the
 * proposal is dismissed or superseded. Fed by the queue sync and, once per
 * connection while a dialog shows the device, by the server's longest recent
 * list.
 */
export const useScheduleProposalHistoryStore = create<ScheduleProposalHistoryState>()(() => ({
  byEnvironment: {},
}));

export function recordScheduleProposals(
  environmentId: EnvironmentId,
  proposals: readonly AgentControlProposal[],
): void {
  const state = useScheduleProposalHistoryStore.getState();
  const current = state.byEnvironment[environmentId] ?? EMPTY_HISTORY;
  const next = absorbScheduleProposals(current, proposals);
  if (next === current) return;
  useScheduleProposalHistoryStore.setState({
    byEnvironment: { ...state.byEnvironment, [environmentId]: next },
  });
}

/** The server refused the device's queue: show nothing it no longer stands behind. */
export function clearScheduleProposalHistory(environmentId: EnvironmentId): void {
  const state = useScheduleProposalHistoryStore.getState();
  if (!(environmentId in state.byEnvironment)) return;
  const byEnvironment = { ...state.byEnvironment };
  delete byEnvironment[environmentId];
  useScheduleProposalHistoryStore.setState({ byEnvironment });
}

/* Connections whose longest recent list was already read. */
const seededClients = new WeakSet<object>();

/**
 * While held, reads the device's longest recent proposal list once per
 * connection (the live queue starts from a short one), so an expired schedule
 * proposal from before this session still shows after a reload.
 */
export function retainScheduleProposalHistory(environmentId: EnvironmentId): () => void {
  const seed = () => {
    const client = readEnvironmentConnection(environmentId)?.client ?? null;
    if (!client || seededClients.has(client)) return;
    const api = readEnvironmentApiForConnection(environmentId, client)?.agentControl;
    if (!api) return;
    seededClients.add(client);
    api.listProposals({ recentLimit: AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX }).then(
      (queue) => {
        if (readEnvironmentConnection(environmentId)?.client !== client) return;
        recordScheduleProposals(environmentId, queue.recent);
      },
      // Refused or lost: a later hold may try again; the live queue still feeds it.
      () => seededClients.delete(client),
    );
  };
  const unsubscribe = subscribeEnvironmentConnections(seed);
  seed();
  return unsubscribe;
}

/** Test-only. */
export function resetScheduleProposalHistoryForTests(): void {
  useScheduleProposalHistoryStore.setState({ byEnvironment: {} });
}
