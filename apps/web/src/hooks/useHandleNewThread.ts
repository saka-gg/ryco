import { useDeviceName } from "../deviceName";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_RUNTIME_MODE,
  type ScopedProjectRef,
  type ModelSelection,
  type RuntimeMode,
  type AgentTokenMode,
  type ThreadId,
} from "@ryco/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { deriveLogicalProjectKeyFromSettings, getProjectOrderKey } from "../logicalProject";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import {
  resolveWorkspaceDefaultProjectRef,
  withDirectDesktopExecutionMachine,
} from "../platform/desktopWorkspaceTarget";
import {
  nodeIdForHostedEnvironment,
  readHostedNodeMutationLease,
  useHostedWorkspaceState,
  waitForHostedNodeMutationLease,
} from "../hostedHub/hostedConnectionCoordinator";
import { adoptRoutedHostedNode } from "../hostedHub/nodeRoutes";
import { useHostedHubStore } from "../hostedHub/state";
import { usePrimaryEnvironmentId } from "../environments/primary";

export interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  /** The caller owns this stable identity across failed navigation attempts. */
  freshDraft?: {
    draftId: DraftId;
    threadId: ThreadId;
    prompt: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    tokenMode: AgentTokenMode;
    isCurrent: () => boolean;
  };
}

