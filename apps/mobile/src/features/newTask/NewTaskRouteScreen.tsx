import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "@ryco/client-runtime/state/settings";
import { buildTemporaryWorktreeBranchName } from "@ryco/shared/git";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import {
  normalizeInteractionModeForProviderTarget,
  batchSelectionKey,
  createBatchLaunch,
  prepareBatchDestination,
  captureBatchLaunchReadiness,
  completeBatchSourceReset,
  BATCH_LAUNCH_MAX_TARGETS,
  type BatchLaunchPorts,
  type BatchSourceDraft,
  type BatchLaunch,
} from "@ryco/client-runtime/state/composer";
import { batchLaunchStore, batchSourceDraftStore } from "../../state/batchLaunchStore";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { BatchResults } from "./BatchResults";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  EnvironmentId,
  DEFAULT_AGENT_TOKEN_MODE,
  ProjectId,
  WorktreeId,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@ryco/contracts";

import { OverlayPortalScope } from "../../components/OverlayPortal";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import {
  pickComposerImages,
  toUploadChatImageAttachments,
  type DraftComposerImageAttachment,
} from "../../lib/composerImages";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "../../lib/ids";
import { buildModelOptions } from "../../lib/modelOptions";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useHomeWorkspaceData } from "../../state/homeData";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectSidebarWorktreesForProjectRef,
  selectThreadExistsByRef,
  useStore,
} from "../../state/threadsRuntime";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { inferNodeProjectTitle, validateNodeWorkspacePath } from "../projects/projectActions";
import {
  createNewTaskAttempt,
  resolveMobileNewTaskTarget,
  runNewTaskAttempt,
  type NewTaskAttempt,
  type NewTaskProjectContext,
  type NewTaskWorktreeContext,
} from "./newTaskController";
import { NewTaskComposer } from "./NewTaskComposer";
import { NewTaskContextSheet, type NewTaskWorktreeSelection } from "./NewTaskContextSheet";
import { deriveNewTaskDefaults, resolveNewTaskProjectChoice } from "./newTaskModel";
import { useNewTaskRepository } from "./useNewTaskRepository";

type NewTaskRouteScreenProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function waitForAuthoritative(read: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`${label} was not confirmed`);
}

export function NewTaskRouteScreen(props: NewTaskRouteScreenProps) {
  return (
    <OverlayPortalScope>
      <NewTaskContent {...props} />
    </OverlayPortalScope>
  );
}

