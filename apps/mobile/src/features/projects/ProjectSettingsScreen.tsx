import { StackActions, useNavigation } from "@react-navigation/native";
import { describeProjectRemoval } from "@ryco/client-runtime/projectSettings/removal";
import {
  withAddedProjectScript,
  withoutProjectScript,
  withUpdatedProjectScript,
  type ProjectScriptDraft,
} from "@ryco/client-runtime/projectSettings/scripts";
import type { ProjectSection } from "@ryco/client-runtime/projectSettings/sections";
import { workspaceInspectionSignature } from "@ryco/client-runtime/projectSettings/workspaces";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import type { EnvironmentId, ProjectId, ProjectScript } from "@ryco/contracts";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { ProjectNewTaskDefaults } from "../settings/NodeNewTaskDefaults";
import { ProjectAtlassianSection } from "./ProjectAtlassianSection";
import {
  ProjectScriptEditorSheet,
  type ProjectScriptEditorTarget,
} from "./ProjectScriptEditorSheet";
import {
  ProjectActionsSection,
  ProjectDangerSection,
  ProjectInstructionsSection,
  ProjectLocationSection,
  ProjectMachinesSection,
  ProjectRepositorySection,
} from "./ProjectSettingsSections";
import { ProjectWorkspacesSection } from "./ProjectWorkspacesSection";
import {
  clearProjectAvatar,
  initializeProjectGit,
  removeProjectFromMachine,
  runProjectWorkspaceAction,
  writeProjectMeta,
} from "./projectSettingsActions";
import {
  checkProjectRoot,
  copyProjectRouteParams,
  projectCheckouts,
  projectSettingsAccess,
  projectSettingsGroups,
  runSettingsWrite,
  type ProjectWorkspaceRow,
} from "./projectSettingsModel";
import { openCopyProject } from "./projectSettingsNavigation";
import { useProjectWorkspaceData } from "./useProjectWorkspaceData";
import { WorkspaceReviewSheet, type WorkspaceReviewTarget } from "./WorkspaceReviewSheet";
import { WorktreeEditorSheet } from "./WorktreeEditorSheet";

type ErrorKey = ProjectSection | "header";
type Editor = { readonly kind: "rename" | "root"; readonly initialValue: string } | null;

/** A sheet that keeps its last subject on screen while it slides away. */
interface SheetState<Target> {
  readonly open: boolean;
  readonly target: Target | null;
  readonly token: number;
}

const closedSheet = <Target,>(): SheetState<Target> => ({ open: false, target: null, token: 0 });
const openSheet = <Target,>(current: SheetState<Target>, target: Target): SheetState<Target> => ({
  open: true,
  target,
  token: current.token + 1,
});

/**
 * One project's settings on its machine, as the web's project page has them: machines that have
 * a copy, location, repository, workspaces with their disk use, new-task defaults, actions, agent
 * instructions, the Jira & Bitbucket link, and removal. Writes go to the project's own machine
 * and wait for it to be live; the reason when they cannot is said once, under the header.
 */
