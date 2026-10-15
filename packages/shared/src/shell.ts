import * as OS from "node:os";
import { execFileSync } from "node:child_process";
import { accessSync, constants, promises as fsPromises, statSync } from "node:fs";
import { extname, join } from "node:path";

const PATH_CAPTURE_START = "__RYCO_PATH_START__";
const PATH_CAPTURE_END = "__RYCO_PATH_END__";
const SHELL_ENV_NAME_PATTERN = /^[A-Z0-9_]+$/;
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

export type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) => string;

export interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(OS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START);
  if (startIndex === -1) return null;

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length;
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex);
  if (endIndex === -1) return null;

  const pathValue = output.slice(valueStartIndex, endIndex).trim();
  return pathValue.length > 0 ? pathValue : null;
}

export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  return readEnvironmentFromLoginShell(shell, ["PATH"], execFile).PATH;
}

/** The macOS launchd PATH probe, shared by the sync and async readers. */
export const LAUNCHCTL_PATH_COMMAND = {
  file: "/bin/launchctl",
  args: ["getenv", "PATH"],
} as const;

export function parseLaunchctlPathOutput(output: string): string | undefined {
  return trimNonEmpty(output);
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync,
): string | undefined {
  try {
    return parseLaunchctlPathOutput(
      execFile(LAUNCHCTL_PATH_COMMAND.file, LAUNCHCTL_PATH_COMMAND.args, {
        encoding: "utf8",
        timeout: 2000,
      }),
    );
  } catch {
    return undefined;
  }
}

export function mergePathEntries(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of [preferredPath, inheritedPath]) {
    if (!pathValue) continue;
    for (const entry of pathValue.split(delimiter)) {
      const trimmedEntry = entry.trim();
      if (!trimmedEntry || seen.has(trimmedEntry)) {
        continue;
      }
      seen.add(trimmedEntry);
      merged.push(trimmedEntry);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function envCaptureStart(name: string): string {
  return `__RYCO_ENV_${name}_START__`;
}

function envCaptureEnd(name: string): string {
  return `__RYCO_ENV_${name}_END__`;
}

function buildEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return names
    .map((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `printf '%s\\n' '${envCaptureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${envCaptureEnd(name)}'`,
      ].join("; ");
    })
    .join("; ");
}

