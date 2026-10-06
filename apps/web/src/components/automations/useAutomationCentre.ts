import { useEffect, useRef, useState } from "react";
import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlRequestId,
  type AgentControlProposalId,
  type AutomationCentreCommand,
  type AutomationCentreSnapshot,
  type EnvironmentId,
  type ProjectId,
  type ServerProvider,
} from "@ryco/contracts";
import {
  createAutomationCentreReader,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";
import { isTagged } from "effect/Predicate";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { retainAgentControlProposalSync } from "./data/useAutomationProposalSync";

type WithoutRequest<T> = T extends unknown ? Omit<T, "requestId"> : never;
/**
 * A save, cancel, retry or read; the hook adds the request id — a new one
 * per action, reused only to retry an attempt whose answer never arrived.
 */
export type AutomationCommandDraft = WithoutRequest<AutomationCentreCommand>;

/** The server judged the command; any other failure may not have reached it. */
const isServerAnswer = (cause: unknown) => isTagged(cause, "AgentControlRpcError");

export interface AutomationCentreState {
  readonly snapshot: AutomationCentreSnapshot | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly error: string | null;
  readonly busy: boolean;
  /** Why changes are off for this reader (hosted role), or null. */
  readonly disabledReason: string | null;
  readonly command: (input: AutomationCommandDraft) => Promise<boolean>;
  readonly decide: (
    proposalId: AgentControlProposalId,
    decision: "accept" | "reject",
  ) => Promise<void>;
  readonly refresh: () => void;
}

/**
 * One checkout's automations, runs and pending approvals, kept live: it
 * re-reads when the device's connection changes, when its proposal queue
 * changes, and when the window regains focus. The Automations dialog and the
 * project map share it, so both see the same schedule and decide through the
 * same path. Proposal changes come from the device's one shared queue
 * subscription (`retainAgentControlProposalSync`), never a stream of its own.
 */
export function useAutomationCentre(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): AutomationCentreState {
  const capability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCommand);
  const [snapshot, setSnapshot] = useState<AutomationCentreSnapshot | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  /** Request ids of attempts whose answer never arrived, by command, for a faithful retry. */
  const unanswered = useRef(new Map<string, AgentControlRequestId>());

  useEffect(() => {
    let client: unknown = undefined;
    let stop = () => {};
    let invalidate = () => {};
    const bind = () => {
      const next = readEnvironmentConnection(environmentId)?.client ?? null;
      if (next === client) return;
      stop();
      client = next;
      const epoch = ++generation.current;
      pending.current = false;
      setBusy(false);
      setSnapshot(null);
      setProviders([]);
      const api = next ? readEnvironmentApiForConnection(environmentId, next) : undefined;
      if (!api?.automationCentre) {
        setError("Connect to a server with the automation centre available.");
        return;
      }
      setError(null);
      const reader = createAutomationCentreReader({
        api: api.automationCentre,
        projectId,
        onSnapshot: (value) => {
          setSnapshot(value);
          setError(null);
        },
        onError: () => {
          setSnapshot(null);
          setError(
            "Automations are unavailable. Check your connection and Agent Control setting, then refresh.",
          );
        },
      });
      refresh.current = reader.refresh;
      invalidate = () => {
        reader.invalidate();
        if (generation.current === epoch) {
          setSnapshot(null);
          setError("Automation access is unavailable.");
        }
      };
      void next!.server
        .getConfig()
        .then((config) => {
          if (generation.current === epoch) setProviders(config.providers);
        })
        .catch(() => {});
      void reader.refresh();
      stop = () => {
        reader.stop();
        refresh.current = async () => {};
        invalidate = () => {};
      };
    };
    const unsubscribe = subscribeEnvironmentConnections(bind);
    bind();
    // The device's proposal queue, shared with every other surface showing it.
    const releaseSync = retainAgentControlProposalSync(environmentId);
    const unsubscribeQueue = useAgentControlStore.subscribe((state, previous) => {
      const queue = state.queueByEnvironmentId[environmentId];
      const before = previous.queueByEnvironmentId[environmentId];
      if (queue === before) return;
      if (queue) {
        // An attempt whose answer was lost did land: an identical action
        // from now on is a new one and gets a new request id.
        for (const [key, requestId] of unanswered.current) {
          if (Object.values(queue.proposalsById).some((p) => p.requestId === requestId))
            unanswered.current.delete(key);
        }
        void refresh.current();
      } else {
        // The server refused the queue (Agent Control off or not allowed).
        invalidate();
      }
    });
    const onFocus = () => void refresh.current();
    window.addEventListener("focus", onFocus);
    const epochs = generation;
    return () => {
      ++epochs.current;
      stop();
      unsubscribe();
      unsubscribeQueue();
      releaseSync();
      window.removeEventListener("focus", onFocus);
    };
  }, [environmentId, projectId]);

  const command = async (input: AutomationCommandDraft): Promise<boolean> => {
    if (!capability.allowed || pending.current) return false;
    const api = readEnvironmentApi(environmentId)?.automationCentre;
    if (!api) return false;
    const epoch = generation.current;
    // Every action is a new request: the server replays an earlier request id
    // whatever became of its proposal, so reusing one would silently repeat a
    // rejected or expired proposal. Only a retry of an attempt that got no
    // answer (the connection dropped) keeps its id, so it cannot land twice.
    const key = JSON.stringify(input);
    const requestId =
      unanswered.current.get(key) ?? AgentControlRequestId.make(crypto.randomUUID());
    unanswered.current.set(key, requestId);
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.command({ ...input, requestId } as AutomationCentreCommand);
      unanswered.current.delete(key);
      if (epoch !== generation.current) return false;
      await refresh.current();
      return true;
    } catch (cause) {
      if (isServerAnswer(cause)) unanswered.current.delete(key);
      if (epoch === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The action could not be confirmed. Refresh before trying again.",
        );
      return false;
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const decide = async (proposalId: AgentControlProposalId, decision: "accept" | "reject") => {
    if (!capability.allowed || pending.current) return;
    const api = readEnvironmentApi(environmentId)?.agentControl;
    if (!api) return;
    const epoch = generation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await (decision === "accept"
        ? api.acceptProposal({ proposalId })
        : api.rejectProposal({ proposalId }));
      if (epoch === generation.current) await refresh.current();
    } catch {
      if (epoch === generation.current)
        setError("Approval could not be confirmed. Refresh to see the current decision.");
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    snapshot,
    providers,
    error,
    busy,
    disabledReason: capability.allowed
      ? null
      : (capability.reason ?? "Automation changes are unavailable."),
    command,
    decide,
    refresh: () => void refresh.current(),
  };
}
