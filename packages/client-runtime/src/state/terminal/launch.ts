import { projectScriptCwd, projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";

export interface ThreadTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

/**
 * The one resolver for where a thread terminal starts, shared by the chat
 * drawer, the workspace terminal tab and the early prepare. They must agree
 * exactly: the server restarts a live PTY and wipes its history when open()
 * arrives with another cwd or environment. A server-reported launch context
 * (the terminal's actual start) wins over the thread's current worktree.
 */
export function resolveThreadTerminalLaunch(input: {
  readonly projectCwd: string | null;
  readonly threadWorktreePath: string | null;
  readonly launchContext: { readonly cwd: string; readonly worktreePath: string | null } | null;
}): ThreadTerminalLaunch | null {
  const worktreePath =
    input.launchContext !== null ? input.launchContext.worktreePath : input.threadWorktreePath;
  if (input.projectCwd === null) {
    return null;
  }
  const project = { cwd: input.projectCwd };
  return {
    cwd: input.launchContext?.cwd ?? projectScriptCwd({ project, worktreePath }),
    worktreePath,
    runtimeEnv: projectScriptRuntimeEnv({ project, worktreePath }),
  };
}