function buildWindowsEnvironmentCaptureCommand(names: ReadonlyArray<string>): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      if (!SHELL_ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`);
      }

      return [
        `Write-Output '${envCaptureStart(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${envCaptureEnd(name)}'`,
      ];
    }),
  ].join("; ");
}

function extractEnvironmentValue(output: string, name: string): string | undefined {
  const startMarker = envCaptureStart(name);
  const endMarker = envCaptureEnd(name);
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return undefined;

  const valueStartIndex = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, valueStartIndex);
  if (endIndex === -1) return undefined;

  const value = output
    .slice(valueStartIndex, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

  return value.length > 0 ? value : undefined;
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

/** Arguments for an interactive login shell that prints the requested variables. */
export function loginShellEnvironmentArgs(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return ["-ilc", buildEnvironmentCaptureCommand(names)];
}

export function parseLoginShellEnvironmentOutput(
  output: string,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  const output = execFile(shell, loginShellEnvironmentArgs(names), {
    encoding: "utf8",
    timeout: 5000,
  });

  return parseLoginShellEnvironmentOutput(output, names);
};

export type WindowsShellEnvironmentReader = (
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
) => Partial<Record<string, string>>;

export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
): Partial<Record<string, string>>;
export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
  execFile?: ExecFileSyncLike,
): Partial<Record<string, string>>;
export function readEnvironmentFromWindowsShell(
  names: ReadonlyArray<string>,
  optionsOrExecFile?: WindowsEnvironmentProbeOptions | ExecFileSyncLike,
  maybeExecFile?: ExecFileSyncLike,
): Partial<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const options =
    typeof optionsOrExecFile === "function"
      ? ({} satisfies WindowsEnvironmentProbeOptions)
      : (optionsOrExecFile ?? {});
  const execFile: ExecFileSyncLike =
    typeof optionsOrExecFile === "function"
      ? optionsOrExecFile
      : (maybeExecFile ?? (execFileSync as ExecFileSyncLike));
  const args = windowsEnvironmentCaptureArgs(names, options);
  for (const shell of WINDOWS_SHELL_CANDIDATES) {
    try {
      const output = execFile(shell, args, { encoding: "utf8", timeout: 5000 });
      return parseWindowsEnvironmentOutput(output, names);
    } catch {
      continue;
    }
  }

  return {};
}

/** Async executor for {@link readEnvironmentFromWindowsShellAsync}; rejects on failure. */
export type ExecFileAsyncLike = (file: string, args: ReadonlyArray<string>) => Promise<string>;

/**
 * {@link readEnvironmentFromWindowsShell} without blocking the event loop: the same PowerShell
 * candidates and arguments, run through `execFile` (which owns the timeout).
 */
export async function readEnvironmentFromWindowsShellAsync(
  names: ReadonlyArray<string>,
  options: WindowsEnvironmentProbeOptions,
  execFile: ExecFileAsyncLike,
): Promise<Partial<Record<string, string>>> {
  if (names.length === 0) {
    return {};
  }
  const args = windowsEnvironmentCaptureArgs(names, options);
  for (const shell of WINDOWS_SHELL_CANDIDATES) {
    try {
      return parseWindowsEnvironmentOutput(await execFile(shell, args), names);
    } catch {
      continue;
    }
  }
  return {};
}

function windowsEnvironmentCaptureArgs(
  names: ReadonlyArray<string>,
  options: WindowsEnvironmentProbeOptions,
): ReadonlyArray<string> {
  return [
    "-NoLogo",
    ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
    "-NonInteractive",
    "-Command",
    buildWindowsEnvironmentCaptureCommand(names),
  ];
}

function parseWindowsEnvironmentOutput(
  output: string,
  names: ReadonlyArray<string>,
): Partial<Record<string, string>> {
  const environment: Partial<Record<string, string>> = {};
  for (const name of names) {
    const value = extractEnvironmentValue(output, name);
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = stripWrappingQuotes(entry.trim());
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;

      const normalized = normalizePathEntryForComparison(trimmed, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(trimmed);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function hasWindowsExecutableExtension(
  filePath: string,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  const extension = extname(filePath);
  return extension.length > 0 && windowsPathExtensions.includes(extension.toUpperCase());
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return hasWindowsExecutableExtension(filePath, windowsPathExtensions);
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutableFileAsync(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return hasWindowsExecutableExtension(filePath, windowsPathExtensions);
    await fsPromises.access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface CommandSearchLocation {
  /** The PATH entry, or the command itself when it is given as a path. */
  readonly key: string;
  /** Candidate files in lookup order. */
  readonly files: ReadonlyArray<string>;
}

interface CommandSearchPlan {
  readonly platform: NodeJS.Platform;
  readonly windowsPathExtensions: ReadonlyArray<string>;
  /** One location per PATH entry, or a single one for a command given as a path. */
  readonly locations: ReadonlyArray<CommandSearchLocation>;
}

/** Where `command` is looked up, shared by the sync and async resolvers. */
function planCommandSearch(
  command: string,
  options: CommandAvailabilityOptions,
): CommandSearchPlan {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return {
      platform,
      windowsPathExtensions,
      locations: [{ key: command, files: commandCandidates }],
    };
  }

  const pathEntries = resolvePathEnvironmentVariable(env)
    .split(pathDelimiterForPlatform(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);
  return {
    platform,
    windowsPathExtensions,
    locations: pathEntries.map((pathEntry) => ({
      key: pathEntry,
      files: commandCandidates.map((candidate) => join(pathEntry, candidate)),
    })),
  };
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  return resolveCommandPath(command, options) !== null;
}

export function resolveCommandPath(
  command: string,
  options: CommandAvailabilityOptions = {},
): string | null {
  const plan = planCommandSearch(command, options);
  for (const location of plan.locations) {
    for (const filePath of location.files) {
      if (isExecutableFile(filePath, plan.platform, plan.windowsPathExtensions)) {
        return filePath;
      }
    }
  }
  return null;
}

/** Upper bound for checking one PATH entry in {@link resolveCommandPathAsync}. */
export const COMMAND_PATH_ENTRY_TIMEOUT_MS = 1_000;

export interface AsyncCommandResolutionOptions extends CommandAvailabilityOptions {
  /**
   * How long one search location (a PATH entry) may take. A stalled network or
   * File Provider mount counts as "not found there" and the search moves on.
   */
  readonly entryTimeoutMs?: number;
}

function settleWithin<A>(work: Promise<A>, timeoutMs: number, fallback: A): Promise<A> {
  return new Promise<A>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function firstExecutableAsync(
  location: CommandSearchLocation,
  plan: CommandSearchPlan,
): Promise<string | null> {
  for (const filePath of location.files) {
    if (await isExecutableFileAsync(filePath, plan.platform, plan.windowsPathExtensions)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Search locations whose check outlived its bound and has not settled yet. A
 * stuck `stat` holds a libuv threadpool thread until the mount answers, so
 * later lookups skip such a location instead of parking another thread on it
 * (four stuck threads would stall every filesystem call in the process). The
 * location is searched again once its stuck check settles.
 */
const stalledCommandSearchLocations = new Set<string>();
const COMMAND_SEARCH_STALLED = Symbol("command-search-stalled");

/**
 * {@link resolveCommandPath} without blocking the event loop: the same lookup
 * order and Windows PATHEXT handling, with `stat`/`access` on the promise API
 * and each PATH entry bounded by `entryTimeoutMs`. Never rejects.
 */
export async function resolveCommandPathAsync(
  command: string,
  options: AsyncCommandResolutionOptions = {},
): Promise<string | null> {
  const plan = planCommandSearch(command, options);
  const timeoutMs = options.entryTimeoutMs ?? COMMAND_PATH_ENTRY_TIMEOUT_MS;
  for (const location of plan.locations) {
    if (stalledCommandSearchLocations.has(location.key)) continue;
    // Never rejects: each file check catches its own errors.
    const check = firstExecutableAsync(location, plan);
    const found = await settleWithin<string | null | typeof COMMAND_SEARCH_STALLED>(
      check,
      timeoutMs,
      COMMAND_SEARCH_STALLED,
    );
    if (found === COMMAND_SEARCH_STALLED) {
      stalledCommandSearchLocations.add(location.key);
      void check.finally(() => stalledCommandSearchLocations.delete(location.key));
      continue;
    }
    if (found !== null) return found;
  }
  return null;
}

export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData ? [`${localAppData}\\Programs\\nodejs`, `${localAppData}\\Volta\\bin`] : []),
    ...(localAppData ? [`${localAppData}\\pnpm`] : []),
    ...(userProfile ? [`${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`] : []),
  ];
}

export interface WindowsEnvironmentResolverOptions {
  readonly readEnvironment?: WindowsShellEnvironmentReader;
  readonly commandAvailable?: typeof isCommandAvailable;
}

export interface WindowsEnvironmentAsyncResolverOptions {
  readonly readEnvironment: (
    names: ReadonlyArray<string>,
    options: WindowsEnvironmentProbeOptions,
  ) => Promise<Partial<Record<string, string>>>;
  readonly commandAvailable?: (
    command: string,
    options: CommandAvailabilityOptions,
  ) => Promise<boolean>;
}

function mergeWindowsEnv(
  currentEnv: NodeJS.ProcessEnv,
  patch: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...currentEnv };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

type WindowsEnvironmentProbe =
  | {
      readonly kind: "read-environment";
      readonly names: ReadonlyArray<string>;
      readonly options: WindowsEnvironmentProbeOptions;
    }
  | {
      readonly kind: "command-available";
      readonly command: string;
      readonly options: CommandAvailabilityOptions;
    };

/**
 * The Windows resolution steps; drivers answer each probe. A failed environment read answers
 * `{}`.
 */
function* windowsEnvironmentSteps(
  env: NodeJS.ProcessEnv,
): Generator<WindowsEnvironmentProbe, Partial<NodeJS.ProcessEnv>, unknown> {
  const inheritedPath = readEnvPath(env);
  const shellEnvironment = (yield {
    kind: "read-environment",
    names: ["PATH"],
    options: { loadProfile: false },
  }) as Partial<Record<string, string>>;
  const mergedPath = mergePathValues(shellEnvironment.PATH, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(knownCliPath, mergedPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  const nodeAvailable = (yield {
    kind: "command-available",
    command: "node",
    options: { platform: "win32", env: baselineEnv },
  }) as boolean;
  if (nodeAvailable) {
    return baselinePatch;
  }

  const profiledEnvironment = (yield {
    kind: "read-environment",
    names: ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
    options: { loadProfile: true },
  }) as Partial<Record<string, string>>;
  const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
  const profiledPatch: Partial<NodeJS.ProcessEnv> = {
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {}),
    ...(profiledEnvironment.FNM_MULTISHELL_PATH
      ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH }
      : {}),
  };
  return Object.keys(profiledPatch).length > 0
    ? { ...baselinePatch, ...profiledPatch }
    : baselinePatch;
}

export function resolveWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  options: WindowsEnvironmentResolverOptions = {},
): Partial<NodeJS.ProcessEnv> {
  const readEnvironment = options.readEnvironment ?? readEnvironmentFromWindowsShell;
  const commandAvailable = options.commandAvailable ?? isCommandAvailable;
  const steps = windowsEnvironmentSteps(env);
  let next = steps.next();
  while (!next.done) {
    const probe = next.value;
    if (probe.kind === "command-available") {
      next = steps.next(commandAvailable(probe.command, probe.options));
      continue;
    }
    let environment: Partial<Record<string, string>>;
    try {
      environment = readEnvironment(probe.names, probe.options);
    } catch {
      environment = {};
    }
    next = steps.next(environment);
  }
  return next.value;
}

/**
 * {@link resolveWindowsEnvironment} without blocking the event loop: PowerShell runs through the
 * async reader and the `node` check uses {@link resolveCommandPathAsync}. Never rejects.
 */
export async function resolveWindowsEnvironmentAsync(
  env: NodeJS.ProcessEnv,
  options: WindowsEnvironmentAsyncResolverOptions,
): Promise<Partial<NodeJS.ProcessEnv>> {
  const commandAvailable =
    options.commandAvailable ??
    (async (command: string, commandOptions: CommandAvailabilityOptions) =>
      (await resolveCommandPathAsync(command, commandOptions)) !== null);
  const steps = windowsEnvironmentSteps(env);
  let next = steps.next();
  while (!next.done) {
    const probe = next.value;
    if (probe.kind === "command-available") {
      let available = false;
      try {
        available = await commandAvailable(probe.command, probe.options);
      } catch {
        available = false;
      }
      next = steps.next(available);
      continue;
    }
    let environment: Partial<Record<string, string>>;
    try {
      environment = await options.readEnvironment(probe.names, probe.options);
    } catch {
      environment = {};
    }
    next = steps.next(environment);
  }
  return next.value;
}
