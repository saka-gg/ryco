import { useCallback, useEffect, useRef, useState } from "react";
import { readLocalApi } from "../../../localApi";
import {
  openProjectRemote,
  projectAvatarUploadUnavailableReason,
  removeProjectAvatar as removeSharedProjectAvatar,
  updateProjectMeta,
  uploadProjectAvatar as uploadSharedProjectAvatar,
} from "../../../projectMutations";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { stackedThreadToast, toastManager } from "../../ui/toast";

export function useSidebarProjectSettingsDialog() {
  const [projectSettingsTarget, setProjectSettingsTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const projectSettingsTargetRef = useRef<SidebarProjectGroupMember | null>(null);
  const projectSettingsOpenFrameRef = useRef<number | null>(null);
  const projectSettingsCleanupTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    projectSettingsTargetRef.current = projectSettingsTarget;
  }, [projectSettingsTarget]);
  const clearProjectSettingsTimers = useCallback(() => {
    if (projectSettingsOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(projectSettingsOpenFrameRef.current);
      projectSettingsOpenFrameRef.current = null;
    }
    if (projectSettingsCleanupTimeoutRef.current !== null) {
      window.clearTimeout(projectSettingsCleanupTimeoutRef.current);
      projectSettingsCleanupTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => () => clearProjectSettingsTimers(), [clearProjectSettingsTimers]);
  const [projectSettingsTitle, setProjectSettingsTitle] = useState("");
  const [projectSettingsWorkspaceRoot, setProjectSettingsWorkspaceRoot] = useState("");
  const [projectSettingsCustomSystemPrompt, setProjectSettingsCustomSystemPrompt] = useState("");
  const [projectSettingsSaving, setProjectSettingsSaving] = useState(false);
  const [projectSettingsCustomAvatarContentHash, setProjectSettingsCustomAvatarContentHash] =
    useState<string | null>(null);
  const [projectSettingsPreferredRemoteName, setProjectSettingsPreferredRemoteName] = useState<
    string | null
  >(null);

  const openProjectSettingsDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      clearProjectSettingsTimers();
      setProjectSettingsOpen(false);
      setProjectSettingsTarget(member);
      setProjectSettingsTitle(member.name);
      setProjectSettingsWorkspaceRoot(member.cwd);
      setProjectSettingsCustomSystemPrompt(member.customSystemPrompt ?? "");
      setProjectSettingsSaving(false);
      setProjectSettingsCustomAvatarContentHash(member.customAvatarContentHash ?? null);
      setProjectSettingsPreferredRemoteName(member.preferredRemoteName ?? null);
      projectSettingsOpenFrameRef.current = window.requestAnimationFrame(() => {
        projectSettingsOpenFrameRef.current = null;
        setProjectSettingsOpen(true);
      });
    },
    [clearProjectSettingsTimers],
  );

  const closeProjectSettingsDialog = useCallback(() => {
    if (projectSettingsOpenFrameRef.current !== null) {
      window.cancelAnimationFrame(projectSettingsOpenFrameRef.current);
      projectSettingsOpenFrameRef.current = null;
    }
    setProjectSettingsOpen(false);
    if (projectSettingsCleanupTimeoutRef.current !== null) {
      window.clearTimeout(projectSettingsCleanupTimeoutRef.current);
    }
    projectSettingsCleanupTimeoutRef.current = window.setTimeout(() => {
      projectSettingsCleanupTimeoutRef.current = null;
      setProjectSettingsTarget(null);
      setProjectSettingsTitle("");
      setProjectSettingsWorkspaceRoot("");
      setProjectSettingsCustomSystemPrompt("");
      setProjectSettingsSaving(false);
      setProjectSettingsCustomAvatarContentHash(null);
      setProjectSettingsPreferredRemoteName(null);
    }, 340);
  }, []);

  const pickProjectSettingsWorkspaceRoot = useCallback(async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Folder picker is unavailable.",
      });
      return;
    }

    const picked = await api.dialogs.pickFolder({
      initialPath: projectSettingsWorkspaceRoot.trim() || projectSettingsTarget?.cwd || null,
    });
    if (picked) {
      setProjectSettingsWorkspaceRoot(picked);
    }
  }, [projectSettingsTarget?.cwd, projectSettingsWorkspaceRoot]);

  const submitProjectSettings = useCallback(async () => {
    if (!projectSettingsTarget || projectSettingsSaving) {
      return;
    }

    const title = projectSettingsTitle.trim();
    const workspaceRoot = projectSettingsWorkspaceRoot.trim();
    const customSystemPrompt = projectSettingsCustomSystemPrompt.trim();
    if (title.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project title cannot be empty",
      });
      return;
    }
    if (workspaceRoot.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project root cannot be empty",
      });
      return;
    }

    const titleChanged = title !== projectSettingsTarget.name;
    const workspaceRootChanged = workspaceRoot !== projectSettingsTarget.cwd;
    const currentCustomSystemPrompt = projectSettingsTarget.customSystemPrompt?.trim() ?? "";
    const customSystemPromptChanged = customSystemPrompt !== currentCustomSystemPrompt;
    const preferredRemoteNameChanged =
      projectSettingsPreferredRemoteName !== (projectSettingsTarget.preferredRemoteName ?? null);
    if (
      !titleChanged &&
      !workspaceRootChanged &&
      !customSystemPromptChanged &&
      !preferredRemoteNameChanged
    ) {
      closeProjectSettingsDialog();
      return;
    }

    setProjectSettingsSaving(true);
    try {
      await updateProjectMeta(projectSettingsTarget, {
        ...(titleChanged ? { title } : {}),
        ...(workspaceRootChanged ? { workspaceRoot } : {}),
        ...(customSystemPromptChanged
          ? { customSystemPrompt: customSystemPrompt.length > 0 ? customSystemPrompt : null }
          : {}),
        ...(preferredRemoteNameChanged
          ? { preferredRemoteName: projectSettingsPreferredRemoteName }
          : {}),
      });
      closeProjectSettingsDialog();
    } catch (error) {
      setProjectSettingsSaving(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [
    closeProjectSettingsDialog,
    projectSettingsSaving,
    projectSettingsCustomSystemPrompt,
    projectSettingsPreferredRemoteName,
    projectSettingsTarget,
    projectSettingsTitle,
    projectSettingsWorkspaceRoot,
  ]);

  const uploadProjectAvatar = useCallback(
    async (file: File) => {
      const initiating = projectSettingsTarget;
      if (!initiating) return;
      const unavailable = projectAvatarUploadUnavailableReason();
      if (unavailable) {
        toastManager.add({ type: "warning", title: unavailable });
        return;
      }
      try {
        const contentHash = await uploadSharedProjectAvatar(initiating, file);
        if (projectSettingsTargetRef.current?.id === initiating.id) {
          setProjectSettingsCustomAvatarContentHash(contentHash);
        }
      } catch (error) {
        if (projectSettingsTargetRef.current?.id !== initiating.id) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to upload avatar",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [projectSettingsTarget],
  );

  const removeProjectAvatar = useCallback(async () => {
    const initiating = projectSettingsTarget;
    if (!initiating) return;
    try {
      await removeSharedProjectAvatar(initiating);
      if (projectSettingsTargetRef.current?.id === initiating.id) {
        setProjectSettingsCustomAvatarContentHash(null);
      }
    } catch (error) {
      if (projectSettingsTargetRef.current?.id !== initiating.id) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to remove avatar",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [projectSettingsTarget]);

  const openProjectRemoteByName = useCallback(
    (member: SidebarProjectGroupMember, remoteName: string) =>
      openProjectRemote(member, remoteName),
    [],
  );

  return {
    projectSettingsTarget,
    projectSettingsOpen,
    projectSettingsTitle,
    projectSettingsWorkspaceRoot,
    projectSettingsCustomSystemPrompt,
    projectSettingsSaving,
    projectSettingsCustomAvatarContentHash,
    projectSettingsPreferredRemoteName,
    projectAvatarUploadUnavailableReason: projectAvatarUploadUnavailableReason(),
    setProjectSettingsTitle,
    setProjectSettingsWorkspaceRoot,
    setProjectSettingsCustomSystemPrompt,
    setProjectSettingsPreferredRemoteName,
    openProjectSettingsDialog,
    closeProjectSettingsDialog,
    pickProjectSettingsWorkspaceRoot,
    submitProjectSettings,
    uploadProjectAvatar,
    removeProjectAvatar,
    openProjectRemoteByName,
  };
}
