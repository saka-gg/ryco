import { Schema } from "effect";
import { WorktreeSubmodules } from "@ryco/contracts";
import {
  WORKTREE_SUBMODULE_OPTIONS,
  selectWorktreeSubmodules,
  worktreeSubmodulesPatch,
} from "@ryco/shared/worktreeSubmodules";

import {
  ProjectOverrideSelectEditor,
  ProjectOverrideSelectSetting,
  type ProjectOverrideSelectSpec,
} from "./ProjectOverrideSelectSetting";

const WORKTREE_SUBMODULE_SETTING: ProjectOverrideSelectSpec<WorktreeSubmodules> = {
  title: "Worktree submodules",
  description:
    "How new worktrees initialize submodules. Project overrides take precedence over repository configuration and the device default.",
  ariaLabel: "Worktree submodule initialization",
  options: WORKTREE_SUBMODULE_OPTIONS,
  isValue: Schema.is(WorktreeSubmodules),
  supported: (capabilities) => capabilities.worktreeSubmoduleSettings === true,
  select: (settings, projectId) => {
    if (!settings) return { node: "recursive", override: null };
    const selected = selectWorktreeSubmodules({ settings, projectId });
    return {
      node: settings.worktreeSubmodules,
      override: selected.source === "project" ? selected.mode : null,
    };
  },
  patch: worktreeSubmodulesPatch,
  unsupportedStatus:
    "This node does not support configurable submodules. Update the node to change this setting.",
  inheritStatus: () => "Use repository configuration when present, otherwise the device default.",
  saveFailed: "Could not save submodule initialization. Try again.",
};

export function WorktreeSubmoduleSettings(props: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  return <ProjectOverrideSelectSetting spec={WORKTREE_SUBMODULE_SETTING} {...props} />;
}

export function WorktreeSubmoduleEditor(props: {
  readonly projectId: string;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  return <ProjectOverrideSelectEditor spec={WORKTREE_SUBMODULE_SETTING} {...props} />;
}