export function ProjectSettingsScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const navigation = useNavigation();
  const { projects, worktrees, threads } = useHomeWorkspaceData();
  const environments = useHomeEnvironments();
  const api = useEnvironmentApi(environmentId);
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const access = projectSettingsAccess(environment);
  const machineLabel = environment?.label ?? "this machine";

  const projectWorktrees = useMemo(
    () =>
      worktrees.filter(
        (worktree) => worktree.environmentId === environmentId && worktree.projectId === projectId,
      ),
    [environmentId, projectId, worktrees],
  );
  const signature = useMemo(
    () => workspaceInspectionSignature(projectWorktrees),
    [projectWorktrees],
  );
  const workspaceData = useProjectWorkspaceData({
    environmentId,
    projectId,
    signature,
    enabled: access.canInspectWorkspaces,
  });
  const threadCount = threads.filter(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  ).length;

  // Only a checkout without remotes asks whether its folder is a repository at all.
  const cwd = project?.cwd ?? null;
  const asksIsRepo = project !== undefined && !project.repositoryIdentity;
  const [isRepo, setIsRepo] = useState<{ readonly cwd: string; readonly value: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!api || !asksIsRepo || cwd === null) return;
    let current = true;
    api.vcs.refreshStatus({ cwd }).then(
      (status) => {
        if (current) setIsRepo({ cwd, value: status.isRepo });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, asksIsRepo, cwd]);

  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({});
  const [busy, setBusy] = useState<ErrorKey | null>(null);
  const [busyWorktreeId, setBusyWorktreeId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [scriptSheet, setScriptSheet] =
    useState<SheetState<ProjectScriptEditorTarget>>(closedSheet);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [review, setReview] = useState<SheetState<WorkspaceReviewTarget>>(closedSheet);

  if (!project) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title="Loading project"
          detail="Waiting for the machine to publish this project."
        />
      </ScrollView>
    );
  }

  /** One write, its section's error and busy state; resolves whether it went through. */
  const run = (key: ErrorKey, write: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setErrors((current) => ({ ...current, [key]: undefined }));
    return runSettingsWrite({ canEdit: access.canEdit, write, fallback }).then((result) => {
      setBusy(null);
      if (!result.ok) setErrors((current) => ({ ...current, [key]: result.message }));
      return result.ok;
    });
  };

  const submitEditor = (value: string) => {
    if (!editor) return;
    setEditorError(null);
    if (editor.kind === "rename") {
      const title = value.trim();
      if (!title) {
        setEditorError("Enter a title.");
        return;
      }
      void runSettingsWrite({
        canEdit: access.canEdit,
        write: () => writeProjectMeta(environmentId, projectId, { title }),
        fallback: "The project could not be renamed. Try again when the machine is ready.",
      }).then((result) => {
        if (result.ok) setEditor(null);
        else setEditorError(result.message);
      });
      return;
    }
    const change = checkProjectRoot(project.cwd, value);
    if (change.kind === "unchanged") {
      setEditor(null);
      return;
    }
    if (change.kind === "invalid") {
      setEditorError(change.message);
      return;
    }
    setEditor(null);
    Alert.alert(
      "Change the project root?",
      `New tasks and worktrees start from the new folder. Existing tasks keep their history; files are not moved.\n\n${project.cwd}\n→ ${change.next}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Change root",
          onPress: () =>
            void run(
              "location",
              () => writeProjectMeta(environmentId, projectId, { workspaceRoot: change.next }),
              "The project root could not be changed.",
            ),
        },
      ],
    );
  };

  const removeImage = () =>
    Alert.alert("Remove the project image?", "The project goes back to its detected icon.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void run(
            "header",
            () => clearProjectAvatar(environmentId, projectId),
            "The image could not be removed.",
          ),
      },
    ]);

  const saveScript = (draft: ProjectScriptDraft) => {
    const script = scriptSheet.target?.script ?? null;
    setScriptError(null);
    setBusy("actions");
    void runSettingsWrite({
      canEdit: access.canEdit,
      write: () =>
        writeProjectMeta(environmentId, projectId, {
          scripts: script
            ? withUpdatedProjectScript(project.scripts, script.id, draft)
            : withAddedProjectScript(project.scripts, draft).scripts,
        }),
      fallback: "The action could not be saved.",
    }).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setScriptError(result.message);
        return;
      }
      setScriptSheet((current) => ({ ...current, open: false }));
    });
  };

  const deleteScript = (script: ProjectScript) => {
    setScriptError(null);
    setBusy("actions");
    void runSettingsWrite({
      canEdit: access.canEdit,
      write: () =>
        writeProjectMeta(environmentId, projectId, {
          scripts: withoutProjectScript(project.scripts, script.id),
        }),
      fallback: "The action could not be deleted.",
    }).then((result) => {
      setBusy(null);
      if (!result.ok) {
        setScriptError(result.message);
        return;
      }
      setScriptSheet((current) => ({ ...current, open: false }));
    });
  };

  const workspaceAction = (row: ProjectWorkspaceRow, action: WorkspaceActionId) => {
    if (action === "delete-workspace") {
      setReview((current) =>
        openSheet(current, { environmentId, worktreeId: row.worktreeId, title: row.title }),
      );
      return;
    }
    setBusyWorktreeId(row.worktreeId);
    void run(
      "workspaces",
      () => runProjectWorkspaceAction(environmentId, { worktreeId: row.worktreeId, action }),
      action === "archive"
        ? "The workspace could not be archived."
        : "The workspace could not be restored.",
    ).then(() => {
      setBusyWorktreeId(null);
      workspaceData.refresh();
    });
  };

  const removeProject = () => {
    const removal = describeProjectRemoval({
      name: project.name,
      cwd: project.cwd,
      environmentLabel: machineLabel,
      threadCount,
    });
    Alert.alert(removal.title, [...removal.lines, "Files on disk are not touched."].join("\n"), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove project",
        style: "destructive",
        onPress: () =>
          void run(
            "danger",
            () => removeProjectFromMachine(environmentId, projectId, threadCount > 0),
            `Failed to remove "${project.name}".`,
          ).then((removed) => {
            if (removed) navigation.dispatch(StackActions.popToTop());
          }),
      },
    ]);
  };

  const checkouts = projectCheckouts({ project, projects, environments });
  const groups = projectSettingsGroups({ canManageNode: access.canManageNode });

  const renderSection = (section: ProjectSection) => {
    switch (section) {
      case "devices":
        return (
          <ProjectMachinesSection
            checkouts={checkouts.checkouts}
            missing={checkouts.missing}
            onOpenCheckout={(checkout) =>
              navigation.dispatch(
                StackActions.push("ProjectSettings", {
                  environmentId: checkout.environmentId,
                  projectId: checkout.projectId,
                }),
              )
            }
            onCopyHere={(machine) =>
              openCopyProject(
                navigation,
                copyProjectRouteParams({ environmentId, projectId }, machine),
              )
            }
          />
        );
      case "location":
        return (
          <ProjectLocationSection
            cwd={project.cwd}
            machineLabel={machineLabel}
            canEdit={access.canEdit && busy !== "location"}
            error={errors.location ?? null}
            onChangeRoot={() => {
              setEditorError(null);
              setEditor({ kind: "root", initialValue: project.cwd });
            }}
          />
        );
      case "repository":
        return (
          <ProjectRepositorySection
            project={project}
            isRepo={isRepo?.cwd === project.cwd ? isRepo.value : null}
            canEdit={access.canEdit}
            busy={busy === "repository"}
            error={errors.repository ?? null}
            onChoose={(remoteName) =>
              void run(
                "repository",
                () =>
                  writeProjectMeta(environmentId, projectId, { preferredRemoteName: remoteName }),
                "The primary remote could not be changed.",
              )
            }
            onInitializeGit={() =>
              void run(
                "repository",
                () => initializeProjectGit(environmentId, project.cwd),
                "Git could not be initialized.",
              ).then((initialized) => {
                if (initialized) setIsRepo({ cwd: project.cwd, value: true });
              })
            }
          />
        );
      case "workspaces":
        return (
          <ProjectWorkspacesSection
            inspection={workspaceData.inspection}
            disk={workspaceData.disk}
            canChange={access.canChangeWorkspaces}
            busyWorktreeId={busyWorktreeId}
            error={errors.workspaces ?? null}
            onRemeasure={workspaceData.remeasure}
            onAction={workspaceAction}
          />
        );
      case "defaults":
        return <ProjectNewTaskDefaults environmentId={environmentId} projectId={projectId} />;
      case "actions":
        return (
          <ProjectActionsSection
            scripts={project.scripts}
            canEdit={access.canEdit}
            onAdd={() => {
              setScriptError(null);
              setScriptSheet((current) => openSheet(current, { script: null }));
            }}
            onEdit={(script) => {
              setScriptError(null);
              setScriptSheet((current) => openSheet(current, { script }));
            }}
          />
        );
      case "instructions":
        return (
          <ProjectInstructionsSection
            saved={project.customSystemPrompt}
            canEdit={access.canEdit}
            busy={busy === "instructions"}
            error={errors.instructions ?? null}
            onSave={(next) =>
              run(
                "instructions",
                () => writeProjectMeta(environmentId, projectId, { customSystemPrompt: next }),
                "The instructions could not be saved.",
              )
            }
          />
        );
      case "integrations":
        return (
          <ProjectAtlassianSection
            environmentId={environmentId}
            projectId={projectId}
            machineLabel={machineLabel}
            repositoryIdentity={project.repositoryIdentity}
            canEdit={access.canManageNode}
          />
        );
      case "danger":
        return (
          <ProjectDangerSection
            machineLabel={machineLabel}
            threadCount={threadCount}
            canEdit={access.canEdit}
            busy={busy === "danger"}
            error={errors.danger ?? null}
            onRemove={removeProject}
          />
        );
      case "automations":
        return null;
    }
  };

  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 56 }}
      >
        <View className="mx-5 gap-4 rounded-[22px] bg-card p-5">
          <View className="flex-row items-center gap-3">
            <ProjectFavicon
              environmentId={environmentId}
              projectId={projectId}
              customAvatarContentHash={project.customAvatarContentHash}
              projectTitle={project.name}
              size={44}
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-xl font-ryco-medium text-foreground" numberOfLines={2}>
                {project.name}
              </Text>
              <Text className="text-sm font-ryco-medium text-foreground-tertiary">
                {machineLabel}
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2">
            <HeaderButton
              label="Rename"
              disabled={!access.canEdit}
              onPress={() => {
                setEditorError(null);
                setEditor({ kind: "rename", initialValue: project.name });
              }}
            />
            {project.customAvatarContentHash ? (
              <HeaderButton
                label={busy === "header" ? "Removing…" : "Remove image"}
                disabled={!access.canEdit || busy === "header"}
                onPress={removeImage}
              />
            ) : null}
          </View>
        </View>
        <View className="mx-5 mt-3 gap-2">
          {errors.header ? <ErrorBanner message={errors.header} /> : null}
          {access.reason ? <ErrorBanner message={access.reason} /> : null}
          {access.nodeReason ? (
            <Text className="px-1 text-xs leading-4 text-foreground-muted">
              {access.nodeReason}
            </Text>
          ) : null}
        </View>

        {groups.map((group) => (
          <Fragment key={group.label ?? "end"}>
            {group.sections.map((section) => (
              <Fragment key={section}>{renderSection(section)}</Fragment>
            ))}
          </Fragment>
        ))}
      </ScrollView>

      <WorktreeEditorSheet
        visible={editor !== null}
        title={editor?.kind === "root" ? "Project root" : "Rename project"}
        detail={
          editor?.kind === "root"
            ? `The folder on ${machineLabel} this project's tasks run in. Nothing on disk moves.`
            : "Choose a short name that is easy to recognize on mobile."
        }
        label={editor?.kind === "root" ? "Folder" : "Title"}
        initialValue={editor?.initialValue}
        placeholder={editor?.kind === "root" ? "/srv/code/app" : "Project name"}
        actionLabel={editor?.kind === "root" ? "Continue" : "Save"}
        error={editorError}
        onClose={() => {
          setEditor(null);
          setEditorError(null);
        }}
        onSubmit={submitEditor}
      />
      <ProjectScriptEditorSheet
        visible={scriptSheet.open}
        target={scriptSheet.target}
        token={scriptSheet.token}
        busy={busy === "actions"}
        error={scriptError}
        onClose={() => {
          if (busy !== "actions") setScriptSheet((current) => ({ ...current, open: false }));
        }}
        onSave={saveScript}
        onDelete={deleteScript}
      />
      <WorkspaceReviewSheet
        visible={review.open}
        target={review.target}
        token={review.token}
        canApply={access.canChangeWorkspaces}
        previewDenied={
          access.canInspectWorkspaces
            ? null
            : (access.reason ?? "Your role on this machine can't change workspaces.")
        }
        accessReason={access.reason}
        onClose={() => setReview((current) => ({ ...current, open: false }))}
        onChanged={workspaceData.refresh}
      />
    </>
  );
}

function HeaderButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-11 items-center justify-center rounded-full bg-subtle px-4 active:bg-subtle-strong disabled:opacity-40"
    >
      <Text className="text-sm font-ryco-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
