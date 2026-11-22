/**
 * shellIntegration - marks prompts and command ends in the output of Ryco's zsh and bash
 * terminals, so tools that read a terminal know where a command's output starts and ends and
 * what it exited with, instead of guessing from the screen.
 *
 * The shells emit the FinalTerm / OSC 133 sequences terminals already understand:
 *
 * - `ESC ] 133 ; A BEL` the prompt starts (the shell waits for a command);
 * - `ESC ] 133 ; C BEL` a command line starts running (zsh `preexec`, bash 4.4+ `PS0`);
 * - `ESC ] 133 ; D ; <exit code> BEL` the previous command ended (every prompt but the first).
 *
 * xterm.js (the web and phone terminals) ignores them; they stay in the retained history.
 *
 * Injection follows VS Code's: zsh starts with `ZDOTDIR` pointing at Ryco's startup files, which
 * source the user's own (`$ZDOTDIR` or `$HOME`) with `ZDOTDIR` restored and leave it restored, so
 * `.zlogin`, history and completion files are the user's; bash starts with `--init-file`, which
 * sources `/etc/bash.bashrc` and `~/.bashrc` as an interactive bash would. Other shells start as
 * before. `RYCO_TERMINAL_SHELL_INTEGRATION=0` in the server's environment turns it off.
 *
 * @module shellIntegration
 */
import path from "node:path";

import type { ShellCandidate } from "./terminalShell.ts";

/** Bumped when a script changes, so a running older server's files are never rewritten. */
export const SHELL_INTEGRATION_VERSION = "v3";

const ZSH_ENV_SHIM = (
  file: string,
  takeNonce: boolean,
) => `# Ryco shell integration: runs the user's ${file} with their own ZDOTDIR.${
  takeNonce
    ? `
# The marks' nonce leaves the environment before any startup file or program can read it.
typeset -g __ryco_nonce="\${RYCO_SHELL_MARK_NONCE-}"
builtin unset RYCO_SHELL_MARK_NONCE`
    : ""
}
if [[ -f "\${RYCO_USER_ZDOTDIR:-$HOME}/${file}" ]]; then
  RYCO_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=\${RYCO_USER_ZDOTDIR:-$HOME}
  builtin source "$ZDOTDIR/${file}"
  RYCO_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$RYCO_ZDOTDIR
fi
`;

const ZSH_RC = `# Ryco shell integration: the user's .zshrc, then prompt and command marks (OSC 133).
# Every mark carries this session's nonce (ryco=...), so output that prints a look-alike mark
# (a file, a remote host) is never taken for one. Safe under \`setopt nounset\`.
RYCO_ZDOTDIR=$ZDOTDIR
ZDOTDIR=\${RYCO_USER_ZDOTDIR:-$HOME}
# /etc/zshrc (macOS) derived HISTFILE from Ryco's ZDOTDIR before this file ran.
if [[ "\${HISTFILE-}" == "$RYCO_ZDOTDIR/.zsh_history" ]]; then
  HISTFILE=$ZDOTDIR/.zsh_history
fi
if [[ -f "$ZDOTDIR/.zshrc" ]]; then
  builtin source "$ZDOTDIR/.zshrc"
fi
builtin unset RYCO_ZDOTDIR RYCO_USER_ZDOTDIR
if [[ -z "\${__ryco_shell_integration-}" ]]; then
  typeset -g __ryco_shell_integration=1
  typeset -g __ryco_prompted=0
  # The nonce lives on only in this one function's body: not in the environment, a variable or
  # a prompt string (\`typeset -f __ryco_mark\` typed in this shell still shows it).
  builtin eval "__ryco_mark() { builtin printf '\\\\e]133;%s;ryco=\${__ryco_nonce-}\\\\a' \\"\\$1\\"; }"
  builtin unset __ryco_nonce
  __ryco_precmd() {
    local ret=$?
    if (( __ryco_prompted )); then
      __ryco_mark "D;$ret"
    fi
    __ryco_prompted=1
    __ryco_mark A
    return $ret
  }
  __ryco_preexec() {
    __ryco_mark C
  }
  typeset -ga precmd_functions preexec_functions
  # First, so it sees the command's exit status; last, so C comes right before the output.
  precmd_functions=(__ryco_precmd "\${precmd_functions[@]}")
  preexec_functions+=(__ryco_preexec)
fi
`;