function NewTaskContent(props: NewTaskRouteScreenProps) {
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const navigation = useNavigation();
  const environments = useHomeEnvironments();
  const eligibleEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { projects, worktrees, threads } = useHomeWorkspaceData(eligibleEnvironmentIds);
  const launch = useMemo(() => {
    const environmentId = firstParam(props.route.params?.environmentId);
    const projectId = firstParam(props.route.params?.projectId);
    const worktreeId = firstParam(props.route.params?.worktreeId);
    return {
      environmentId: environmentId ? EnvironmentId.make(environmentId) : null,
      projectId: projectId ? ProjectId.make(projectId) : null,
      worktreeId: worktreeId ? WorktreeId.make(worktreeId) : null,
    };
  }, [props.route.params]);
  const defaults = useMemo(
    () => deriveNewTaskDefaults({ launch, environments, projects, worktrees }),
    [environments, launch, projects, worktrees],
  );
  const resolvedDefaultTarget = useMemo(() => {
    if (!defaults.environment || !defaults.project) return null;
    return resolveMobileNewTaskTarget({
      environmentId: defaults.environment.environmentId,
      projectId: defaults.project.id,
      projects,
      environments,
      threads,
      overrideEnvironmentId: launch.environmentId,
    });
  }, [
    defaults.environment,
    defaults.project,
    environments,
    launch.environmentId,
    projects,
    threads,
  ]);
  const initialized = useRef(false);
  const modelEdited = useRef(false);
  const locationEdited = useRef(false);
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [worktreeSelection, setWorktreeSelection] = useState<NewTaskWorktreeSelection>({
    kind: "local",
  });
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection>(defaults.modelSelection);
  const [batchSelections, setBatchSelections] = useState<readonly ModelSelection[]>([]);
  const batchState = batchLaunchStore.useStore();
  const [persistedBatchSource, setBatchSource] = useState<BatchSourceDraft | null>(null);
  const batchSource =
    persistedBatchSource?.environmentId === environmentId &&
    persistedBatchSource?.projectId === projectId
      ? persistedBatchSource
      : null;
  const batchDraftTarget = JSON.stringify([environmentId, projectId]);
  const [readyBatchDraftTarget, setReadyBatchDraftTarget] = useState<string | null>(null);
  const batchDraftReady = readyBatchDraftTarget === batchDraftTarget;
  const batchOwnerKey = batchSource?.id ?? `native-new-task:${environmentId}:${projectId}`;
  const batch = batchState.batches.find(
    (item) =>
      item.ownerKey === batchOwnerKey &&
      item.environmentId === environmentId &&
      item.projectId === projectId,
  );
  const batchTargetRef = useRef({
    environmentId,
    projectId,
    sourceId: batchSource?.id,
    prompt,
    attachments,
    selections: batchSelections,
  });
  const environmentsRef = useRef(environments);
  useLayoutEffect(() => {
    batchTargetRef.current = {
      environmentId,
      projectId,
      sourceId: batchSource?.id,
      prompt,
      attachments,
      selections: batchSelections,
    };
    environmentsRef.current = environments;
  }, [
    environmentId,
    projectId,
    environments,
    batchSource?.id,
    prompt,
    attachments,
    batchSelections,
  ]);
  const [selectedInteractionMode, setInteractionMode] =
    useState<ProviderInteractionMode>("default");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(defaults.runtimeMode);
  const [workspacePickerVisible, setWorkspacePickerVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<NewTaskAttempt | null>(null);
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly step: string;
    readonly deliveryUncertain: boolean;
  } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const serverConfigs = useEnvironmentServerConfigs();
  const serverConfig = environmentId ? serverConfigs.get(environmentId) : null;
  const tokenModeReady = serverConfig !== null && serverConfig !== undefined;
  const tokenMode = serverConfig?.settings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE;

  useEffect(() => {
    let current = true;
    if (!environmentId || !projectId) {
      void Promise.resolve().then(() => {
        if (!current) return;
        setBatchSource(null);
        setBatchSelections([]);
        setReadyBatchDraftTarget(batchDraftTarget);
      });
      return () => {
        current = false;
      };
    }
    void batchSourceDraftStore
      .load(environmentId, projectId)
      .then((draft) => {
        if (!current) return;
        setBatchSource(draft);
        setBatchSelections(draft?.selections ?? []);
        if (draft) {
          setPrompt(draft.prompt);
          setBaseBranch(draft.baseBranch);
          setRuntimeMode(draft.runtimeMode);
          setInteractionMode(draft.interactionMode);
          setAttachments(
            draft.attachments.map((image, index) => ({
              ...image,
              id: `${draft.id}:${index}`,
              previewUri: image.dataUrl,
            })),
          );
        }
        setReadyBatchDraftTarget(batchDraftTarget);
      })
      .catch((error) => {
        if (current)
          setFailure({ message: String(error), step: "batch", deliveryUncertain: false });
      });
    return () => {
      current = false;
    };
  }, [environmentId, projectId, batchDraftTarget]);

  useEffect(() => {
    if (initialized.current || !defaults.environment) return;
    initialized.current = true;
    const target =
      resolvedDefaultTarget?.status === "resolved" ? resolvedDefaultTarget.target : null;
    setEnvironmentId(target?.environmentId ?? defaults.environment.environmentId);
    setProjectId(target?.projectId ?? defaults.project?.id ?? null);
    setWorktreeSelection(
      defaults.worktree
        ? { kind: "existing", worktreeId: defaults.worktree.id }
        : { kind: "local" },
    );
    setModelSelection(defaults.modelSelection);
    setRuntimeMode(defaults.runtimeMode);
  }, [defaults, resolvedDefaultTarget]);

  useEffect(() => {
    if (environmentId) useStore.getState().setActiveEnvironmentId(environmentId);
  }, [environmentId]);

  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const worktree =
    worktreeSelection.kind === "existing"
      ? worktrees.find(
          (candidate) =>
            candidate.environmentId === environmentId &&
            candidate.projectId === projectId &&
            candidate.id === worktreeSelection.worktreeId &&
            candidate.archivedAt === null,
        )
      : null;
  useEffect(() => {
    let current = true;
    setPreferencesReady(false);
    setPreferencesError(null);
    if (!environmentId || !serverConfig || environment?.connectionState !== "connected") return;
    void Promise.resolve()
      .then(() =>
        readEffectiveProjectPreferences({
          api: ensureEnvironmentApi(environmentId),
          config: serverConfig,
          ...(projectId ? { projectId } : {}),
        }),
      )
      .then((effective) => {
        if (!current) return;
        if (!modelEdited.current)
          setModelSelection(
            initialDraftModelSelection({ effective, fallback: defaults.modelSelection }),
          );
        if (effective) {
          if (
            !locationEdited.current &&
            !(
              defaults.worktree &&
              defaults.worktree.projectId === projectId &&
              defaults.worktree.environmentId === environmentId
            )
          ) {
            setWorktreeSelection({
              kind: effective.defaultThreadEnvMode.value === "worktree" ? "new" : "local",
            });
            setNewBranch(buildTemporaryWorktreeBranchName(effective.worktreeBranchPrefix.value));
          }
        }
        setPreferencesReady(true);
      })
      .catch(() => {
        if (current)
          setPreferencesError(
            "Could not load this node's project defaults. Reconnect and try again.",
          );
      });
    return () => {
      current = false;
    };
  }, [
    environmentId,
    projectId,
    serverConfig,
    environment?.connectionState,
    defaults.worktree,
    defaults.modelSelection,
    preferencesRevision,
  ]);

  const modelOptions = buildModelOptions(serverConfig, modelSelection);
  const selectedModelOption = modelOptions.find(
    (option) =>
      option.selection.instanceId === modelSelection.instanceId &&
      option.selection.model === modelSelection.model,
  );
  const modelLabel = selectedModelOption?.label ?? modelSelection.model;
  const selectedProvider = serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection.instanceId,
  );
  const interactionModeSupported = selectedProvider?.showInteractionModeToggle ?? true;
  const askModeSupported = selectedProvider?.supportsAskMode ?? false;
  const interactionMode = interactionModeSupported
    ? normalizeInteractionModeForProviderTarget(selectedInteractionMode, askModeSupported)
    : "default";

  const repository = useNewTaskRepository(environmentId, project?.cwd ?? null);

  let draftProjectTitle = newProjectTitle.trim() || "New project";
  try {
    if (!newProjectTitle.trim()) {
      draftProjectTitle = inferNodeProjectTitle(validateNodeWorkspacePath(newProjectPath));
    }
  } catch {
    // Keep the neutral label until the user enters a complete node path.
  }
  const locationLabel =
    worktreeSelection.kind === "existing"
      ? worktree
        ? worktree.title?.trim() && worktree.title.trim() !== worktree.branch
          ? worktree.title.trim()
          : "Worktree"
        : "Choose worktree"
      : worktreeSelection.kind === "new"
        ? "New worktree"
        : "Project root";
  const branchLabel =
    worktreeSelection.kind === "existing"
      ? (worktree?.branch ?? null)
      : worktreeSelection.kind === "new"
        ? baseBranch.trim() || repository?.refName || "current branch"
        : (repository?.refName ?? null);

  const resetAttempt = () => {
    setAttempt(null);
    setFailure(null);
  };

  const selectEnvironment = (nextEnvironmentId: EnvironmentId) => {
    const target =
      environmentId && projectId
        ? resolveMobileNewTaskTarget({
            environmentId,
            projectId,
            projects,
            environments,
            threads,
            overrideEnvironmentId: nextEnvironmentId,
          })
        : null;
    const nextProject =
      target?.status === "resolved"
        ? projects.find(
            (candidate) =>
              candidate.environmentId === target.target.environmentId &&
              candidate.id === target.target.projectId,
          )
        : projects.find((candidate) => candidate.environmentId === nextEnvironmentId);
    modelEdited.current = false;
    locationEdited.current = false;
    setPreferencesReady(false);
    setModelSelection(
      initialDraftModelSelection({ effective: null, fallback: defaults.modelSelection }),
    );
    setEnvironmentId(nextEnvironmentId);
    setProjectId(nextProject?.id ?? null);
    setWorktreeSelection({ kind: "local" });
    setBaseBranch("");
    setNewBranch("");
    resetAttempt();
  };

  const selectProject = (
    target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
  ) => {
    const nextEnvironmentId = target?.environmentId ?? environmentId;
    const nextProjectId = target?.projectId ?? null;
    if (
      !environments.some(
        (candidate) =>
          candidate.environmentId === nextEnvironmentId &&
          candidate.connectionState === "connected",
      )
    )
      return;
    const nextProject = target
      ? resolveNewTaskProjectChoice({ target, projects, environments })
      : null;
    if (target && !nextProject) return;
    modelEdited.current = false;
    locationEdited.current = false;
    setPreferencesReady(false);
    setModelSelection(
      initialDraftModelSelection({ effective: null, fallback: defaults.modelSelection }),
    );
    setEnvironmentId(nextEnvironmentId);
    setProjectId(nextProjectId);
    setWorktreeSelection({ kind: "local" });
    setBaseBranch("");
    setNewBranch("");
    resetAttempt();
  };

  const canSend =
    batchDraftReady &&
    !batch &&
    tokenModeReady &&
    preferencesReady &&
    prompt.trim().length > 0 &&
    environment?.connectionState === "connected" &&
    (project !== undefined || newProjectPath.trim().length > 0) &&
    (batchSelections.length >= 2 ||
      worktreeSelection.kind !== "new" ||
      newBranch.trim().length > 0);
  const sendDisabledReason = !batchDraftReady
    ? "Restoring draft"
    : batch
      ? "Use the comparison results to retry safe failures"
      : !tokenModeReady || !preferencesReady
        ? "Loading node settings"
        : environments.some((candidate) => candidate.connectionState === "connected")
          ? null
          : "No verified machine available";

  const createAttempt = (): NewTaskAttempt => {
    if (!environment) throw new Error("Choose a connected node.");
    const projectContext: NewTaskProjectContext = project
      ? { kind: "existing", projectId: project.id, workspaceRoot: project.cwd }
      : {
          kind: "new",
          workspaceRoot: newProjectPath,
          title: newProjectTitle.trim() || undefined,
        };
    const worktreeContext: NewTaskWorktreeContext =
      worktreeSelection.kind === "existing" && worktree
        ? {
            kind: "existing",
            worktreeId: worktree.id,
            branch: worktree.branch,
            worktreePath: worktree.worktreePath,
          }
        : worktreeSelection.kind === "new"
          ? {
              kind: "new",
              branch: newBranch,
              ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
            }
          : { kind: "local" };
    return createNewTaskAttempt({
      environmentId: environment.environmentId,
      prompt,
      attachments: toUploadChatImageAttachments(attachments),
      project: projectContext,
      worktree: worktreeContext,
      modelSelection,
      runtimeMode,
      interactionMode,
      tokenMode,
      createdAt: new Date().toISOString(),
      ids: {
        projectId: newProjectId(),
        projectCommandId: newCommandId(),
        threadId: newThreadId(),
        threadCommandId: newCommandId(),
        attachCommandId: newCommandId(),
        turnCommandId: newCommandId(),
        messageId: newMessageId(),
      },
    });
  };

  const run = async (currentAttempt: NewTaskAttempt | null) => {
    if (!canSend && !currentAttempt) return;
    setBusy(true);
    setFailure(null);
    try {
      const nextAttempt = currentAttempt ?? createAttempt();
      setAttempt(nextAttempt);
      const api = ensureEnvironmentApi(nextAttempt.environmentId);
      const result = await runNewTaskAttempt(nextAttempt, {
        dispatch: (command) => api.orchestration.dispatchCommand(command),
        createWorktree: async ({
          projectId: selectedProjectId,
          branch,
          baseBranch: sourceBranch,
        }) => {
          const createWorktree = api.git.createWorktreeForProject;
          if (!createWorktree) throw new Error("Worktree creation unavailable");
          const created = await createWorktree({
            projectId: selectedProjectId,
            intent: {
              kind: "newBranch",
              branchName: branch,
              ...(sourceBranch ? { baseBranch: sourceBranch } : {}),
            },
          });
          return { worktreeId: created.worktreeId, threadId: created.sessionId };
        },
        waitForProject: (selectedProjectId) =>
          waitForAuthoritative(
            () =>
              selectProjectByRef(
                useStore.getState(),
                scopeProjectRef(nextAttempt.environmentId, selectedProjectId),
              ) !== undefined,
            "Project",
          ),
        waitForWorktree: (selectedWorktreeId) =>
          waitForAuthoritative(
            () =>
              selectSidebarWorktreesForProjectRef(
                useStore.getState(),
                scopeProjectRef(nextAttempt.environmentId, nextAttempt.projectId),
              ).some((candidate) => candidate.id === selectedWorktreeId),
            "Worktree",
          ),
        waitForThread: ({ threadId: selectedThreadId, worktreeId: expectedWorktreeId }) =>
          waitForAuthoritative(() => {
            const state = useStore.getState();
            const ref = scopeThreadRef(nextAttempt.environmentId, selectedThreadId);
            if (!selectThreadExistsByRef(state, ref)) return false;
            if (expectedWorktreeId === undefined) return true;
            const summary = selectSidebarThreadSummaryByRef(state, ref);
            return (summary?.worktreeId ?? null) === expectedWorktreeId;
          }, "Task"),
      });
      setAttempt(result.attempt);
      if (!result.ok) {
        setFailure({
          message: result.message,
          step: result.step,
          deliveryUncertain: result.deliveryUncertain,
        });
        return;
      }
      useStore.getState().setActiveEnvironmentId(result.attempt.environmentId);
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: result.attempt.environmentId,
          threadId: result.attempt.threadId,
        }),
      );
    } catch {
      setFailure({
        message: "The task could not be started. Your draft is still here.",
        step: "context",
        deliveryUncertain: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const makeBatchPorts = (retained: BatchLaunch, source: BatchSourceDraft): BatchLaunchPorts => {
    const captureMutationReadiness = () => {
      const guard = captureBatchLaunchReadiness(source.environmentId, () =>
        createMobileConnectionRegistry().driver.supervisor.read(source.environmentId),
      );
      return () => {
        guard();
        if (
          !environmentsRef.current.some(
            (item) =>
              item.environmentId === source.environmentId &&
              item.connectionState === "connected" &&
              item.mutationReady === true &&
              item.shellCurrent === true &&
              !item.deliveryUnknown,
          )
        )
          throw new Error("The selected machine is no longer mutation ready.");
      };
    };
    return {
      assertMutationReady: captureMutationReadiness(),
      captureMutationReadiness,
      prepare: async (destination, _signal, assertMutationReady) => {
        assertMutationReady();
        const api = ensureEnvironmentApi(source.environmentId);
        return prepareBatchDestination({
          readProjectPreferences: readEffectiveProjectPreferences,
          api,
          batch: retained,
          destination,
          providers: [],
          prompt: source.prompt,
          projectCwd: source.projectCwd,
          baseBranch: source.baseBranch,
          fetchOrigin: true,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          tokenMode: source.tokenMode,
          sourceControlContexts: [],
          attachments: source.attachments,
          assertMutationReady,
        });
      },
    };
  };
  const retryBatch = async () => {
    if (busy || !batch || !batchSource || !batchDraftReady) return;
    setBusy(true);
    try {
      await batchLaunchStore.run(batch.id, makeBatchPorts(batch, batchSource));
    } catch (error) {
      if (
        batchTargetRef.current.environmentId !== batchSource.environmentId ||
        batchTargetRef.current.projectId !== batchSource.projectId
      )
        return;
      setFailure({
        message: error instanceof Error ? error.message : "Retry unavailable",
        step: "batch",
        deliveryUncertain: false,
      });
    } finally {
      setBusy(false);
    }
  };
  const runBatch = async () => {
    if (busy || batch || !batchDraftReady || !canSend || !environment || !project || !serverConfig)
      return;
    setBusy(true);
    setFailure(null);
    try {
      if (attempt || failure?.deliveryUncertain)
        throw new Error("Resolve the existing task attempt before launching a comparison.");
      if (worktreeSelection.kind === "existing")
        throw new Error("Choose the Git project or a new branch for batch launch.");
      const sourceBranch = baseBranch.trim() || repository?.refName || null;
      // Validate before retaining anything. Claim a stable source ID independently
      // of the launch ledger, so process restart can reconstruct safe retry ports.
      const id = batchSource?.id ?? newThreadId();
      createBatchLaunch({
        id,
        ownerKey: id,
        environmentId: environment.environmentId,
        projectId: project.id,
        selections: batchSelections,
        providers: serverConfig.providers,
        prompt,
        isGitRepo: repository?.isRepo === true,
        baseBranch: sourceBranch,
        createdAt: new Date().toISOString(),
      });
      const source = await batchSourceDraftStore.claim({
        id,
        environmentId: environment.environmentId,
        projectId: project.id,
        selections: batchSelections,
        prompt,
        projectCwd: project.cwd,
        baseBranch: sourceBranch!,
        runtimeMode,
        interactionMode: selectedInteractionMode,
        tokenMode,
        attachments: toUploadChatImageAttachments(attachments),
      });
      if (
        batchTargetRef.current.environmentId === source.environmentId &&
        batchTargetRef.current.projectId === source.projectId
      )
        setBatchSource(source);
      const created = createBatchLaunch({
        id: source.id,
        ownerKey: source.id,
        environmentId: source.environmentId,
        projectId: source.projectId,
        selections: source.selections,
        providers: serverConfig.providers,
        prompt: source.prompt,
        isGitRepo: repository?.isRepo === true,
        baseBranch: source.baseBranch,
        createdAt: new Date().toISOString(),
      });
      const retained = await batchLaunchStore.add(created);
      await batchLaunchStore.run(retained.id, makeBatchPorts(retained, source));
    } catch (error) {
      if (
        batchTargetRef.current.environmentId !== environment.environmentId ||
        batchTargetRef.current.projectId !== project.id
      )
        return;
      setFailure({
        message: error instanceof Error ? error.message : "The comparison could not be started.",
        step: "batch",
        deliveryUncertain: false,
      });
    } finally {
      setBusy(false);
    }
  };

  const pickAttachments = async () => {
    setAttachmentError(null);
    const result = await pickComposerImages({ existingCount: attachments.length });
    if (result.images.length > 0) {
      setAttachments((current) => [...current, ...result.images]);
      resetAttempt();
    }
    if (result.error) setAttachmentError(result.error);
  };

  if (environments.length === 0) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title="No verified machine available"
          detail="Verify an online machine with operator access before starting work."
          actionLabel="Open Machines"
          onAction={() => navigation.navigate("Connections")}
        />
      </ScrollView>
    );
  }

  return (
    <>
      <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1 bg-screen"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: keyboardVisible ? "flex-end" : "flex-start",
            padding: 16,
            paddingTop: 12,
            paddingBottom: 12,
          }}
        >
          {preferencesError && (
            <View className="mb-4 gap-2">
              <ErrorBanner message={preferencesError} />
              <Pressable
                accessibilityRole="button"
                onPress={() => setPreferencesRevision((value) => value + 1)}
              >
                <Text>Reload project defaults</Text>
              </Pressable>
            </View>
          )}
          {failure ? (
            <View className="mb-4 gap-2">
              <ErrorBanner message={failure.message} />
              <View className="flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void (failure.step === "batch" ? runBatch() : run(attempt))}
                  className="h-11 items-center justify-center rounded-full bg-primary px-5 disabled:opacity-40"
                >
                  <Text className="text-sm font-ryco-bold text-primary-foreground">
                    Retry {failure.step}
                  </Text>
                </Pressable>
                {attempt?.threadReady ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      navigation.dispatch(
                        StackActions.replace("Thread", {
                          environmentId: attempt.environmentId,
                          threadId: attempt.threadId,
                        }),
                      )
                    }
                    className="h-11 items-center justify-center rounded-full bg-subtle px-5"
                  >
                    <Text className="text-sm font-ryco-bold text-foreground">Open task</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}
          {attachmentError ? (
            <View className="mb-4">
              <ErrorBanner message={attachmentError} />
            </View>
          ) : null}

          {projectId === null ? (
            <View className="mb-5 gap-3 rounded-[22px] border border-border bg-card p-4">
              <View className="gap-1">
                <Text className="text-base font-ryco-bold text-foreground">New project</Text>
                <Text className="text-sm font-sans text-foreground-muted">
                  Enter the workspace path on {environment?.label ?? "the selected node"}.
                </Text>
              </View>
              <TextInput
                value={newProjectPath}
                onChangeText={(value) => {
                  setNewProjectPath(value);
                  resetAttempt();
                }}
                placeholder="/srv/code/project"
                placeholderTextColor={placeholderColor as string}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-12 rounded-2xl border border-border bg-screen px-4 py-3 font-mono text-sm"
                style={{ color: textColor as string }}
              />
              <TextInput
                value={newProjectTitle}
                onChangeText={(value) => {
                  setNewProjectTitle(value);
                  resetAttempt();
                }}
                placeholder={draftProjectTitle}
                placeholderTextColor={placeholderColor as string}
                className="min-h-12 rounded-2xl border border-border bg-screen px-4 py-3 font-sans text-base"
                style={{ color: textColor as string }}
              />
            </View>
          ) : null}

          {batch ? (
            <BatchResults
              batch={batch}
              error={batchState.storageError}
              connected={!batchState.storageError && environment?.connectionState === "connected"}
              onOpen={(threadId) =>
                navigation.navigate("Thread", { environmentId: batch.environmentId, threadId })
              }
              onRetry={batchSource && batchDraftReady ? () => void retryBatch() : undefined}
              onNew={() => {
                if (!batchSource) return;
                const sourceContent = batchTargetRef.current;
                void completeBatchSourceReset(sourceContent, {
                  releaseSource: () => batchLaunchStore.releaseSource(batch.id),
                  removeSource: () => batchSourceDraftStore.remove(batchSource),
                  readCurrent: () => batchTargetRef.current,
                  clearSource: () => {
                    setBatchSource(null);
                    setPrompt("");
                    setAttachments([]);
                    setBatchSelections([]);
                    resetAttempt();
                  },
                }).catch((error) => {
                  if (
                    batchTargetRef.current.environmentId === batchSource.environmentId &&
                    batchTargetRef.current.projectId === batchSource.projectId &&
                    batchTargetRef.current.sourceId === batchSource.id
                  )
                    setFailure({
                      message: error instanceof Error ? error.message : "Draft storage unavailable",
                      step: "batch",
                      deliveryUncertain: false,
                    });
                });
              }}
            />
          ) : (
            <View className="mb-3 gap-2">
              <Pressable
                accessibilityRole="button"
                disabled={
                  busy ||
                  !batchDraftReady ||
                  serverConfig?.environment.capabilities.requiredWorktreeBootstrap !== true ||
                  !project ||
                  repository?.isRepo !== true ||
                  !batchState.hydrated ||
                  !!batchState.storageError ||
                  batchSelections.length >= BATCH_LAUNCH_MAX_TARGETS
                }
                onPress={() =>
                  setBatchSelections((previous) =>
                    previous.some(
                      (item) => batchSelectionKey(item) === batchSelectionKey(modelSelection),
                    )
                      ? previous
                      : [...previous, modelSelection],
                  )
                }
                className="min-h-11 justify-center disabled:opacity-40"
              >
                <Text>
                  {batchSelections.length === 0 ? "Compare models…" : "Add current selection"}
                </Text>
              </Pressable>
              {batchSelections.map((selection) => (
                <Pressable
                  key={batchSelectionKey(selection)}
                  accessibilityRole="button"
                  disabled={busy}
                  accessibilityLabel={`Remove ${selection.instanceId} ${selection.model}`}
                  onPress={() =>
                    setBatchSelections((previous) =>
                      previous.filter(
                        (item) => batchSelectionKey(item) !== batchSelectionKey(selection),
                      ),
                    )
                  }
                  className="min-h-11 justify-center rounded-xl bg-subtle px-3"
                >
                  <Text className="text-xs">
                    {selection.instanceId} · {selection.model}{" "}
                    {selection.options
                      ?.map((option) => `${option.id}: ${option.value}`)
                      .join(" · ")}{" "}
                    ×
                  </Text>
                </Pressable>
              ))}
              {batchSelections.length > 0 && (
                <Text className="text-xs text-foreground-muted">
                  {batchState.storageError ??
                    (batchSelections.length < 2
                      ? "Choose another model or effort in the picker, then add it."
                      : `Send launches ${batchSelections.length} isolated worktrees with the same prompt and attachments.`)}
                </Text>
              )}
            </View>
          )}
          <NewTaskComposer
            environmentId={environmentId}
            prompt={prompt}
            attachments={attachments}
            environments={environments}
            projects={projects}
            onSelectProject={selectProject}
            projectId={projectId}
            projectTitle={project?.name ?? draftProjectTitle}
            customAvatarContentHash={project?.customAvatarContentHash}
            locationLabel={locationLabel}
            branchLabel={branchLabel}
            newWorktree={worktreeSelection.kind === "new"}
            newBranchName={worktreeSelection.kind === "new" ? newBranch.trim() : null}
            usesWorktree={worktreeSelection.kind !== "local"}
            modelProviderDriver={selectedModelOption?.providerDriver ?? null}
            machineLabel={environment?.label ?? "No verified machine available"}
            modelLabel={modelLabel}
            runtimeMode={runtimeMode}
            interactionMode={interactionMode}
            interactionModeSupported={interactionModeSupported}
            askModeSupported={askModeSupported}
            onChangeInteractionMode={(mode) => {
              setInteractionMode(mode);
              resetAttempt();
            }}
            busy={busy}
            canSend={canSend}
            sendDisabledReason={sendDisabledReason}
            onChangePrompt={(value) => {
              setPrompt(value);
              resetAttempt();
            }}
            onRemoveAttachment={(id) => {
              setAttachments((current) => current.filter((attachment) => attachment.id !== id));
              resetAttempt();
            }}
            onPickAttachments={() => void pickAttachments()}
            onOpenWorkspace={() => setWorkspacePickerVisible(true)}
            onSelectEnvironment={selectEnvironment}
            modelOptions={modelOptions}
            modelSelection={modelSelection}
            onSelectModel={(selection) => {
              modelEdited.current = true;
              setModelSelection(selection);
              resetAttempt();
            }}
            onChangeRuntimeMode={(mode) => {
              setRuntimeMode(mode);
              resetAttempt();
            }}
            onSend={() => void (batch || batchSelections.length >= 2 ? runBatch() : run(null))}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <NewTaskContextSheet
        visible={workspacePickerVisible}
        currentBranch={repository?.refName ?? null}
        baseBranch={baseBranch}
        onChangeBaseBranch={(branch) => {
          setBaseBranch(branch);
          resetAttempt();
        }}
        worktrees={worktrees}
        environmentId={environmentId}
        projectId={projectId}
        worktree={worktreeSelection}
        newBranch={newBranch}
        onSelectWorktree={(selection) => {
          locationEdited.current = true;
          setWorktreeSelection(selection);
          resetAttempt();
        }}
        onChangeNewBranch={(branch) => {
          locationEdited.current = true;
          setNewBranch(branch);
          resetAttempt();
        }}
        onClose={() => setWorkspacePickerVisible(false)}
      />
    </>
  );
}
