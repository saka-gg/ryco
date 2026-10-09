import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";
import { buildChatDraftTarget, useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { newProjectId } from "../lib/utils";
import { createHostedDraftTargetController } from "../hostedHub/draftExecutionTarget";
import {
  nodeIdForHostedEnvironment,
  readHostedNodeMutationLease,
  readHostedWorkspaceState,
  waitForHostedNodeMutationLease,
} from "../hostedHub/hostedConnectionCoordinator";
import { hostedWebConnectionScopes } from "../hostedHub/hostedConnectionScopes";
import {
  adoptRoutedHostedNode,
  getRoutedHostedNode,
  subscribeRoutedHostedNode,
} from "../hostedHub/nodeRoutes";
import { hostedHubController, useHostedHubStore } from "../hostedHub/state";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { selectProjectsForEnvironment, useStore } from "../store";
import { useSettings } from "./useSettings";

export const hostedDraftTargetController = createHostedDraftTargetController({
  sourceIsCurrent: (request) => {
    const draft = useComposerDraftStore.getState().getDraftSession(request.draftId);
    return (
      draft?.promotedTo == null &&
      draft?.environmentId === request.sourceEnvironmentId &&
      draft.projectId === request.sourceProjectId
    );
  },
  targetIsEligible: (environmentId) => {
    const workspace = readHostedWorkspaceState();
    return (
      workspace.status === "ready" &&
      workspace.machines.some(
        (machine) => machine.environmentId === environmentId && machine.canMutate,
      )
    );
  },
  routeMatches: (request) => {
    const route = getRoutedHostedNode();
    return (
      route.nodeId === nodeIdForHostedEnvironment(request.environmentId) &&
      route.logicalPathname === "/draft/" + encodeURIComponent(request.draftId)
    );
  },
  subscribeRoute: subscribeRoutedHostedNode,
  retain: (environmentId) =>
    hostedWebConnectionScopes.retain(environmentId, { type: "interactive" }),
  adopt: (environmentId) => {
    const nodeId = nodeIdForHostedEnvironment(environmentId);
    return nodeId !== null && adoptRoutedHostedNode(nodeId);
  },
  waitForLease: waitForHostedNodeMutationLease,
  readLease: readHostedNodeMutationLease,
  readProjects: (environmentId) => selectProjectsForEnvironment(useStore.getState(), environmentId),
  canPreviewProjects: (environmentId) =>
    useStore.getState().environmentStateById[environmentId]?.hydratedFromCacheAt !== undefined,
  subscribeProjects: useStore.subscribe,
  move: (draftId, project, logicalProjectKey) =>
    useComposerDraftStore.getState().moveDraftThreadToProject(draftId, {
      projectRef: scopeProjectRef(project.environmentId, project.id),
      logicalProjectKey,
    }),
  moveToChat: (draftId, environmentId) =>
    useComposerDraftStore
      .getState()
      .moveDraftThreadToProject(draftId, buildChatDraftTarget(environmentId, newProjectId())),
  retry: (environmentId) => {
    if (useHostedHubStore.getState().selectedNode?.environmentId === environmentId)
      void hostedHubController.retrySelectedNode();
  },
});

export function useHostedDraftTargetSelection() {
  return useSyncExternalStore(
    hostedDraftTargetController.subscribe,
    hostedDraftTargetController.getSnapshot,
  );
}

export function useHostedDraftExecutionTarget(input: {
  readonly draftId: DraftId | null | undefined;
  readonly project: Project | null;
  readonly locked: boolean;
}) {
  const settings = useSettings((value) => ({
    sidebarProjectGroupingMode: value.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: value.sidebarProjectGroupingOverrides,
  }));
  const selection = useHostedDraftTargetSelection();
  return {
    pending: selection?.draftId === input.draftId ? selection : null,
    selectEnvironment: (environmentId: EnvironmentId) => {
      if (input.locked || !input.draftId || !input.project) return;
      const machine = readHostedWorkspaceState().machines.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (machine)
        hostedDraftTargetController.begin({
          draftId: input.draftId,
          project: input.project,
          environmentId,
          label: machine.label,
          logicalKey: (project) => deriveLogicalProjectKeyFromSettings(project, settings),
        });
    },
    cancel: () => hostedDraftTargetController.cancel(),
    retry: hostedDraftTargetController.retry,
    selectProject: hostedDraftTargetController.selectProject,
    selectNoProject: hostedDraftTargetController.selectNoProject,
  };
}
