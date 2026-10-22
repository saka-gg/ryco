import type {
  AgentControlProposalStreamEvent,
  AgentControlProposalStreamEventView,
  EnvironmentId,
} from "@ryco/contracts";

import { supportedAgentControlStreamEvent } from "./proposalView.ts";

/**
 * The slice of `EnvironmentApi["agentControl"]` the sync needs. Injected so
 * tests and platforms can supply any conforming subscription source.
 */
export interface AgentControlSubscriptionSource {
  readonly subscribeProposals: (
    callback: (event: AgentControlProposalStreamEventView) => void,
    options?: {
      onResubscribe?: () => void;
      onError?: () => void;
    },
  ) => () => void;
}

export interface AgentControlSyncSink {
  readonly applyStreamEvent: (
    environmentId: EnvironmentId,
    event: AgentControlProposalStreamEvent,
  ) => void;
  readonly clearEnvironment: (environmentId: EnvironmentId) => void;
}

/**
 * Subscribe one environment's Agent Control queue into the shared store.
 *
 * The transport resubscribes automatically after reconnects, and the server
 * opens every subscription with a fresh snapshot event, which resets the
 * store's baseline — so replayed or duplicated events are absorbed without
 * polling.
 *
 * Several syncs for one environment may coexist (e.g. two mounted screens),
 * so stopping deliberately leaves the shared queue state in place for any
 * surviving or future subscriber — the next snapshot replaces it wholesale.
 * Only an authoritative refusal from the server (feature disabled, not
 * authorized) clears the environment's state: nothing may keep rendering
 * proposals the server no longer stands behind.
 */
export function startAgentControlProposalSync(input: {
  readonly environmentId: EnvironmentId;
  readonly source: AgentControlSubscriptionSource;
  readonly sink: AgentControlSyncSink;
  /** Invoked when the subscription fails terminally (e.g. feature disabled). */
  readonly onError?: () => void;
}): () => void {
  const { environmentId, source, sink } = input;
  let stopped = false;

  const unsubscribe = source.subscribeProposals(
    (event) => {
      if (stopped) return;
      const supported = supportedAgentControlStreamEvent(event);
      if (supported !== null) sink.applyStreamEvent(environmentId, supported);
    },
    {
      onError: () => {
        if (stopped) return;
        sink.clearEnvironment(environmentId);
        input.onError?.();
      },
    },
  );

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
}
