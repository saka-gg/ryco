import {
  deriveDialogRows,
  type DialogCheckoutRows,
  type DialogRow,
} from "@ryco/client-runtime/state/automations/dialogModel";
import { automationCheckoutKey } from "@ryco/client-runtime/state/automations/projectCounts";
import type {
  AgentControlProposalId,
  AgentControlProposalView,
  AgentTokenMode,
  AutomationCentreSnapshot,
  EnvironmentId,
  ProjectId,
  ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_AGENT_TOKEN_MODE } from "@ryco/contracts/orchestration";
import { useEffect, useMemo, useState } from "react";

import { useAgentControlStore } from "../../state/agentControlRuntime";
import { useAgentControlSync } from "../../state/agentControlSync";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { useShallow } from "zustand/react/shallow";
import {
  loadSavedScheduled,
  requestScheduled,
  useDismissedScheduleProposals,
  useScheduledEntries,
} from "./scheduledRuntime";
import { useTaskMachines } from "../tasks/useMachineTasks";
import { useScheduleAccess } from "./scheduleAccess";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_PROPOSALS: ReadonlyArray<AgentControlProposalView> = [];

export interface ScheduleCheckout {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly machineLabel: string;
  /** Null until read; "unavailable" when the machine refused or was unreachable. */
  readonly snapshot: AutomationCentreSnapshot | null;
  readonly status: "loading" | "ready" | "unavailable";
  readonly rows: ReadonlyArray<DialogRow>;
  readonly group: DialogCheckoutRows | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The token mode a run without its own starts with (the machine's default). */
  readonly defaultTokenMode: AgentTokenMode;
  readonly queueProposals: ReadonlyArray<AgentControlProposalView>;
  /** Expired or failed proposals dismissed this session. */
  readonly dismissed: ReadonlySet<AgentControlProposalId>;
  /** Connected now: its schedules can be read. */
  readonly connected: boolean;
  /**
   * This device may change its schedules and decide their proposals now (owner, connected,
   * writes synchronized: `scheduleAccessOf`).
   */
  readonly editable: boolean;
  /** Why changes are off, or null when they are on. */
  readonly readOnlyReason: string | null;
  readonly nowMs: number;
  readonly refresh: () => void;
}

/**
 * One project's schedules on one machine, kept live while mounted: read on arrival, again
 * whenever its machine's Agent Control queue moves (the shared runtime's watch), and every
 * half minute for the clock.
 */
export function useScheduleCheckout(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ScheduleCheckout {
  const machine = useTaskMachines().find((candidate) => candidate.environmentId === environmentId);
  const configs = useEnvironmentServerConfigs();
  const config = configs.get(environmentId);
  const connected = machine?.connected ?? false;
  const access = useScheduleAccess()(environmentId);
  useAgentControlSync(environmentId, connected && config?.settings.agentControl.enabled !== false);
  const project = useStore(
    useShallow((state) =>
      selectProjectsAcrossEnvironments(state).find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
      ),
    ),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    // The saved schedules show at once; a connected machine reads them again behind.
    loadSavedScheduled([{ environmentId, projectId }]);
    if (connected) requestScheduled([{ environmentId, projectId }], { fresh: true });
  }, [connected, environmentId, projectId]);
  const state = useScheduledEntries();
  const entry = state.entries.get(automationCheckoutKey(environmentId, projectId));
  const queue = useAgentControlStore((store) => store.queueByEnvironmentId[environmentId]);
  const queueProposals = useMemo(
    () => (queue ? Object.values(queue.proposalsById) : NO_PROPOSALS),
    [queue],
  );
  const dismissed = useDismissedScheduleProposals((store) => store.ids);
  const snapshot = entry?.status === "ready" ? entry.snapshot : null;
  const projectName = project?.name ?? "Project";
  const machineLabel = machine?.label ?? "Machine";
  const group = useMemo(
    () =>
      snapshot
        ? (deriveDialogRows(
            [
              {
                key: automationCheckoutKey(environmentId, projectId),
                environmentId,
                projectId,
                deviceLabel: machineLabel,
                snapshot,
              },
            ],
            new Map([
              [automationCheckoutKey(environmentId, projectId), { queueProposals, dismissed }],
            ]),
            nowMs,
          )[0] ?? null)
        : null,
    [dismissed, environmentId, machineLabel, nowMs, projectId, queueProposals, snapshot],
  );
  return {
    environmentId,
    projectId,
    projectName,
    machineLabel,
    snapshot,
    status: entry === undefined ? "loading" : entry.status,
    rows: group?.rows ?? [],
    group,
    providers: config?.providers ?? NO_PROVIDERS,
    defaultTokenMode: config?.settings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    queueProposals,
    dismissed,
    connected,
    editable: access.editable,
    readOnlyReason: access.reason,
    nowMs,
    refresh: () => requestScheduled([{ environmentId, projectId }], { fresh: true }),
  };
}
