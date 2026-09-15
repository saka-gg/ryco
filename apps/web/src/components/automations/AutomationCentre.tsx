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
import { createAutomationCentreReader } from "@ryco/client-runtime/state/agentControl";
import { readEnvironmentApi, readEnvironmentApiForConnection } from "../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { AutomationCentreView, type AutomationCommandDraft } from "./AutomationCentreView";

export function AutomationCentre({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const capability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCommand);
  const [snapshot, setSnapshot] = useState<AutomationCentreSnapshot | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const requests = useRef(new Map<string, AgentControlRequestId>());

  useEffect(() => {
    let client: unknown = undefined;
    let stop = () => {};
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
      const unsubscribe = api.agentControl?.subscribeProposals(() => void reader.refresh(), {
        onResubscribe: () => void reader.refresh(),
        onError: () => {
          reader.invalidate();
          if (generation.current === epoch) {
            setSnapshot(null);
            setError("Automation access is unavailable.");
          }
        },
      });
      void next!.server
        .getConfig()
        .then((config) => {
          if (generation.current === epoch) setProviders(config.providers);
        })
        .catch(() => {});
      void reader.refresh();
      stop = () => {
        reader.stop();
        unsubscribe?.();
        refresh.current = async () => {};
      };
    };
    const unsubscribe = subscribeEnvironmentConnections(bind);
    bind();
    const onFocus = () => void refresh.current();
    window.addEventListener("focus", onFocus);
    return () => {
      ++generation.current;
      stop();
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [environmentId, projectId]);

  const command = async (input: AutomationCommandDraft): Promise<boolean> => {
    if (!capability.allowed || pending.current) return false;
    const api = readEnvironmentApi(environmentId)?.automationCentre;
    if (!api) return false;
    const epoch = generation.current;
    const key = JSON.stringify(input);
    const requestId = requests.current.get(key) ?? AgentControlRequestId.make(crypto.randomUUID());
    requests.current.set(key, requestId);
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.command({ ...input, requestId } as AutomationCentreCommand);
      if (epoch !== generation.current) return false;
      await refresh.current();
      return true;
    } catch (cause) {
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
  return (
    <AutomationCentreView
      environmentId={environmentId}
      projectId={projectId}
      snapshot={snapshot}
      providers={providers}
      busy={busy}
      error={error}
      disabledReason={
        capability.allowed ? null : (capability.reason ?? "Automation changes are unavailable.")
      }
      onDecision={decide}
      onRefresh={() => void refresh.current()}
      onCommand={command}
    />
  );
}
