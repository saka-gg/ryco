import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type {
  EnvironmentId,
  ProjectId,
  ProjectScript,
  RepositoryIdentity,
  SidebarProjectGroupingMode,
} from "@ryco/contracts";

import {
  resolveProjectRemoteLink,
  resolveRemoteUrlToBrowserUrl,
} from "./components/sidebar/sidebarProjectRemoteLink";
import { toastManager } from "./components/ui/toast";
import { useComposerDraftStore } from "./composerDraftStore";
import { isHostedHubMode } from "./env";
import { readEnvironmentApi } from "./environmentApi";
import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import { openExternalLink } from "./lib/openExternalLink";
import { newCommandId } from "./lib/utils";
import { deriveProjectGroupingOverrideKey } from "./logicalProject";

/**
 * Project mutations shared by every surface that manages a project (the
 * projects page, the sidebar menus, the frozen phone dialogs), so each write
 * has one implementation.
 */

export interface ProjectCheckoutRef {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

function requireProjectApi(environmentId: EnvironmentId) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("Project API unavailable.");
  return api;
}

export interface ProjectMetaPatch {
  readonly title?: string;
  readonly workspaceRoot?: string;
  /** Null clears the prompt. */
  readonly customSystemPrompt?: string | null;
  /** Null returns to auto-detecting the primary remote. */
  readonly preferredRemoteName?: string | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

/** One `project.meta.update` carrying only the fields given. */
export async function updateProjectMeta(
  project: ProjectCheckoutRef,
  patch: ProjectMetaPatch,
): Promise<void> {
  await requireProjectApi(project.environmentId).orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId: project.id,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.workspaceRoot !== undefined ? { workspaceRoot: patch.workspaceRoot } : {}),
    ...(patch.customSystemPrompt !== undefined
      ? { customSystemPrompt: patch.customSystemPrompt }
      : {}),
    ...(patch.preferredRemoteName !== undefined
      ? { preferredRemoteName: patch.preferredRemoteName }
      : {}),
    ...(patch.scripts !== undefined ? { scripts: [...patch.scripts] } : {}),
  });
}

// ── Project image ──────────────────────────────────────────────────────

/** Node HTTP routes are not relayed in hosted mode, so the upload cannot reach the node. */
export const PROJECT_AVATAR_UPLOAD_UNAVAILABLE_REASON =
  "Project image upload is unavailable in hosted mode because node HTTP routes are not relayed.";

export function projectAvatarUploadUnavailableReason(): string | null {
  return isHostedHubMode() ? PROJECT_AVATAR_UPLOAD_UNAVAILABLE_REASON : null;
}

/** Uploads the image, then points the project at it. Resolves to its content hash. */
export async function uploadProjectAvatar(
  project: ProjectCheckoutRef,
  file: File,
): Promise<string> {
  const unavailable = projectAvatarUploadUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const api = requireProjectApi(project.environmentId);
  const httpUrl = resolveEnvironmentHttpUrl({
    environmentId: project.environmentId,
    pathname: "/api/project-avatar/upload",
    searchParams: { projectId: project.id },
  });
  const formData = new FormData();
  formData.append("avatar", file);
  const response = await fetch(httpUrl, { method: "POST", body: formData, credentials: "include" });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Upload failed: ${response.status}`);
  }
  const { contentHash } = (await response.json()) as { contentHash: string };
  await api.orchestration.dispatchCommand({
    type: "project.avatar.set",
    commandId: newCommandId(),
    projectId: project.id,
    contentHash,
  });
  return contentHash;
}

/** Back to the auto-detected favicon. */
export async function removeProjectAvatar(project: ProjectCheckoutRef): Promise<void> {
  await requireProjectApi(project.environmentId).orchestration.dispatchCommand({
    type: "project.avatar.set",
    commandId: newCommandId(),
    projectId: project.id,
    contentHash: null,
  });
}

// ── Remote ─────────────────────────────────────────────────────────────

/**
 * Opens a remote in the browser: the named one, else the preferred remote
 * (or the auto-detected primary). Says so when there is nothing to open.
 */
export function openProjectRemote(
  project: {
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
    readonly preferredRemoteName?: string | null | undefined;
  },
  remoteName?: string,
): void {
  const url =
    remoteName !== undefined
      ? resolveRemoteUrlToBrowserUrl(
          (project.repositoryIdentity?.remotes ?? []).find((remote) => remote.name === remoteName)
            ?.url ?? "",
        )
      : (resolveProjectRemoteLink(project.repositoryIdentity, project.preferredRemoteName)?.url ??
        null);
  if (!url) {
    toastManager.add({ type: "warning", title: "No remote link available" });
    return;
  }
  openExternalLink(url, "Unable to open remote repository");
}

// ── Remove ─────────────────────────────────────────────────────────────

/**
 * Removes the project from one device. Files on disk are never touched;
 * `force` deletes its threads first (the server refuses otherwise). Clears the
 * project's composer draft so nothing points at the removed project.
 */
export async function removeProjectCheckout(
  project: ProjectCheckoutRef,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  const draftStore = useComposerDraftStore.getState();
  const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
  if (projectDraftThread) draftStore.clearDraftThread(projectDraftThread.draftId);
  draftStore.clearProjectDraftThreadId(projectRef);
  await requireProjectApi(project.environmentId).orchestration.dispatchCommand({
    type: "project.delete",
    commandId: newCommandId(),
    projectId: project.id,
    ...(options.force === true ? { force: true } : {}),
  });
}

/** The facts a removal confirmation states, one per line. */
export function describeProjectRemoval(input: {
  readonly name: string;
  readonly cwd: string;
  readonly environmentLabel: string | null;
  readonly threadCount: number;
}): { readonly title: string; readonly lines: readonly string[] } {
  const threads = `${input.threadCount} thread${input.threadCount === 1 ? "" : "s"}`;
  return {
    title:
      input.threadCount > 0
        ? `Remove project "${input.name}" and delete its ${threads}?`
        : `Remove project "${input.name}"?`,
    lines: [
      `Path: ${input.cwd}`,
      ...(input.environmentLabel ? [`Environment: ${input.environmentLabel}`] : []),
      ...(input.threadCount > 0
        ? ["This permanently clears conversation history for those threads."]
        : []),
      "This removes only this project entry.",
      ...(input.threadCount > 0 ? ["This action cannot be undone."] : []),
    ],
  };
}

// ── Sidebar grouping (client setting) ──────────────────────────────────

export type ProjectGroupingChoice = SidebarProjectGroupingMode | "inherit";

/** This checkout's grouping override, or "inherit" when it follows the global mode. */
export function readProjectGroupingChoice(
  overrides: Readonly<Record<string, SidebarProjectGroupingMode>> | undefined,
  project: { readonly environmentId: EnvironmentId; readonly cwd: string },
): ProjectGroupingChoice {
  return overrides?.[deriveProjectGroupingOverrideKey(project)] ?? "inherit";
}

/** The overrides map with this checkout's choice applied ("inherit" removes it). */
export function withProjectGroupingChoice(
  overrides: Readonly<Record<string, SidebarProjectGroupingMode>> | undefined,
  project: { readonly environmentId: EnvironmentId; readonly cwd: string },
  choice: ProjectGroupingChoice,
): Record<string, SidebarProjectGroupingMode> {
  const key = deriveProjectGroupingOverrideKey(project);
  const next = { ...overrides };
  if (choice === "inherit") delete next[key];
  else next[key] = choice;
  return next;
}