function useNewThreadState() {
  const seededDrafts = useRef(
    new Map<
      DraftId,
      {
        composer: ReturnType<ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]>;
        session: DraftThreadState | undefined;
      }
    >(),
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
    defaultAgentTokenMode: settings.defaultAgentTokenMode,
  }));
  const router = useRouter();
  const adoptHostedTarget = useCallback((environmentId: ScopedProjectRef["environmentId"]) => {
    const nodeId = nodeIdForHostedEnvironment(environmentId);
    if (nodeId) adoptRoutedHostedNode(nodeId);
  }, []);
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  const handleNewThread: (
    projectRef: ScopedProjectRef,
    options?: NewThreadOptions,
  ) => Promise<void> = useCallback(
    (projectRef: ScopedProjectRef, options?: NewThreadOptions): Promise<void> => {
      const hostedNodeId = nodeIdForHostedEnvironment(projectRef.environmentId);
      if (hostedNodeId !== null) {
        adoptHostedTarget(projectRef.environmentId);
        if (readHostedNodeMutationLease(projectRef.environmentId) === null) {
          return waitForHostedNodeMutationLease(projectRef.environmentId).then((lease) => {
            if (lease === null) {
              if (options?.freshDraft)
                throw new Error("The workspace is unavailable. Your selection draft is preserved.");
              return;
            }
            return handleNewThread(projectRef, options);
          });
        }
      }
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      if (options?.freshDraft) {
        const fresh = options.freshDraft;
        if (!fresh.isCurrent())
          throw new Error("The source chat changed. Your selection draft was not sent.");
        const drafts = useComposerDraftStore.getState();
        const assertOwnership = () => {
          const state = useComposerDraftStore.getState();
          const previous = seededDrafts.current.get(fresh.draftId);
          if (
            state.draftThreadsByThreadKey[fresh.draftId] &&
            (!previous ||
              state.getComposerDraft(fresh.draftId) !== previous.composer ||
              state.draftThreadsByThreadKey[fresh.draftId] !== previous.session)
          ) {
            throw new Error(
              "The destination draft changed elsewhere. Both drafts are preserved; open the destination to continue.",
            );
          }
        };
        assertOwnership();
        drafts.createDetachedDraftSession(logicalProjectKey, projectRef, fresh.draftId, {
          threadId: fresh.threadId,
          branch: options.branch ?? null,
          worktreePath: options.worktreePath ?? null,
          envMode: options.envMode ?? "local",
          runtimeMode: fresh.runtimeMode,
          tokenMode: fresh.tokenMode,
        });
        drafts.setPrompt(fresh.draftId, fresh.prompt);
        drafts.setModelSelection(fresh.draftId, fresh.modelSelection);
        drafts.setRuntimeMode(fresh.draftId, fresh.runtimeMode);
        drafts.setTokenMode(fresh.draftId, fresh.tokenMode);
        drafts.setDraftThreadContext(fresh.draftId, {
          branch: options.branch ?? null,
          envMode: options.envMode ?? "local",
        });
        seededDrafts.current.clear();
        seededDrafts.current.set(fresh.draftId, {
          composer: drafts.getComposerDraft(fresh.draftId),
          session: useComposerDraftStore.getState().draftThreadsByThreadKey[fresh.draftId],
        });
        return (async () => {
          await router.navigate({ to: "/draft/$draftId", params: { draftId: fresh.draftId } });
          // The destination composer may initialize non-content defaults on mount.
          // Only user content changes cancel the already-authorized handoff here;
          // retries above still require ownership of the complete draft state.
          const current = useComposerDraftStore.getState().getComposerDraft(fresh.draftId);
          const seeded = seededDrafts.current.get(fresh.draftId)?.composer;
          if (
            current?.prompt !== fresh.prompt ||
            current?.images !== seeded?.images ||
            current?.terminalContexts !== seeded?.terminalContexts ||
            current?.sourceControlContexts !== seeded?.sourceControlContexts
          ) {
            throw new Error(
              "The destination draft changed. Send from the full composer to keep your edits.",
            );
          }
          const target = getCurrentRouteTarget();
          if (target?.kind !== "draft" || target.draftId !== fresh.draftId) {
            throw new Error("Navigation was cancelled. Your selection draft is preserved.");
          }
        })();
      }
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, storedDraftThread.draftId, {
            threadId: storedDraftThread.threadId,
          });
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId
          ) {
            return;
          }
          adoptHostedTarget(projectRef.environmentId);
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: storedDraftThread.draftId },
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          tokenMode: latestActiveDraftThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          tokenMode: projectGroupingSettings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
        });
        applyStickyState(draftId);

        adoptHostedTarget(projectRef.environmentId);
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      })();
    },
    [adoptHostedTarget, getCurrentRouteTarget, projectGroupingSettings, router, projects],
  );
  return handleNewThread;
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();

  return {
    handleNewThread,
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadState();
  const primaryDeviceName = useDeviceName();
  const desktopWorkspace = useDesktopWorkspaceState();
  const hostedWorkspace = useHostedWorkspaceState();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedHostedEnvironmentId = useHostedHubStore(
    (state) => state.selectedNode?.environmentId ?? null,
  );
  const workspace = useMemo(
    () =>
      hostedWorkspace.status === "signed-out"
        ? {
            machines: withDirectDesktopExecutionMachine({
              machines: desktopWorkspace.machines,
              ready: desktopWorkspace.status === "ready",
              primaryEnvironmentId,
              localHubEnvironmentId: desktopWorkspace.localEnvironmentId,
              primaryLabel: primaryDeviceName,
            }),
            ready: desktopWorkspace.status === "ready",
            localEnvironmentId: primaryEnvironmentId,
          }
        : {
            machines: hostedWorkspace.machines.map((machine) => ({
              ...machine,
              online: machine.presence.online,
            })),
            ready: hostedWorkspace.status === "ready",
            localEnvironmentId: null,
          },
    [desktopWorkspace, hostedWorkspace, primaryEnvironmentId, primaryDeviceName],
  );
  const defaultProjectRef = useMemo(
    () =>
      resolveWorkspaceDefaultProjectRef({
        orderedProjects,
        ...workspace,
        logicalKey: (project) =>
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
        ...(hostedWorkspace.status === "signed-out"
          ? {}
          : { preferredEnvironmentId: selectedHostedEnvironmentId }),
      }),
    [
      hostedWorkspace.status,
      orderedProjects,
      projectGroupingSettings,
      selectedHostedEnvironmentId,
      workspace,
    ],
  );

  const actionActiveThread =
    selectedHostedEnvironmentId !== null &&
    activeThread?.environmentId !== selectedHostedEnvironmentId
      ? undefined
      : activeThread;
  const actionActiveDraftThread =
    selectedHostedEnvironmentId !== null &&
    activeDraftThread?.environmentId !== selectedHostedEnvironmentId
      ? null
      : activeDraftThread;

  return {
    activeDraftThread: actionActiveDraftThread,
    activeThread: actionActiveThread,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
  };
}
