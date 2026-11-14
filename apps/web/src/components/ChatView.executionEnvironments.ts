/**
 * The devices a ChatView can run on: the logical project's checkouts across
 * environments (the execution target picker) and, for an unsent "No project"
 * chat, every reachable device. Pure: ChatView memoizes both.
 */
import {
  isSavedEnvironmentSwitchedOff,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "@ryco/client-runtime/connection";
import type { DesktopWorkspaceStateProjection, EnvironmentId, ProjectId } from "@ryco/contracts";

import { resolveChatsAvailability } from "../composerDraftStore";
import { resolveEnvironmentOptionLabel } from "../environmentDisplay";
import type { HostedWorkspaceSnapshot } from "../hostedHub/hostedConnectionCoordinator";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";
import type { withDirectDesktopExecutionMachine } from "../platform/desktopWorkspaceTarget";
import type { Project } from "../types";
import type { ChatExecutionCandidate } from "./chat/ExecutionTarget.logic";

type DesktopExecutionMachine = ReturnType<typeof withDirectDesktopExecutionMachine>[number];

export interface LogicalProjectEnvironmentsInput {
  readonly primaryDeviceName: string;
  readonly desktopWorkspace: DesktopWorkspaceStateProjection;
  readonly hostedWorkspace: HostedWorkspaceSnapshot;
  readonly activeProject: Project | undefined;
  readonly allProjects: Project[];
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironmentRegistry: Record<EnvironmentId, SavedEnvironmentRecord>;
  readonly savedEnvironmentRuntimeById: Record<EnvironmentId, SavedEnvironmentRuntimeState>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly desktopExecutionMachines: ReadonlyArray<DesktopExecutionMachine>;
}

/** The environments the active project's logical project is checked out on, primary first. */
export function deriveLogicalProjectEnvironments(input: LogicalProjectEnvironmentsInput) {
  const {
    primaryDeviceName,
    desktopWorkspace,
    hostedWorkspace,
    activeProject,
    allProjects,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    projectGroupingSettings,
    desktopExecutionMachines,
  } = input;
  if (!activeProject) return [];
  const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
  const memberProjects = allProjects.filter(
    (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
  );
  const seen = new Set<string>();
  const envs: Array<{
    environmentId: EnvironmentId;
    projectId: ProjectId;
    label: string;
    isPrimary: boolean;
    disabled?: boolean;
  }> = [];
  for (const p of memberProjects) {
    if (seen.has(p.environmentId)) continue;
    seen.add(p.environmentId);
    const isPrimary = p.environmentId === primaryEnvironmentId;
    const savedRecord = savedEnvironmentRegistry[p.environmentId];
    const runtimeState = savedEnvironmentRuntimeById[p.environmentId];
    const desktopMachine = desktopExecutionMachines.find(
      (machine) => machine.environmentId === p.environmentId,
    );
    const hostedMachine = hostedWorkspace.machines.find(
      (machine) => machine.environmentId === p.environmentId,
    );
    const workspaceMachine =
      hostedWorkspace.status === "signed-out" ? desktopMachine : hostedMachine;
    const fallbackLabel = resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: p.environmentId,
      runtimeLabel: runtimeState?.descriptor?.label ?? null,
      savedLabel: savedRecord?.label ?? null,
    });
    const label = workspaceMachine?.label ?? (isPrimary ? primaryDeviceName : fallbackLabel);
    envs.push({
      environmentId: p.environmentId,
      projectId: p.id,
      label,
      isPrimary,
      ...(desktopWorkspace.status === "ready" || hostedWorkspace.status === "ready"
        ? { disabled: workspaceMachine?.canMutate !== true }
        : {}),
    });
  }
  // Sort: primary first, then alphabetical
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}

export interface ChatExecutionCandidatesInput {
  readonly primaryDeviceName: string;
  readonly desktopWorkspace: DesktopWorkspaceStateProjection;
  readonly hostedWorkspace: HostedWorkspaceSnapshot;
  readonly isPendingChat: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironmentRegistry: Record<EnvironmentId, SavedEnvironmentRecord>;
  readonly savedEnvironmentRuntimeById: Record<EnvironmentId, SavedEnvironmentRuntimeState>;
  readonly desktopExecutionMachines: ReadonlyArray<DesktopExecutionMachine>;
  readonly primaryChatsAvailable: boolean | null;
}

/** Where an unsent "No project" chat may run: any reachable device whose node supports chats. */
export function deriveChatExecutionCandidates(
  input: ChatExecutionCandidatesInput,
): ReadonlyArray<ChatExecutionCandidate> {
  const {
    primaryDeviceName,
    desktopWorkspace,
    hostedWorkspace,
    isPendingChat,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    desktopExecutionMachines,
    primaryChatsAvailable,
  } = input;
  if (!isPendingChat || hostedWorkspace.status !== "signed-out") return [];
  const chatsAvailable = (candidateEnvironmentId: EnvironmentId) => {
    if (candidateEnvironmentId === primaryEnvironmentId) return primaryChatsAvailable;
    const config = savedEnvironmentRuntimeById[candidateEnvironmentId]?.serverConfig;
    return config ? resolveChatsAvailability(config).available : null;
  };
  if (desktopWorkspace.status === "ready") {
    return desktopExecutionMachines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      reachable: machine.canMutate,
      chatsAvailable: chatsAvailable(machine.environmentId),
    }));
  }
  return [
    ...(primaryEnvironmentId
      ? [
          {
            environmentId: primaryEnvironmentId,
            label: primaryDeviceName,
            reachable: true,
            chatsAvailable: primaryChatsAvailable,
          },
        ]
      : []),
    ...Object.values(savedEnvironmentRegistry).flatMap((record) => {
      // A machine switched off is not offered: it would only ever be unreachable.
      if (isSavedEnvironmentSwitchedOff(record)) return [];
      const runtime = savedEnvironmentRuntimeById[record.environmentId];
      return {
        environmentId: record.environmentId,
        label: resolveEnvironmentOptionLabel({
          isPrimary: false,
          environmentId: record.environmentId,
          runtimeLabel: runtime?.descriptor?.label ?? null,
          savedLabel: record.label,
        }),
        reachable: runtime?.connectionState === "connected",
        chatsAvailable: chatsAvailable(record.environmentId),
      };
    }),
  ];
}
