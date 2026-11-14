import {
  withAddedProjectScript,
  withoutProjectScript,
  withUpdatedProjectScript,
} from "@ryco/client-runtime/projectSettings/scripts";
import { scopedScriptCommand } from "@ryco/client-runtime/state/settings";
import type { EnvironmentId, KeybindingCommand, ProjectScript } from "@ryco/contracts";
import { useCallback } from "react";

import { updateAppKeybinding } from "../appKeybindings";
import type { NewProjectScriptInput } from "../components/ProjectScriptDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { decodeProjectScriptKeybindingRule } from "../lib/projectScriptKeybindings";
import { updateProjectMeta } from "../projectMutations";
import { commandForProjectScript } from "../projectScripts";
import type { Project } from "../types";
import { errorMessage } from "~/lib/errorMessage";

export interface ProjectScriptMutations {
  readonly saveProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  readonly updateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  readonly deleteProjectScript: (scriptId: string) => Promise<void>;
}

/**
 * Creating, editing and deleting a project's actions: the scripts list on
 * the project, plus each action's shortcut (an app keybinding scoped to the
 * project). Only one action may run on new worktrees, so turning it on for one
 * turns it off for the rest. The chat header and the projects page share it.
 */
export function useProjectScriptMutations(
  environmentId: EnvironmentId,
  project: Pick<Project, "id" | "scripts"> | undefined,
): ProjectScriptMutations {
  // Uncompiled on purpose: Babel's React Compiler never compiled this function
  // (it bails on value blocks inside try/catch). Oxc can, but its render reads
  // have not been audited for purity yet. Remove after that audit.
  "use no memo";
  const persist = useCallback(
    async (input: {
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      if (!project) return;
      await updateProjectMeta({ environmentId, id: project.id }, { scripts: input.nextScripts });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });
      const command = scopedScriptCommand(
        { environmentId, projectId: project.id },
        input.keybindingCommand.slice("script.".length, -".run".length),
      );
      await updateAppKeybinding(command, keybindingRule ? { ...keybindingRule, command } : null);
    },
    [environmentId, project],
  );

  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!project) return;
      const next = withAddedProjectScript(project.scripts, input);
      await persist({
        nextScripts: next.scripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(next.scriptId),
      });
    },
    [persist, project],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!project) return;
      await persist({
        nextScripts: withUpdatedProjectScript(project.scripts, scriptId, input),
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [persist, project],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!project) return;
      const nextScripts = withoutProjectScript(project.scripts, scriptId);
      const deletedName = project.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persist({
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: errorMessage(error, "An unexpected error occurred."),
          }),
        );
      }
    },
    [persist, project],
  );

  return { saveProjectScript, updateProjectScript, deleteProjectScript };
}
