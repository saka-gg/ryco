/**
 * terminalShell - the user's shell and the environment Ryco starts commands in on their behalf.
 *
 * Shared by the terminal manager (an interactive shell in a PTY) and by commands that run
 * unattended in a project, such as an import's setup command (the same shell, non-interactive).
 * Both get the server's environment without the server's own variables, plus whatever the caller
 * adds (the project script variables).
 *
 * @module terminalShell
 */
import path from "node:path";

/** Server variables never handed to a shell: they belong to this server, not to the user's tools. */
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

/** `RYCO_*` (tokens, ports, state paths), `VITE_*` and the blocklist above. */
export function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("RYCO_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

/** `baseEnv` without the excluded keys, then `runtimeEnv` on top (it may set `RYCO_*` itself). */
export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

export interface ShellCandidate {
  shell: string;
  /** The arguments for an interactive session. */
  args?: string[];
}

export function defaultShellResolver(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellName(command: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.basename(command).toLowerCase()
    : path.basename(command).toLowerCase();
}

function isPowerShell(name: string): boolean {
  return (
    name === "pwsh.exe" || name === "powershell.exe" || name === "pwsh" || name === "powershell"
  );
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform = process.platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const name = shellName(command, platform);
  if (platform === "win32" && (name === "pwsh.exe" || name === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && name === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(windowsSystemRoot(env), "System32", "cmd.exe");
}

export function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

/**
 * The resolved shell first, then the fallbacks to try in order when it cannot be started:
 * `$SHELL` and the usual POSIX shells, or PowerShell and `cmd.exe` on Windows.
 */
export function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

/** How to start one command line through a shell, unattended. */
export interface ShellCommandInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * `cmd.exe` only: spawn `command` with this as the spawner's `shell`, which builds
   * `cmd.exe /d /s /c "<command>"` with the verbatim quoting cmd needs.
   */
  readonly shell?: string | undefined;
}

/**
 * PowerShell ends with exit code 1 for any failed last statement, even a native command's
 * other exit code; this keeps the native code.
 */
const POWERSHELL_EXIT_CODE_TRAILER =
  "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } exit 1 }";

/**
 * Runs `commandLine` non-interactively through `candidate`, without a prompt or profile
 * questions: a POSIX shell as a login shell (`-l -c`, so the user's login PATH applies; csh
 * accepts `-l` only on its own, so `-c`), PowerShell with `-NoProfile -NonInteractive` and the
 * command base64-encoded (no quoting rules to get wrong), `cmd.exe` through `/d /s /c`.
 */
export function nonInteractiveShellCommand(
  candidate: ShellCandidate,
  commandLine: string,
  platform: NodeJS.Platform = process.platform,
): ShellCommandInvocation {
  const name = shellName(candidate.shell, platform);
  if (isPowerShell(name)) {
    const script = `${commandLine}\n${POWERSHELL_EXIT_CODE_TRAILER}`;
    return {
      command: candidate.shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  if (platform === "win32" && (name === "cmd.exe" || name === "cmd")) {
    return { command: commandLine, args: [], shell: candidate.shell };
  }
  if (name === "csh" || name === "tcsh") {
    return { command: candidate.shell, args: ["-c", commandLine] };
  }
  return { command: candidate.shell, args: ["-l", "-c", commandLine] };
}
