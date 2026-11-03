/**
 * Agent process priority policy: agent CLIs, and everything they start, run at a lower CPU
 * priority than the server, so the server, its UI and Git stay responsive when agents load the
 * machine.
 *
 * POSIX: the agent is exec'd through an absolute `nice -n <increment>`, which keeps the PID,
 * process group and argv semantics (nice execs in place; no shell) and is inherited by every
 * descendant. `nice -n` is relative, so an already lower server priority is never raised.
 * Windows, shell launches and every case where exec through `nice` would change behavior: the
 * running child is lowered after spawn instead ({@link lowerChildProcessPriority}).
 *
 * Framework-free and fail-open: nothing here throws or rejects.
 *
 * @module processPriority
 */
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCommandPathAsync } from "./shell.ts";

/** POSIX: agents run this much lower than the server (`nice -n` is relative, so it never raises). */
export const AGENT_NICE_INCREMENT = 5;

/** Absolute locations only; PATH is never searched for the launcher. */
export const NICE_EXECUTABLE_CANDIDATES = [
  "/usr/bin/nice",
  "/bin/nice",
  "/run/current-system/sw/bin/nice",
] as const;

/** POSIX `getpriority` values run from -20 to 19. */
const POSIX_LOWEST_PRIORITY = 19;
/** `os.constants.priority.PRIORITY_BELOW_NORMAL`. */
const WINDOWS_BELOW_NORMAL_PRIORITY = 10;

/**
 * - `off`: the setting is off; spawn exactly as before.
 * - `exec-nice`: spawn `nice -n <increment> <command> ...args` (see {@link applyAgentLaunchPlan}).
 * - `after-spawn`: spawn the command unchanged, then lower the running child.
 */
export type AgentPriorityMode = "off" | "exec-nice" | "after-spawn";

export interface AgentLaunchPlan {
  readonly mode: AgentPriorityMode;
  /** `[niceExecutable, "-n", "<increment>"]` for "exec-nice", empty otherwise. */
  readonly prefix: ReadonlyArray<string>;
}

export interface AgentLaunchFacts {
  readonly enabled: boolean;
  readonly platform: NodeJS.Platform;
  /** The command runs through a shell (`shell` spawn option truthy). */
  readonly shell: boolean;
  /** An absolute, executable `nice`, or null. */
  readonly niceExecutable: string | null;
  /** The command was verified to resolve to an executable for the child's PATH and cwd. */
  readonly commandResolves: boolean;
  /**
   * The launch environment sets a `DYLD_*` variable. On macOS `/usr/bin/nice` is SIP-protected,
   * so dyld strips those variables from the environment it passes on.
   */
  readonly dyldEnvironment: boolean;
  /** Overrides {@link AGENT_NICE_INCREMENT} (measurement only). */
  readonly increment?: number;
}

export const AGENT_LAUNCH_OFF: AgentLaunchPlan = { mode: "off", prefix: [] };
const AGENT_LAUNCH_AFTER_SPAWN: AgentLaunchPlan = { mode: "after-spawn", prefix: [] };

/** How one agent launch is lowered; pure. */
export function planAgentLaunch(facts: AgentLaunchFacts): AgentLaunchPlan {
  if (!facts.enabled) return AGENT_LAUNCH_OFF;
  if (
    facts.platform === "win32" ||
    facts.shell ||
    facts.niceExecutable === null ||
    !facts.commandResolves ||
    (facts.platform === "darwin" && facts.dyldEnvironment)
  ) {
    return AGENT_LAUNCH_AFTER_SPAWN;
  }
  return {
    mode: "exec-nice",
    prefix: [facts.niceExecutable, "-n", String(facts.increment ?? AGENT_NICE_INCREMENT)],
  };
}

/**
 * The argv to spawn: `nice -n 5 <command> ...args` for "exec-nice", unchanged otherwise.
 *
 * The ORIGINAL command string is passed to `nice`, not a resolved path: nice's `execvp` uses the
 * same PATH (the environment given to spawn) and the same cwd as Node's own lookup, so argv[0],
 * relative commands and PATH semantics stay what a direct spawn does.
 */
export function applyAgentLaunchPlan(
  plan: AgentLaunchPlan,
  command: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const [launcher, ...launcherArgs] = plan.prefix;
  if (plan.mode !== "exec-nice" || launcher === undefined) return { command, args };
  return { command: launcher, args: [...launcherArgs, command, ...args] };
}

