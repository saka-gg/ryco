import { nodeMutationLeaseIsCurrent } from "@ryco/client-runtime/authorization";
import { toastManager } from "../components/ui/toast";
import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "@ryco/client-runtime/state/settings";
import { ensureEnvironmentApi } from "../environmentApi";
import { useDeviceName } from "../deviceName";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_RUNTIME_MODE,
  type EffectiveProjectPreferences,
  type EnvironmentId,
  type ProjectId,
  type ScopedProjectRef,
  type ServerConfig,
  type ModelSelection,
  type RuntimeMode,
  type AgentTokenMode,
  type ThreadId,
} from "@ryco/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { excludeChatProjects, isChatProject } from "@ryco/shared/projectKind";
import {
  buildChatDraftTarget,
  isPendingChatDraft,
  resolveChatsAvailability,
  type DraftThreadEnvMode,
  type DraftThreadState,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newProjectId, newThreadId } from "../lib/utils";
import { useChatsAvailability } from "./useChatsAvailability";
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
  modelSelection?: ModelSelection;
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

  /**
   * Hosted nodes accept drafts only under a current mutation lease. Returns
   * null when no wait is needed, else whether a lease arrived.
   */
  const pendingHostedLease = useCallback(
    (environmentId: EnvironmentId): Promise<boolean> | null => {
      if (nodeIdForHostedEnvironment(environmentId) === null) return null;
      adoptHostedTarget(environmentId);
      if (readHostedNodeMutationLease(environmentId) !== null) return null;
      return waitForHostedNodeMutationLease(environmentId).then((lease) => lease !== null);
    },
    [adoptHostedTarget],
  );

  /**
   * The shared tail of every fresh draft: read the owning node's defaults,
   * register the draft session, seed sticky and initial model state, and open
   * it. `register` decides what kind of draft it is (project or chat).
   */
  const createAndOpenDraft = useCallback(
    (input: {
      readonly environmentId: EnvironmentId;
      readonly draftId: DraftId;
      /** Project whose effective preferences apply; undefined reads the node defaults. */
      readonly preferencesProjectId: ProjectId | undefined;
      readonly explicitModelSelection: ModelSelection | undefined;
      /** Another creation won while the defaults RPC was in flight. */
      readonly superseded: () => boolean;
      readonly resume: () => Promise<void>;
      readonly register: (
        config: ServerConfig,
        effective: EffectiveProjectPreferences | null,
      ) => void;
      readonly failureTitle: string;
    }): Promise<void> =>
      (async () => {
        const hosted = nodeIdForHostedEnvironment(input.environmentId) !== null;
        const leaseBefore = hosted ? readHostedNodeMutationLease(input.environmentId) : null;
        const api = ensureEnvironmentApi(input.environmentId);
        if (!api.server?.getConfig)
          throw new Error("Node settings are still loading. Try creating the draft again.");
        // Read from the scoped connection: a hosted node's local descriptor may
        // differ from its canonical identity, and the primary cache can still
        // contain the previous node's settings while switching targets.
        const config = await api.server.getConfig();
        const effective = await readEffectiveProjectPreferences({
          api,
          config,
          ...(input.preferencesProjectId ? { projectId: input.preferencesProjectId } : {}),
        });
        const leaseAfter = hosted ? readHostedNodeMutationLease(input.environmentId) : null;
        if (
          hosted &&
          (!leaseBefore ||
            !leaseAfter ||
            !nodeMutationLeaseIsCurrent(leaseBefore, input.environmentId, leaseAfter))
        )
          throw new Error("The workspace connection changed. Try creating the draft again.");
        if (input.superseded()) return input.resume();
        input.register(config, effective);
        const store = useComposerDraftStore.getState();
        store.applyStickyState(input.draftId);
        const initialModel = input.explicitModelSelection ?? effective?.initialModelSelection.value;
        if (initialModel)
          store.setModelSelection(
            input.draftId,
            initialDraftModelSelection({
              effective,
              fallback: initialModel,
              explicit: input.explicitModelSelection,
            }),
          );

        adoptHostedTarget(input.environmentId);
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: input.draftId },
        });
      })().catch((cause) => {
        toastManager.add({
          type: "error",
          title: input.failureTitle,
          description:
            cause instanceof Error ? cause.message : "Reconnect to this node and try again.",
        });
      }),
    [adoptHostedTarget, router],
  );

  const handleNewThread: (
    projectRef: ScopedProjectRef,
    options?: NewThreadOptions,
  ) => Promise<void> = useCallback(
    function handleNewThread(
      projectRef: ScopedProjectRef,
      options?: NewThreadOptions,
    ): Promise<void> {
      const leaseWait = pendingHostedLease(projectRef.environmentId);
      if (leaseWait) {
        return leaseWait.then((ready) => {
          if (!ready) {
            if (options?.freshDraft)
              throw new Error("The workspace is unavailable. Your selection draft is preserved.");
            return;
          }
          return handleNewThread(projectRef, options);
        });
      }
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
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
      return createAndOpenDraft({
        environmentId: projectRef.environmentId,
        draftId,
        preferencesProjectId: projectRef.projectId,
        explicitModelSelection: options?.modelSelection,
        superseded: () => getDraftSessionByLogicalProjectKey(logicalProjectKey) !== null,
        resume: () => handleNewThread(projectRef, options),
        register: (config, effective) =>
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
            threadId,
            createdAt,
            branch: options?.branch ?? null,
            worktreePath: options?.worktreePath ?? null,
            envMode:
              options?.envMode ??
              effective?.defaultThreadEnvMode.value ??
              config.settings.defaultThreadEnvMode,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            tokenMode: config.settings.defaultAgentTokenMode,
          }),
        failureTitle: "Could not create a draft",
      });
    },
    [
      adoptHostedTarget,
      createAndOpenDraft,
      getCurrentRouteTarget,
      pendingHostedLease,
      projectGroupingSettings,
      router,
      projects,
    ],
  );

  /**
   * Opens a "No project" chat draft on an environment: the environment's
   * unsent chat draft when there is one, else a fresh one with a
   * client-generated project id that the first send asks the server to create.
   */
  const handleNewChat = useCallback(
    function handleNewChat(environmentId: EnvironmentId): Promise<void> {
      const leaseWait = pendingHostedLease(environmentId);
      if (leaseWait) {
        return leaseWait.then((ready) => (ready ? handleNewChat(environmentId) : undefined));
      }
      const existing = useComposerDraftStore.getState().getPendingChatDraftSession(environmentId);
      if (existing) {
        const currentRouteTarget = getCurrentRouteTarget();
        if (currentRouteTarget?.kind === "draft" && currentRouteTarget.draftId === existing.draftId)
          return Promise.resolve();
        adoptHostedTarget(environmentId);
        return router
          .navigate({ to: "/draft/$draftId", params: { draftId: existing.draftId } })
          .then(() => undefined);
      }
      const draftId = newDraftId();
      const threadId = newThreadId();
      const target = buildChatDraftTarget(environmentId, newProjectId());
      const createdAt = new Date().toISOString();
      return createAndOpenDraft({
        environmentId,
        draftId,
        // The chat project does not exist yet; the node's defaults apply.
        preferencesProjectId: undefined,
        explicitModelSelection: undefined,
        superseded: () =>
          useComposerDraftStore.getState().getPendingChatDraftSession(environmentId) !== null,
        resume: () => handleNewChat(environmentId),
        register: (config) => {
          const availability = resolveChatsAvailability(config);
          if (!availability.available) throw new Error(availability.message);
          useComposerDraftStore
            .getState()
            .setLogicalProjectDraftThreadId(target.logicalProjectKey, target.projectRef, draftId, {
              threadId,
              createdAt,
              envMode: "local",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              tokenMode: config.settings.defaultAgentTokenMode,
              pendingChat: true,
            });
        },
        failureTitle: "Could not start a chat",
      });
    },
    [adoptHostedTarget, createAndOpenDraft, getCurrentRouteTarget, pendingHostedLease, router],
  );
  return { handleNewThread, handleNewChat };
}

