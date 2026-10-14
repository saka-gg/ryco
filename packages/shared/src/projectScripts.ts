import type { ProjectScript } from "@ryco/contracts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    RYCO_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.RYCO_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

/** Every setup-script terminal's id starts with this. */
export const PROJECT_SETUP_TERMINAL_ID_PREFIX = "setup-";

/** The terminal a project's setup script runs in. */
export function projectSetupTerminalId(scriptId: string): string {
  return `${PROJECT_SETUP_TERMINAL_ID_PREFIX}${scriptId}`;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
