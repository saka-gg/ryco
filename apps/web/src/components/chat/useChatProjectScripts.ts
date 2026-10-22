import {
  type EnvironmentId,
  type ProjectScript,
  type ScopedThreadRef,
  TerminalBusyError,
  type TerminalOpenInput,
  type ThreadId,
} from "@ryco/contracts";
import { selectTerminalWriteRequireIdleSupported } from "@ryco/client-runtime/state/terminal";
import { projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import { Schema } from "effect";
import { randomUUID } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentServerConfig } from "../../hooks/useChatsAvailability";
import { useEvent } from "../../hooks/useEvent";
import { DEFAULT_THREAD_TERMINAL_ID, type Project, type Thread } from "../../types";
import { LastInvokedScriptByProjectSchema } from "../ChatView.logic";
import { type NewProjectScriptInput } from "../ProjectScriptDialog";
import { useProjectScriptMutations } from "../../hooks/useProjectScriptMutations";

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
const isTerminalBusyError = Schema.is(TerminalBusyError);

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
      // The base terminal is reused only where the node verifies its shell idle before typing
      // the command (the client's running state lags); elsewhere the script gets a new one.
      const canReuseBaseTerminal = selectTerminalWriteRequireIdleSupported(
        readEnvironmentServerConfig(environmentId),
      );
      const shouldCreateNewTerminal =
        Boolean(options?.preferNewTerminal) || isBaseTerminalBusy || !canReuseBaseTerminal;
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
      const openTerminalInput = (terminalId: string, isNew: boolean): TerminalOpenInput => ({
        threadId: activeThreadId,
        terminalId,
        cwd: targetCwd,
        ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
        env: runtimeEnv,
        ...(isNew ? { cols: SCRIPT_TERMINAL_COLS, rows: SCRIPT_TERMINAL_ROWS } : {}),
      });
      const writeCommand = (terminalId: string, requireIdle: boolean) =>
        api.terminal.write({
          threadId: activeThreadId,
          terminalId,
          data: `${script.command}\r`,
          ...(requireIdle ? { requireIdle: true as const } : {}),
        });

      try {
        await api.terminal.open(openTerminalInput(targetTerminalId, shouldCreateNewTerminal));
        try {
          await writeCommand(targetTerminalId, !shouldCreateNewTerminal);
        } catch (error) {
          // The node found the reused shell busy, or could not tell, and wrote nothing: run
          // the script in a new terminal instead of typing into whatever runs there.
          if (shouldCreateNewTerminal || !isTerminalBusyError(error)) throw error;
          const fallbackTerminalId = `terminal-${randomUUID()}`;
          storeNewTerminal(activeThreadRef, fallbackTerminalId);
          setTerminalFocusRequestId((value) => value + 1);
          await api.terminal.open(openTerminalInput(fallbackTerminalId, true));
          await writeCommand(fallbackTerminalId, false);
        }
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
  );

  const { saveProjectScript, updateProjectScript, deleteProjectScript } = useProjectScriptMutations(
    environmentId,
    activeProject,
  );

  return {
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
  };
}