export function useNewThreadHandler() {
  const { handleNewThread, handleNewChat } = useNewThreadState();

  return {
    handleNewThread,
    handleNewChat,
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
      // A chat is never the default target of "new thread".
      items: excludeChatProjects(projects),
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const { handleNewThread, handleNewChat } = useNewThreadState();
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
  // "No project" context: an unsent chat draft or a thread inside a chat project.
  const activeContextProjectRef = actionActiveThread ?? actionActiveDraftThread ?? null;
  const activeContextIsChat =
    isPendingChatDraft(actionActiveDraftThread) ||
    (activeContextProjectRef !== null &&
      isChatProject(
        projects.find(
          (project) =>
            project.id === activeContextProjectRef.projectId &&
            project.environmentId === activeContextProjectRef.environmentId,
        ),
      ));
  // Chats start where the user already is, else on the default project's node.
  const chatEnvironmentId =
    activeContextProjectRef?.environmentId ??
    defaultProjectRef?.environmentId ??
    selectedHostedEnvironmentId ??
    primaryEnvironmentId;
  const chatsAvailability = useChatsAvailability(chatEnvironmentId);
  const chatTarget = useMemo(
    () =>
      chatEnvironmentId && chatsAvailability.available
        ? { environmentId: chatEnvironmentId }
        : null,
    [chatEnvironmentId, chatsAvailability.available],
  );

  return {
    activeDraftThread: actionActiveDraftThread,
    activeThread: actionActiveThread,
    activeContextIsChat,
    defaultProjectRef,
    handleNewThread,
    handleNewChat,
    /** Where "No project" chats start right now; null hides every chat entry point. */
    chatTarget,
    chatsAvailability,
    routeThreadRef,
  };
}
