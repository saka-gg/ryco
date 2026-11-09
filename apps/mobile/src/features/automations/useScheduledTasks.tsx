import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAgentControlStore } from "../../state/agentControlRuntime";
import { useAgentControlSync } from "../../state/agentControlSync";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { useTaskMachines } from "../tasks/useMachineTasks";
import {
  buildScheduledList,
  type ScheduledCheckoutRef,
  type ScheduledFilter,
  type ScheduledList,
} from "./scheduledModel";
import {
  requestScheduled,
  useDismissedScheduleProposals,
  useScheduledEntries,
} from "./scheduledRuntime";

/** A machine whose schedules the phone reads, with its projects. */
export interface ScheduledMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
}

/**
 * The machines whose schedules show: the Tasks tab's machines (the node owner's) that are
 * connected now and whose Agent Control is not turned off (the automation centre is part of
 * it). A machine whose config has not arrived yet is asked anyway; its node decides.
 */
export function useScheduledMachines(): ReadonlyArray<ScheduledMachine> {
  const machines = useTaskMachines();
  const configs = useEnvironmentServerConfigs();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useMemo(
    () =>
      machines
        .filter(
          (machine) =>
            machine.connected &&
            configs.get(machine.environmentId)?.settings.agentControl.enabled !== false,
        )
        .map((machine) => ({
          environmentId: machine.environmentId,
          label: machine.label,
          projects: excludeChatProjects(
            projects.filter((project) => project.environmentId === machine.environmentId),
          ).map((project) => ({ id: project.id, name: project.name })),
        })),
    [configs, machines, projects],
  );
}

/** How often an open list reads its snapshots again besides the queue's changes. */
const SWEEP_MS = 5 * 60_000;

function useMinuteClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

export interface ScheduledTasks {
  readonly list: ScheduledList;
  readonly machines: ReadonlyArray<ScheduledMachine>;
  readonly checkouts: ReadonlyArray<ScheduledCheckoutRef>;
  readonly loading: boolean;
  readonly nowMs: number;
  /** Reads every listed checkout again (pull to refresh). */
  readonly refresh: () => void;
}

/**
 * Every listed project's schedules, read while `active` (the screen is in front): once on
 * arrival, every five minutes, and for a project whenever its machine's Agent Control queue
 * moves. Mount `ScheduledQueueSync` next to it for the queues.
 */
export function useScheduledTasks(input: {
  readonly filter: ScheduledFilter;
  readonly active: boolean;
}): ScheduledTasks {
  const machines = useScheduledMachines();
  const checkouts = useMemo<ReadonlyArray<ScheduledCheckoutRef>>(
    () =>
      machines.flatMap((machine) =>
        machine.projects.map((project) => ({
          environmentId: machine.environmentId,
          projectId: project.id,
          projectName: project.name,
          machineLabel: machine.label,
        })),
      ),
    [machines],
  );
  const nowMs = useMinuteClock();
  const checkoutsKey = checkouts
    .map((checkout) => `${checkout.environmentId}:${checkout.projectId}`)
    .join("|");
  // Queue changes re-read the projects they concern (`scheduledRuntime`); this sweep catches
  // what moves without a proposal (a run that starts without asking) every few minutes.
  const sweep = Math.floor(nowMs / SWEEP_MS);
  useEffect(() => {
    if (input.active) requestScheduled(checkouts);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the checkouts' ids
  }, [input.active, checkoutsKey, sweep]);
  const state = useScheduledEntries();
  const queuesById = useAgentControlStore((store) => store.queueByEnvironmentId);
  const dismissed = useDismissedScheduleProposals((store) => store.ids);
  const list = useMemo(() => {
    const queues = new Map(
      machines.map((machine) => [
        machine.environmentId,
        Object.values(queuesById[machine.environmentId]?.proposalsById ?? {}),
      ]),
    );
    return buildScheduledList({
      checkouts,
      entries: state.entries,
      queues,
      dismissed,
      filter: input.filter,
      nowMs,
    });
  }, [checkouts, dismissed, input.filter, machines, nowMs, queuesById, state.entries]);
  return {
    list,
    machines,
    checkouts,
    loading: state.loading,
    nowMs,
    refresh: () => requestScheduled(checkouts, { fresh: true }),
  };
}

function MachineQueueSync(props: { readonly environmentId: EnvironmentId }) {
  useAgentControlSync(props.environmentId, true);
  return null;
}

/** Keeps each listed machine's Agent Control queue live while mounted (waiting runs, changes). */
export function ScheduledQueueSync(props: { readonly machines: ReadonlyArray<ScheduledMachine> }) {
  return (
    <>
      {props.machines.map((machine) => (
        <MachineQueueSync key={machine.environmentId} environmentId={machine.environmentId} />
      ))}
    </>
  );
}
