import { scopedScriptCommand } from "@ryco/client-runtime/state/settings";
import type { EnvironmentId, KeybindingCommand, ProjectScript } from "@ryco/contracts";
import { useCallback } from "react";

import { updateAppKeybinding } from "../appKeybindings";
import type { NewProjectScriptInput } from "../components/ProjectScriptDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { decodeProjectScriptKeybindingRule } from "../lib/projectScriptKeybindings";
import { updateProjectMeta } from "../projectMutations";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import type { Project } from "../types";

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
      const nextId = nextProjectScriptId(
        input.name,
        project.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...project.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...project.scripts, nextScript];

      await persist({
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [persist, project],
  );

  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!project) return;
      const existingScript = project.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = project.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persist({
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [persist, project],
  );

  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!project) return;
      const nextScripts = project.scripts.filter((script) => script.id !== scriptId);
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
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    },
    [persist, project],
  );

  return { saveProjectScript, updateProjectScript, deleteProjectScript };
}
