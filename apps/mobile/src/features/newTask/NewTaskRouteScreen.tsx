import { useAtomValue } from "@effect/atom-react";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  EnvironmentId,
  ProjectId,
  WorktreeId,
  type ModelSelection,
  type RuntimeMode,
} from "@ryco/contracts";

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
import { deriveNewTaskDefaults, newTaskContextLabel } from "./newTaskModel";

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
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(null);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [worktreeSelection, setWorktreeSelection] = useState<NewTaskWorktreeSelection>({
    kind: "local",
  });
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerImageAttachment>>([]);
  const [modelSelection, setModelSelection] = useState<ModelSelection>(defaults.modelSelection);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(defaults.runtimeMode);
  const [contextVisible, setContextVisible] = useState(false);
  const [modelVisible, setModelVisible] = useState(false);
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
  const serverConfig = useAtomValue(serverConfigAtom);

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
  const modelOptions = buildModelOptions(serverConfig, modelSelection);
  const modelLabel =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === modelSelection.instanceId &&
        option.selection.model === modelSelection.model,
    )?.label ?? modelSelection.model;

  let draftProjectTitle = newProjectTitle.trim() || "New project";
  try {
    if (!newProjectTitle.trim()) {
      draftProjectTitle = inferNodeProjectTitle(validateNodeWorkspacePath(newProjectPath));
    }
  } catch {
    // Keep the neutral label until the user enters a complete node path.
  }
  const worktreeTitle =
    worktreeSelection.kind === "existing"
      ? worktree?.title?.trim() || worktree?.branch || "Choose worktree"
      : worktreeSelection.kind === "new"
        ? newBranch.trim() || "New worktree"
        : "Local workspace";
  const contextLabel = newTaskContextLabel({
    environmentLabel: environment?.label ?? null,
    projectTitle: project?.name ?? (projectId === null ? draftProjectTitle : null),
    worktreeTitle,
  });

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
    setEnvironmentId(nextEnvironmentId);
    setProjectId(nextProject?.id ?? null);
    setWorktreeSelection({ kind: "local" });
    resetAttempt();
  };

  const selectProject = (nextProjectId: ProjectId | null) => {
    const nextProject = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === nextProjectId,
    );
    setProjectId(nextProjectId);
    setWorktreeSelection({ kind: "local" });
    if (nextProject?.defaultModelSelection) {
      setModelSelection(nextProject.defaultModelSelection);
    }
    resetAttempt();
  };

  const canSend =
    prompt.trim().length > 0 &&
    environment?.connectionState === "connected" &&
    (project !== undefined || newProjectPath.trim().length > 0) &&
    (worktreeSelection.kind !== "new" || newBranch.trim().length > 0);
  const sendDisabledReason = environments.some(
    (candidate) => candidate.connectionState === "connected",
  )
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
          ? { kind: "new", branch: newBranch }
          : { kind: "local" };
    return createNewTaskAttempt({
      environmentId: environment.environmentId,
      prompt,
      attachments: toUploadChatImageAttachments(attachments),
      project: projectContext,
      worktree: worktreeContext,
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      tokenMode: "balanced",
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
        createWorktree: async ({ projectId: selectedProjectId, branch }) => {
          const createWorktree = api.git.createWorktreeForProject;
          if (!createWorktree) throw new Error("Worktree creation unavailable");
          const created = await createWorktree({
            projectId: selectedProjectId,
            intent: { kind: "newBranch", branchName: branch },
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
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      >
        {failure ? (
          <View className="mb-4 gap-2">
            <ErrorBanner message={failure.message} />
            <View className="flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void run(attempt)}
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

        <NewTaskComposer
          environmentId={environmentId}
          prompt={prompt}
          attachments={attachments}
          contextLabel={contextLabel}
          machineLabel={environment?.label ?? "No verified machine available"}
          modelLabel={modelLabel}
          runtimeMode={runtimeMode}
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
          onOpenContext={() => setContextVisible(true)}
          onOpenModel={() => setModelVisible(true)}
          onChangeRuntimeMode={(mode) => {
            setRuntimeMode(mode);
            resetAttempt();
          }}
          onSend={() => void run(null)}
        />
      </ScrollView>

      <NewTaskContextSheet
        visible={contextVisible}
        environments={environments}
        projects={projects}
        worktrees={worktrees}
        environmentId={environmentId}
        projectId={projectId}
        worktree={worktreeSelection}
        newBranch={newBranch}
        onSelectEnvironment={selectEnvironment}
        onSelectProject={selectProject}
        onSelectWorktree={(selection) => {
          setWorktreeSelection(selection);
          resetAttempt();
        }}
        onChangeNewBranch={(branch) => {
          setNewBranch(branch);
          resetAttempt();
        }}
        onClose={() => setContextVisible(false)}
      />

      <Modal
        visible={modelVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModelVisible(false)}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-screen"
          contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 44 }}
        >
          <View className="mb-2 flex-row items-center gap-3">
            <Text className="flex-1 text-xl font-ryco-bold text-foreground">Model</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setModelVisible(false)}
              className="h-11 items-center justify-center rounded-full bg-primary px-5"
            >
              <Text className="text-sm font-ryco-bold text-primary-foreground">Done</Text>
            </Pressable>
          </View>
          {modelOptions.map((option) => {
            const selected =
              option.selection.instanceId === modelSelection.instanceId &&
              option.selection.model === modelSelection.model;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  setModelSelection(option.selection);
                  resetAttempt();
                  setModelVisible(false);
                }}
                className={`min-h-14 rounded-2xl border px-4 py-3 ${
                  selected ? "border-foreground bg-card-alt" : "border-border bg-card"
                }`}
              >
                <Text className="text-base font-ryco-bold text-foreground">{option.label}</Text>
                <Text className="mt-0.5 text-xs font-ryco-medium text-foreground-muted">
                  {option.subtitle}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </Modal>
    </>
  );
}
