import type { ProjectScript, ProjectScriptIcon } from "@ryco/contracts";
import { projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";

/**
 * Running a project's scripts from the phone, without React: the list it
 * shows and the terminal request a run sends. Like the desktop, a script runs
 * in a new terminal of the thread, typed into the shell so its output and
 * exit stay in that terminal's history.
 */

/** Columns and rows a script's terminal starts with, as the desktop's. */
export const SCRIPT_TERMINAL_COLS = 120;
export const SCRIPT_TERMINAL_ROWS = 30;

const ICON_SYMBOL: Readonly<Record<ProjectScriptIcon, string>> = {
  play: "play.fill",
  test: "checkmark.seal",
  lint: "wand.and.stars",
  configure: "gearshape",
  build: "hammer",
  debug: "ant",
};

export interface ScriptRow {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly symbol: string;
  readonly setup: boolean;
}

/** The project's scripts in the order the project lists them. */
export function scriptRows(scripts: ReadonlyArray<ProjectScript>): ScriptRow[] {
  return scripts.map((script) => ({
    id: script.id,
    name: script.name,
    command: script.command,
    symbol: ICON_SYMBOL[script.icon],
    setup: script.runOnWorktreeCreate,
  }));
}

export interface ScriptRunRequest {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env: Record<string, string>;
  /** What is typed into the shell: the command and Return. */
  readonly input: string;
}

/**
 * What running `command` sends: the thread's workspace as cwd and the same
 * `RYCO_PROJECT_ROOT` / `RYCO_WORKTREE_PATH` variables the desktop sets.
 * A multi-line command is typed as it is, line by line, like the desktop
 * does. Null when the command is blank.
 */
export function scriptRunRequest(input: {
  readonly command: string;
  readonly projectCwd: string;
  readonly workspaceCwd: string;
  readonly worktreePath: string | null;
}): ScriptRunRequest | null {
  const command = input.command.replace(/\r\n?/gu, "\n").trim();
  if (command.length === 0) return null;
  return {
    cwd: input.workspaceCwd,
    worktreePath: input.worktreePath,
    env: projectScriptRuntimeEnv({
      project: { cwd: input.projectCwd },
      worktreePath: input.worktreePath,
    }),
    input: `${command.replace(/\n/gu, "\r")}\r`,
  };
}