const BASH_RC = `# Ryco shell integration: the user's startup files, then prompt and command marks (OSC 133).
# Every mark carries this session's nonce (ryco=...); safe under \`set -u\`.
__ryco_nonce="\${RYCO_SHELL_MARK_NONCE-}"
builtin unset RYCO_SHELL_MARK_NONCE
if [ -r /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
if [ -z "\${__ryco_shell_integration-}" ]; then
  __ryco_shell_integration=1
  __ryco_prompted=0
  # The nonce lives on only in this one function's body: not in the environment, a variable or
  # PS0 (\`declare -f __ryco_mark\` typed in this shell still shows it).
  builtin eval "__ryco_mark() { builtin printf '\\\\033]133;%s;ryco=\${__ryco_nonce-}\\\\007' \\"\\$1\\"; }"
  builtin unset __ryco_nonce
  __ryco_precmd() {
    local ret=$?
    if [ "$__ryco_prompted" = 1 ]; then
      __ryco_mark "D;$ret"
    fi
    __ryco_prompted=1
    __ryco_mark A
    return $ret
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__ryco_precmd "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__ryco_precmd\${PROMPT_COMMAND:+
$PROMPT_COMMAND}"
  fi
  # PS0 (bash 4.4+) prints after a command line is read, before it runs.
  if [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" -eq 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 4 ]; }; then
    # A command substitution: the mark is printed, the nonce is not in PS0.
    PS0="\${PS0-}"'$(__ryco_mark C)'

  fi
fi
`;

/** The files to write under the integration directory, relative to it. */
export const shellIntegrationFiles = (): ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}> => [
  {
    path: path.join(SHELL_INTEGRATION_VERSION, "zsh", ".zshenv"),
    content: ZSH_ENV_SHIM(".zshenv", true),
  },
  {
    path: path.join(SHELL_INTEGRATION_VERSION, "zsh", ".zprofile"),
    content: ZSH_ENV_SHIM(".zprofile", false),
  },
  { path: path.join(SHELL_INTEGRATION_VERSION, "zsh", ".zshrc"), content: ZSH_RC },
  { path: path.join(SHELL_INTEGRATION_VERSION, "bash", "ryco.bash"), content: BASH_RC },
];

export const shellIntegrationDisabled = (env: NodeJS.ProcessEnv): boolean => {
  const value = env.RYCO_TERMINAL_SHELL_INTEGRATION?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
};

export interface ShellSpawn {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

const shellBaseName = (shell: string) => path.posix.basename(shell).toLowerCase();

/** The variable that hands a shell its marks' nonce; the startup files unset it at once. */
export const SHELL_MARK_NONCE_ENV = "RYCO_SHELL_MARK_NONCE";

/**
 * How to start `candidate` with integration from `dir` (already written), or `null` when the
 * shell is not one Ryco integrates (only zsh and bash, never on Windows) or its arguments
 * already choose startup files. `markNonce` goes into every mark the shell prints, so a reader
 * trusts only marks that carry it.
 */
export function withShellIntegration(
  candidate: ShellCandidate,
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform = process.platform,
  markNonce?: string,
): ShellSpawn | null {
  if (platform === "win32") return null;
  const name = shellBaseName(candidate.shell);
  const args = candidate.args ?? [];
  const root = path.join(dir, SHELL_INTEGRATION_VERSION);
  if (name === "zsh") {
    const zdotdir = path.join(root, "zsh");
    // A ZDOTDIR inherited from a Ryco terminal (a server started in one) is not the user's.
    const inherited = env.ZDOTDIR;
    const userZdotdir =
      inherited === undefined || inherited === "" || isIntegrationZdotdir(inherited)
        ? undefined
        : inherited;
    return {
      shell: candidate.shell,
      args,
      env: {
        ...env,
        ...(markNonce === undefined ? {} : { [SHELL_MARK_NONCE_ENV]: markNonce }),
        ZDOTDIR: zdotdir,
        ...(userZdotdir === undefined ? {} : { RYCO_USER_ZDOTDIR: userZdotdir }),
      },
    };
  }
  if (name === "bash") {
    if (args.some((arg) => arg === "--rcfile" || arg === "--init-file" || arg === "--norc"))
      return null;
    return {
      shell: candidate.shell,
      args: [...args, "--init-file", path.join(root, "bash", "ryco.bash")],
      env: markNonce === undefined ? env : { ...env, [SHELL_MARK_NONCE_ENV]: markNonce },
    };
  }
  return null;
}

const isIntegrationZdotdir = (value: string) =>
  /[\\/]shell-integration[\\/]v\d+[\\/]zsh[\\/]?$/.test(value);
