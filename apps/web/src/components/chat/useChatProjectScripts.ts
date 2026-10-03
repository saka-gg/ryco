import { useCallback } from "react";
import {
  type EnvironmentId,
  type KeybindingCommand,
  type ProjectId,
  type ProjectScript,
  type ScopedThreadRef,
  type TerminalOpenInput,
  type ThreadId,
} from "@ryco/contracts";
import { projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { newCommandId, randomUUID } from "~/lib/utils";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { readEnvironmentApi } from "../../environmentApi";
import { updateAppKeybinding } from "../../appKeybindings";
import { scopedScriptCommand } from "@ryco/client-runtime/state/settings";
import { useEvent } from "../../hooks/useEvent";
import { DEFAULT_THREAD_TERMINAL_ID, type Project, type Thread } from "../../types";
import { LastInvokedScriptByProjectSchema } from "../ChatView.logic";
import { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { stackedThreadToast, toastManager } from "../ui/toast";

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type LastInvokedScriptByProject = typeof LastInvokedScriptByProjectSchema.Type;

export interface RunProjectScriptOptions {
  cwd?: string;
  env?: Record<string, string>;
  worktreePath?: string | null;
  preferNewTerminal?: boolean;
  rememberAsLastInvoked?: boolean;
}

export interface UseChatProjectScriptsInput {
  environmentId: EnvironmentId;
  activeThread: Thread | undefined;
  activeThreadId: ThreadId | null;
  activeThreadRef: ScopedThreadRef | null;
  activeProject: Project | undefined;
  gitCwd: string | null;
  terminalState: {
    activeTerminalId: string;
    terminalIds: readonly string[];
    runningTerminalIds: readonly string[];
  };
  setLastInvokedScriptByProjectId: (
    value:
      | LastInvokedScriptByProject
      | ((current: LastInvokedScriptByProject) => LastInvokedScriptByProject),
  ) => void;
  setTerminalLaunchContext: (context: {
    threadId: ThreadId;
    cwd: string;
    worktreePath: string | null;
  }) => void;
  setTerminalOpen: (open: boolean) => void;
  storeNewTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  storeSetActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  setTerminalFocusRequestId: (updater: (value: number) => number) => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
}

export interface UseChatProjectScriptsResult {
  runProjectScript: (script: ProjectScript, options?: RunProjectScriptOptions) => Promise<void>;
  saveProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  updateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  deleteProjectScript: (scriptId: string) => Promise<void>;
}

/**
 * Owns project-script execution and persistence for the active thread: running
 * a script in a terminal, and creating/updating/deleting scripts (with the
 * optional Electron keybinding rule that accompanies them).
 */
export function useChatProjectScripts(
  input: UseChatProjectScriptsInput,
): UseChatProjectScriptsResult {
  const {
    environmentId,
    activeThread,
    activeThreadId,
    activeThreadRef,
    activeProject,
    gitCwd,
    terminalState,
    setLastInvokedScriptByProjectId,
    setTerminalLaunchContext,
    setTerminalOpen,
    storeNewTerminal,
    storeSetActiveTerminal,
    setTerminalFocusRequestId,
    setThreadError,
  } = input;

  const runProjectScript = useEvent(
    async (script: ProjectScript, options?: RunProjectScriptOptions) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (
        activeProject.environmentId !== environmentId ||
        activeThread.environmentId !== environmentId ||
        activeThread.projectId !== activeProject.id
      )
        return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      const command = scopedScriptCommand(
        { environmentId, projectId: input.projectId },
        input.keybindingCommand.slice("script.".length, -".run".length),
      );
      await updateAppKeybinding(command, keybindingRule ? { ...keybindingRule, command } : null);
    },
    [environmentId],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
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
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
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
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
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
    [activeProject, persistProjectScripts],
  );

  return {
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
  };
}
