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
import { useEnvironmentServerConfig } from "../../hooks/useChatsAvailability";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { readAgentControlEnabled } from "../agent-control/agentControlSyncGate";
import { retainAgentControlProposalSync } from "./data/useAutomationProposalSync";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const AGENT_CONTROL_OFF_ERROR =
  "Agent Control is turned off on this device. Turn it on in its settings to use automations.";

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
  const capability = useHostedRpcCapability(
    AGENT_CONTROL_WS_METHODS.automationCommand,
    environmentId,
  );
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const [snapshot, setSnapshot] = useState<AutomationCentreSnapshot | null>(null);
  // The environment's live config (its subscription keeps it current), not a
  // full `getConfig` read per bind just for the provider list.
  const environmentConfig = useEnvironmentServerConfig(environmentId);
  const providers = environmentConfig?.providers ?? NO_PROVIDERS;
  // The device's own config says Agent Control is off: read nothing and hold
  // no queue subscription instead of letting the server refuse both. Unknown
  // config still attempts; turning the feature on re-runs the binding.
  const agentControlOff = readAgentControlEnabled(environmentConfig) === false;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  /** Request ids of attempts whose answer never arrived, by command, for a faithful retry. */
  const unanswered = useRef(new Map<string, AgentControlRequestId>());

  useEffect(() => {
    // Off: the returned state says so (below); nothing to bind.
    if (agentControlOff) return;
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
  }, [agentControlOff, environmentId, projectId]);

  const command = async (input: AutomationCommandDraft): Promise<boolean> => {
    if (!capability.allowed || agentControlOff || pending.current) return false;
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
    if (!capability.allowed || agentControlOff || pending.current) return;
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
    snapshot: agentControlOff ? null : snapshot,
    providers,
    error: agentControlOff ? AGENT_CONTROL_OFF_ERROR : error,
    busy: agentControlOff ? false : busy,
    disabledReason: capability.allowed
      ? null
      : (hostedCapabilityCopy(capability, nodeLabel) ?? "Automation changes are unavailable."),
    command,
    decide,
    refresh: () => void refresh.current(),
  };
}
