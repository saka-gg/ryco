import type { ServerSettings, ServerSettingsPatch, WorktreeSubmodules } from "@ryco/contracts";

export const WORKTREE_SUBMODULE_OPTIONS = [
  {
    value: "recursive",
    label: "Recursive",
    description: "Initialize all submodules, including nested submodules.",
  },
  {
    value: "top-level",
    label: "Top-level only",
    description: "Initialize direct submodules; leave nested submodules uninitialized.",
  },
  {
    value: "none",
    label: "None",
    description: "Skip initialization; use a setup script or initialize manually.",
  },
] as const;

/** Platform-neutral selection and patching, shared by web/desktop and native consumers.
 * Repository policy is supplied by the server after reading the new checkout.
 */
export function selectWorktreeSubmodules(input: {
  readonly settings: Pick<ServerSettings, "worktreeSubmodules" | "projectWorktreeSubmodules">;
  readonly projectId?: string | undefined;
  readonly repositoryMode?: WorktreeSubmodules | undefined;
}): { readonly mode: WorktreeSubmodules; readonly source: "project" | "repository" | "node" } {
  const override =
    input.projectId && Object.hasOwn(input.settings.projectWorktreeSubmodules, input.projectId)
      ? input.settings.projectWorktreeSubmodules[input.projectId]
      : null;
  if (override != null) return { mode: override, source: "project" };
  if (input.repositoryMode !== undefined)
    return { mode: input.repositoryMode, source: "repository" };
  return { mode: input.settings.worktreeSubmodules, source: "node" };
}

export function worktreeSubmodulesPatch(
  projectId: string | null,
  mode: WorktreeSubmodules | null,
): ServerSettingsPatch {
  return projectId
    ? { projectWorktreeSubmodules: { [projectId]: mode } }
    : { worktreeSubmodules: mode ?? "recursive" };
}
