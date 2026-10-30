import {
  initialDraftModelSelection,
  readEffectiveProjectPreferences,
} from "@ryco/client-runtime/state/settings";
import { buildTemporaryWorktreeBranchName } from "@ryco/shared/git";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import {
  getAutoRuntimeModeUnavailableReason,
  normalizeInteractionModeForProviderTarget,
} from "@ryco/client-runtime/state/composer";
import { newWorktreeBaseBranch } from "@ryco/client-runtime/state/worktree-setup";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@ryco/contracts/orchestration";
import { WorktreeId } from "@ryco/contracts/worktree";

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
import { useStore } from "../../state/threadsRuntime";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { inferNodeProjectTitle, validateNodeWorkspacePath } from "../projects/projectActions";
import {
  createNewTaskAttempt,
  resolveMobileNewTaskTarget,
  type NewTaskAttempt,
  type NewTaskProjectContext,
  type NewTaskWorktreeContext,
} from "./newTaskController";
import {
  discardNewTaskLaunch,
  readNewTaskLaunchDraftForEdit,
  startNewTaskLaunch,
  type NewTaskLaunchDraft,
} from "./newTaskLaunch";
import { createNewTaskLaunchDeps } from "./newTaskLaunchRuntime";
import { NewTaskComposer } from "./NewTaskComposer";
import { NewTaskContextSheet, type NewTaskWorktreeSelection } from "./NewTaskContextSheet";
import { deriveNewTaskDefaults, resolveNewTaskProjectChoice } from "./newTaskModel";
import { useNewTaskRepository } from "./useNewTaskRepository";

type NewTaskRouteScreenProps = StaticScreenProps<{
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
  /** A launch whose thread screen chose Edit task: its draft comes back here. */
  readonly editLaunchKey?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
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
  const workspace = useHomeWorkspaceData(eligibleEnvironmentIds);
  const { worktrees, threads } = workspace;
  // "No project" chats are never a place to start a task: every default, choice and
  // execution-target variant below reads this chat-free list.
  const projects = excludeChatProjects(workspace.projects);
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
  const editLaunchKey = firstParam(props.route.params?.editLaunchKey);
  // Read once: the draft a failed launch hands back. The launch is dropped
  // after the first commit, so a second mount starts from the defaults.
  const [restored] = useState<NewTaskLaunchDraft | null>(() =>
    editLaunchKey ? readNewTaskLaunchDraftForEdit(editLaunchKey) : null,
  );
  useEffect(() => {
    if (restored && editLaunchKey) discardNewTaskLaunch(editLaunchKey);
  }, [editLaunchKey, restored]);
  const initialized = useRef(restored !== null);
  const modelEdited = useRef(restored !== null);
  const locationEdited = useRef(restored !== null);
  const [preferencesRevision, setPreferencesRevision] = useState(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    restored?.environmentId ?? null,
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(restored?.projectId ?? null);
  const [worktreeSelection, setWorktreeSelection] = useState<NewTaskWorktreeSelection>(
    restored?.worktree ?? { kind: "local" },
  );
  const [newProjectPath, setNewProjectPath] = useState(restored?.newProjectPath ?? "");
  const [newProjectTitle, setNewProjectTitle] = useState(restored?.newProjectTitle ?? "");
  const [newBranch, setNewBranch] = useState(restored?.newBranch ?? "");
  const [baseBranch, setBaseBranch] = useState(restored?.baseBranch ?? "");
  const [prompt, setPrompt] = useState(restored?.prompt ?? "");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>(
    restored?.attachments ?? [],
  );
  const [modelSelection, setModelSelection] = useState<ModelSelection>(
    restored?.modelSelection ?? defaults.modelSelection,
  );
  const [selectedInteractionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    restored?.interactionMode ?? "default",
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    restored?.runtimeMode ?? defaults.runtimeMode,
  );
  const [workspacePickerVisible, setWorkspacePickerVisible] = useState(false);
  const [failure, setFailure] = useState<{ readonly message: string } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const serverConfigs = useEnvironmentServerConfigs();
  const serverConfig = environmentId ? serverConfigs.get(environmentId) : null;
  const tokenModeReady = serverConfig !== null && serverConfig !== undefined;
  const tokenMode = serverConfig?.settings.defaultAgentTokenMode ?? DEFAULT_AGENT_TOKEN_MODE;

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
  const autoModeUnavailableReason = getAutoRuntimeModeUnavailableReason(
    selectedProvider?.models ?? [],
    modelSelection.model,
  );
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
    tokenModeReady &&
    preferencesReady &&
    prompt.trim().length > 0 &&
    environment?.connectionState === "connected" &&
    (project !== undefined || newProjectPath.trim().length > 0) &&
    (worktreeSelection.kind !== "new" || newBranch.trim().length > 0);
  const sendDisabledReason =
    !tokenModeReady || !preferencesReady
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
              // The phone branches from the node's checkout as it always has: the
              // typed base, else the project's current HEAD, without fetching.
              baseBranch: newWorktreeBaseBranch(baseBranch, false),
              fetchOrigin: false,
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

  /**
   * Send the task and open its thread at once. The thread screen follows the
   * launch: the node's setup stages while it prepares a worktree, then the
   * agent's turn, or the failure with Retry and Edit task.
   */
  const send = () => {
    if (!canSend) return;
    let attempt: NewTaskAttempt;
    try {
      if (!project) validateNodeWorkspacePath(newProjectPath);
      attempt = createAttempt();
    } catch (error) {
      setFailure({
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The task could not be started. Your draft is still here.",
      });
      return;
    }
    startNewTaskLaunch({
      attempt,
      draft: {
        environmentId: attempt.environmentId,
        projectId,
        newProjectPath,
        newProjectTitle,
        worktree: worktreeSelection,
        newBranch,
        baseBranch,
        prompt,
        attachments,
        modelSelection,
        runtimeMode,
        interactionMode: selectedInteractionMode,
      },
      deps: createNewTaskLaunchDeps(attempt.environmentId),
    });
    useStore.getState().setActiveEnvironmentId(attempt.environmentId);
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: attempt.environmentId,
        threadId: attempt.threadId,
      }),
    );
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
            <View className="mb-4">
              <ErrorBanner message={failure.message} />
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
            autoModeUnavailableReason={autoModeUnavailableReason}
            onChangeInteractionMode={(mode) => {
              setInteractionMode(mode);
              resetAttempt();
            }}
            busy={false}
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
            providers={serverConfig?.providers}
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
            onSend={send}
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