/** Whether `env` sets any `DYLD_*` variable (see {@link AgentLaunchFacts.dyldEnvironment}). */
export function hasDyldEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => key.startsWith("DYLD_") && value !== undefined);
}

export interface NiceExecutableFileSystem {
  readonly statSync: (filePath: string) => { isFile(): boolean };
  readonly accessSync: (filePath: string, mode?: number) => void;
}

/** A memoized lookup of the first executable {@link NICE_EXECUTABLE_CANDIDATES} entry. */
export function makeNiceExecutableResolver(
  fs: NiceExecutableFileSystem = { statSync, accessSync },
  candidates: ReadonlyArray<string> = NICE_EXECUTABLE_CANDIDATES,
): () => string | null {
  let resolved: { readonly value: string | null } | undefined;
  return () => {
    if (resolved === undefined) {
      resolved = { value: candidates.find((candidate) => isExecutable(fs, candidate)) ?? null };
    }
    return resolved.value;
  };
}

function isExecutable(fs: NiceExecutableFileSystem, filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute `nice` of this process, computed once (two `stat`s at most). */
export const resolveNiceExecutable: () => string | null = makeNiceExecutableResolver();

/**
 * Would a direct spawn of `command` find an executable? Mirrors the Node/libuv lookup: a bare
 * name searches `env.PATH`, and a relative path, like a relative PATH entry, resolves against the
 * child's `cwd` (the lookup runs in the child after its `chdir`, for a direct spawn and for nice's
 * `execvp` alike). Never rejects; each stalled PATH entry is bounded by `resolveCommandPathAsync`.
 */
export async function agentCommandResolves(
  command: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string | undefined;
    readonly platform: NodeJS.Platform;
  },
): Promise<boolean> {
  try {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const bareName = !(command.includes("/") || command.includes("\\"));
    const target = path.isAbsolute(command) || bareName ? command : path.resolve(cwd, command);
    const resolved = await resolveCommandPathAsync(target, {
      env: bareName ? withPathEntriesRelativeTo(options.env, cwd, options.platform) : options.env,
      platform: options.platform,
    });
    return resolved !== null;
  } catch {
    return false;
  }
}

/**
 * `env` with its relative POSIX PATH entries made absolute against `cwd`, so the check sees what
 * the child's lookup sees instead of resolving them against the server's own cwd. Empty entries
 * stay ignored: the check then reports "not found", which only falls back to after-spawn.
 */
function withPathEntriesRelativeTo(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const value = env.PATH;
  if (platform === "win32" || value === undefined) return env;
  const entries = value.split(":");
  if (!entries.some((entry) => entry.length > 0 && !path.isAbsolute(entry))) return env;
  return {
    ...env,
    PATH: entries
      .map((entry) =>
        entry.length > 0 && !path.isAbsolute(entry) ? path.resolve(cwd, entry) : entry,
      )
      .join(":"),
  };
}

export type LowerPriorityResult = "lowered" | "unchanged" | "skipped" | "failed";

export interface LowerChildProcessPriorityDeps {
  readonly platform?: NodeJS.Platform;
  readonly getPriority?: (pid?: number) => number;
  readonly setPriority?: (pid: number, priority: number) => void;
  readonly selfPid?: number;
  /** Overrides {@link AGENT_NICE_INCREMENT} (measurement only). */
  readonly increment?: number;
}

/**
 * Lowers a running child: Below Normal on Windows, `server + increment` on POSIX. Never raises
 * a priority, never touches the server itself (`pid <= 1` and the own pid are skipped), never
 * throws.
 */
export function lowerChildProcessPriority(
  pid: number | undefined,
  deps: LowerChildProcessPriorityDeps = {},
): LowerPriorityResult {
  const selfPid = deps.selfPid ?? process.pid;
  // `setPriority(0)` would reprioritize the server, and pid 1 is init.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || pid === selfPid) return "skipped";
  const platform = deps.platform ?? process.platform;
  const getPriority = deps.getPriority ?? os.getPriority;
  const setPriority = deps.setPriority ?? os.setPriority;
  try {
    const target =
      platform === "win32"
        ? WINDOWS_BELOW_NORMAL_PRIORITY
        : Math.min(POSIX_LOWEST_PRIORITY, getPriority() + (deps.increment ?? AGENT_NICE_INCREMENT));
    // Higher values are lower priorities on both platforms (Windows: IDLE 19, BELOW_NORMAL 10).
    if (getPriority(pid) >= target) return "unchanged";
    setPriority(pid, target);
    return "lowered";
  } catch {
    return "failed";
  }
}
