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
  loadSavedScheduled,
  requestScheduled,
  useDismissedScheduleProposals,
  useSavedScheduleEnvironments,
  useScheduledEntries,
} from "./scheduledRuntime";

/** A machine whose schedules the phone reads, with its projects. */
export interface ScheduledMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly connected: boolean;
}

/**
 * The machines whose schedules show: the Tasks tab's machines (the node owner's) that are
 * connected now and whose Agent Control is not turned off (the automation centre is part of
 * it). A machine whose config has not arrived yet is asked anyway; its node decides.
 */
export function useScheduledMachines(
  options: { readonly includeOffline?: boolean } = {},
): ReadonlyArray<ScheduledMachine> {
  const machines = useTaskMachines();
  const configs = useEnvironmentServerConfigs();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  // A machine not connected yet shows while its saved schedules stand in for it.
  const saved = useSavedScheduleEnvironments();
  const includeOffline = options.includeOffline === true;
  return useMemo(
    () =>
      machines
        .filter(
          (machine) =>
            (machine.connected || includeOffline || saved.has(machine.environmentId)) &&
            configs.get(machine.environmentId)?.settings.agentControl.enabled !== false,
        )
        .map((machine) => ({
          environmentId: machine.environmentId,
          label: machine.label,
          projects: excludeChatProjects(
            projects.filter((project) => project.environmentId === machine.environmentId),
          ).map((project) => ({ id: project.id, name: project.name })),
          connected: machine.connected,
        })),
    [configs, includeOffline, machines, projects, saved],
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
  // Every machine's saved schedules are looked up (once), connected or not.
  const everyMachine = useScheduledMachines({ includeOffline: true });
  const everyCheckoutKey = everyMachine
    .flatMap((machine) =>
      machine.projects.map((project) => `${machine.environmentId}:${project.id}`),
    )
    .join("|");
  useEffect(() => {
    loadSavedScheduled(
      everyMachine.flatMap((machine) =>
        machine.projects.map((project) => ({
          environmentId: machine.environmentId,
          projectId: project.id,
        })),
      ),
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the checkouts' ids
  }, [everyCheckoutKey]);
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
  // A machine that connects is read at once (its saved schedules showed until then).
  const connectedKey = machines
    .filter((machine) => machine.connected)
    .map((machine) => machine.environmentId)
    .join("|");
  useEffect(() => {
    // Only a connected machine can answer; the others show what was saved.
    if (input.active) {
      const connected = new Set(
        machines.filter((machine) => machine.connected).map((machine) => machine.environmentId),
      );
      requestScheduled(checkouts.filter((checkout) => connected.has(checkout.environmentId)));
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed by the checkouts' ids
  }, [input.active, checkoutsKey, connectedKey, sweep]);
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
    refresh: () => {
      const connected = new Set(
        machines.filter((machine) => machine.connected).map((machine) => machine.environmentId),
      );
      requestScheduled(
        checkouts.filter((checkout) => connected.has(checkout.environmentId)),
        { fresh: true },
      );
    },
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
