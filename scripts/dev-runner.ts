#!/usr/bin/env node

import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isLinkedWorktreeGitDir, parseGitDirPointer } from "@ryco/shared/gitPointer";
import { NetService } from "@ryco/shared/Net";
import { deleteEnv, setEnv } from "@ryco/shared/runtimeEnv";
import {
  Config,
  Data,
  Effect,
  FileSystem,
  Hash,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { ChildProcess } from "effect/process";

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

/** A linked worktree's own Ryco home, `<worktree>/.ryco-dev` (gitignored). */
export const DEV_HOME_DIRECTORY_NAME = ".ryco-dev";

/**
 * Set in every dev task's environment to the checkout whose runner started it.
 * Agents and terminals of a dev server inherit the server's environment; a dev
 * run that finds this variable knows its RYCO_HOME/ports came from another dev
 * server, not from the person who started it (see stripInheritedDevRunnerEnv).
 * Turbo forwards it through turbo.json's globalPassThroughEnv.
 */
export const DEV_RUNNER_ROOT_ENV = "RYCO_DEV_RUNNER_ROOT";

/**
 * Set next to DEV_RUNNER_ROOT_ENV: a JSON object with the value the runner
 * gave each INHERITED_DEV_RUNNER_ENV_KEYS variable. A nested run drops only the
 * variables that still hold that value, so a setting typed in the agent's shell
 * (`RYCO_HOME=/tmp/x bun run dev`) is kept as the person's own.
 */
export const DEV_RUNNER_ENV_ENV = "RYCO_DEV_RUNNER_ENV";

/**
 * Variables a dev runner sets for its tasks. Inherited unchanged from another
 * dev server (marked by DEV_RUNNER_ROOT_ENV), they would pin this run to that
 * server's home and busy ports.
 */
export const INHERITED_DEV_RUNNER_ENV_KEYS = [
  "RYCO_HOME",
  "RYCO_PORT",
  "RYCO_MODE",
  "RYCO_HOST",
  "RYCO_NO_BROWSER",
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "PORT",
  "HOST",
  "RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "RYCO_LOG_WS_EVENTS",
] as const;

/** The runner's own markers, always removed from an inherited environment. */
const DEV_RUNNER_MARKER_KEYS = [DEV_RUNNER_ROOT_ENV, DEV_RUNNER_ENV_ENV] as const;

/**
 * Ports browsers refuse to fetch, so a dev server there is unreachable from the
 * browser (Chrome: ERR_UNSAFE_PORT) though curl reaches it. The full list, so
 * any offset is safe: https://fetch.spec.whatwg.org/#port-blocking
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** The script that seeds a worktree home, relative to the checkout. */
const SEED_SCRIPT_RELATIVE_PATH = ["apps", "server", "scripts", "seed-dev-home.ts"] as const;
/**
 * seed-dev-home.ts exit code for a seed it skipped on purpose (it printed why). The runner must
 * not import server code, so this mirrors that script's SEED_SKIPPED_EXIT_CODE, whose CLI test
 * pins the value.
 */
const SEED_SKIPPED_EXIT_CODE = 3;

export const DEFAULT_RYCO_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".ryco"),
);

/** The main dev home's database, which a new worktree home is seeded from. */
const DEFAULT_SEED_SOURCE = Effect.map(
  Effect.all([DEFAULT_RYCO_HOME, Effect.service(Path.Path)]),
  ([home, path]) => path.join(home, "dev", "state.sqlite"),
);

const MODE_ARGS = {
  dev: ["run", "dev", "--ui=tui", "--filter=@ryco/web", "--filter=ryco-cli", "--parallel"],
  "dev:server": ["run", "dev", "--filter=ryco-cli"],
  "dev:web": ["run", "dev", "--filter=@ryco/web"],
  "dev:desktop": ["run", "dev", "--filter=@ryco/desktop", "--filter=@ryco/web", "--parallel"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.Boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.Port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.Int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.URL(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const DevRunnerConfig = Config.all({
  portOffset: optionalIntegerConfig("RYCO_PORT_OFFSET"),
  devInstance: optionalStringConfig("RYCO_DEV_INSTANCE"),
  seedSource: optionalStringConfig("RYCO_DEV_SEED_SOURCE"),
});

const hashedOffset = (seed: string) => ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  /** A linked worktree's root: its path picks the worktree's preferred ports. */
  readonly worktreeRoot?: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid RYCO_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `RYCO_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return {
        offset: Number(seed),
        source: `numeric RYCO_DEV_INSTANCE=${seed}`,
      };
    }
    return { offset: hashedOffset(seed), source: `hashed RYCO_DEV_INSTANCE=${seed}` };
  }

  if (config.worktreeRoot !== undefined) {
    return { offset: hashedOffset(config.worktreeRoot), source: `worktree ${config.worktreeRoot}` };
  }

  return { offset: 0, source: "default ports" };
}

/**
 * The root of `repoRoot` when it is a linked git worktree (its `.git` is a
 * pointer file into `<common dir>/worktrees/<name>`), else `undefined`: the
 * main checkout (a `.git` directory), a submodule, or no git at all. Reads the
 * files instead of spawning git, so `GIT_DIR` and a missing git change nothing.
 */
export const resolveLinkedWorktreeRoot = Effect.fn("resolveLinkedWorktreeRoot")(function* (
  repoRoot: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitPath = path.join(repoRoot, ".git");
  const info = yield* fs.stat(gitPath).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") {
    return undefined;
  }
  const contents = yield* fs.readFileString(gitPath).pipe(Effect.orElseSucceed(() => ""));
  const pointer = parseGitDirPointer(contents);
  if (pointer === undefined || !isLinkedWorktreeGitDir(pointer)) {
    return undefined;
  }
  // Git writes `commondir` into every linked worktree's git dir, and the git dir sits in
  // `<common dir>/worktrees/`. A submodule checked out at `…/worktrees/<name>` has neither.
  const gitDir = path.resolve(repoRoot, pointer);
  const commonDir = yield* fs.readFileString(path.join(gitDir, "commondir")).pipe(
    Effect.map((value) => value.trim() || undefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (
    commonDir === undefined ||
    path.dirname(gitDir) !== path.join(path.resolve(gitDir, commonDir), "worktrees")
  ) {
    return undefined;
  }
  return yield* fs.realPath(repoRoot).pipe(Effect.orElseSucceed(() => path.resolve(repoRoot)));
});

export type DevHomeSource = "explicit" | "worktree" | "default";

/**
 * Where this run keeps its state. An explicit `--home-dir`/`RYCO_HOME` wins
 * (an empty one is not explicit), then a linked worktree's own `.ryco-dev`.
 * `undefined` means the shared `~/.ryco`, which createDevRunnerEnv fills in.
 */
export const resolveDevHome = Effect.fn("resolveDevHome")(function* (input: {
  readonly explicitHome: string | undefined;
  readonly worktreeRoot: string | undefined;
}): Effect.fn.Return<
  { readonly home: string | undefined; readonly source: DevHomeSource },
  never,
  Path.Path
> {
  const explicitHome = input.explicitHome?.trim();
  if (explicitHome) {
    return { home: explicitHome, source: "explicit" };
  }
  if (input.worktreeRoot !== undefined) {
    const path = yield* Path.Path;
    return { home: path.join(input.worktreeRoot, DEV_HOME_DIRECTORY_NAME), source: "worktree" };
  }
  return { home: undefined, source: "default" };
});

export interface InheritedDevRunnerEnv {
  /** The environment without the inherited dev settings. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The keys removed: inherited settings in INHERITED_DEV_RUNNER_ENV_KEYS order, then the
   * runner's markers. Empty when nothing was inherited.
   */
  readonly stripped: ReadonlyArray<string>;
  /** Settings changed after that dev server handed them out, kept as this run's own. */
  readonly kept: ReadonlyArray<string>;
  /** The checkout whose dev server set them. */
  readonly inheritedFrom: string | undefined;
  /** The RYCO_HOME that server handed out (its own home). */
  readonly inheritedHome: string | undefined;
}

/** DEV_RUNNER_ENV_ENV's record, or `undefined` when it is absent or not a string map. */
function parseHandedOutEnv(
  value: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    return entries.every(([, entry]) => typeof entry === "string")
      ? (Object.fromEntries(entries) as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes the dev settings another dev server passed to this process. A dev
 * server hands its whole environment to its provider agents, so an agent that
 * runs `bun dev` would otherwise read that server's RYCO_HOME, RYCO_PORT and
 * dev URL as explicit overrides: a shared home and busy fixed ports.
 *
 * - Without the DEV_RUNNER_ROOT_ENV marker, everything is the person's own and stays.
 * - With it, a variable is dropped while it still holds the value that runner handed out
 *   (DEV_RUNNER_ENV_ENV). One set or changed since (`RYCO_HOME=/tmp/x bun run dev` in the
 *   agent's shell) is kept. Without a readable record, every listed variable is dropped.
 * - This also applies when the marker names this checkout: a second run of the same checkout
 *   must still pick free ports.
 */
export function stripInheritedDevRunnerEnv(env: NodeJS.ProcessEnv): InheritedDevRunnerEnv {
  const inheritedFrom = env[DEV_RUNNER_ROOT_ENV]?.trim();
  if (!inheritedFrom) {
    return { env, stripped: [], kept: [], inheritedFrom: undefined, inheritedHome: undefined };
  }
  const handedOut = parseHandedOutEnv(env[DEV_RUNNER_ENV_ENV]);
  const output: NodeJS.ProcessEnv = { ...env };
  const stripped: Array<string> = [];
  const kept: Array<string> = [];
  for (const key of INHERITED_DEV_RUNNER_ENV_KEYS) {
    const value = output[key];
    if (value === undefined) continue;
    if (handedOut !== undefined && handedOut[key] !== value) {
      kept.push(key);
      continue;
    }
    delete output[key];
    stripped.push(key);
  }
  for (const key of DEV_RUNNER_MARKER_KEYS) {
    if (output[key] === undefined) continue;
    delete output[key];
    stripped.push(key);
  }
  return {
    env: output,
    stripped,
    kept,
    inheritedFrom,
    inheritedHome:
      (handedOut === undefined ? env.RYCO_HOME : handedOut.RYCO_HOME)?.trim() || undefined,
  };
}

export type DevSeedPlan =
  | {
      readonly action: "seed";
      readonly reason: string;
      readonly source: string;
      readonly stateDir: string;
    }
  | { readonly action: "skip"; readonly reason: string };

/**
 * Whether this run seeds its home from the main dev database. Only a
 * worktree's own home is seeded, only before it has a database, and only for
 * modes that start a server. The caller checks the files.
 */
export function planDevSeed(input: {
  readonly mode: DevMode;
  readonly homeSource: DevHomeSource;
  readonly seed: boolean | undefined;
  readonly source: string;
  readonly sourceExists: boolean;
  readonly stateDir: string;
  readonly targetExists: boolean;
}): DevSeedPlan {
  if (input.mode === "dev:web") {
    return { action: "skip", reason: "dev:web starts no server" };
  }
  if (input.homeSource !== "worktree") {
    return {
      action: "skip",
      reason:
        input.homeSource === "explicit"
          ? "explicit --home-dir/RYCO_HOME homes are never seeded"
          : "the main checkout uses ~/.ryco",
    };
  }
  if (input.seed === false) {
    return { action: "skip", reason: "--no-seed/RYCO_DEV_SEED=0" };
  }
  if (input.targetExists) {
    return { action: "skip", reason: "this home already has a database" };
  }
  if (!input.sourceExists) {
    return { action: "skip", reason: `no database at ${input.source}` };
  }
  return {
    action: "seed",
    reason: `would seed from ${input.source}`,
    source: input.source,
    stateDir: input.stateDir,
  };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_RYCO_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly rycoHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  /** The checkout this runner belongs to, recorded as DEV_RUNNER_ROOT_ENV. */
  readonly repoRoot?: string | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  rycoHome,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
  repoRoot,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(rycoHome);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
    };
    setEnv(output, "RYCO_HOME", resolvedBaseDir);

    if (!isDesktopMode) {
      setEnv(output, "RYCO_PORT", String(serverPort));
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      setEnv(output, "RYCO_PORT", String(serverPort));
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      deleteEnv(output, "RYCO_MODE");
      deleteEnv(output, "RYCO_NO_BROWSER");
      deleteEnv(output, "RYCO_HOST");
    }

    if (!isDesktopMode && host !== undefined) {
      setEnv(output, "RYCO_HOST", host);
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      setEnv(output, "RYCO_NO_BROWSER", noBrowser ? "1" : "0");
    } else if (!isDesktopMode) {
      deleteEnv(output, "RYCO_NO_BROWSER");
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      setEnv(
        output,
        "RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
        autoBootstrapProjectFromCwd ? "1" : "0",
      );
    } else {
      deleteEnv(output, "RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD");
    }

    if (logWebSocketEvents !== undefined) {
      setEnv(output, "RYCO_LOG_WS_EVENTS", logWebSocketEvents ? "1" : "0");
    } else {
      deleteEnv(output, "RYCO_LOG_WS_EVENTS");
    }

    if (mode === "dev") {
      setEnv(output, "RYCO_MODE", "web");
      deleteEnv(output, "RYCO_DESKTOP_WS_URL");
    }

    if (mode === "dev:server" || mode === "dev:web") {
      setEnv(output, "RYCO_MODE", "web");
      deleteEnv(output, "RYCO_DESKTOP_WS_URL");
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      deleteEnv(output, "RYCO_DESKTOP_WS_URL");
    }

    setEnv(output, DEV_RUNNER_ROOT_ENV, repoRoot);
    deleteEnv(output, DEV_RUNNER_ENV_ENV);
    if (repoRoot !== undefined) {
      const handedOut: Record<string, string> = {};
      for (const key of INHERITED_DEV_RUNNER_ENV_KEYS) {
        const value = output[key];
        if (value !== undefined) handedOut[key] = value;
      }
      output[DEV_RUNNER_ENV_ENV] = JSON.stringify(handedOut);
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
      net.canListenOnHost(candidatePort, host),
    );
  });

interface FindFirstAvailableOffsetInput<R = NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      // A browser cannot reach a blocked port, so it never counts as free.
      // (Server ports start above the highest blocked port today.)
      if (
        (requireServerPort && FETCH_BLOCKED_PORTS.has(serverPort)) ||
        (requireWebPort && FETCH_BLOCKED_PORTS.has(webPort))
      ) {
        continue;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly rycoHome: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly seed: boolean | undefined;
  readonly dryRun: boolean;
  readonly turboArgs: ReadonlyArray<string>;
}

export interface DevRunContext<R = NetService> {
  /** The checkout this runner belongs to: its code runs, so its schema is the one that matters. */
  readonly repoRoot: string;
  /** The environment the dev tasks start from (stripInheritedDevRunnerEnv already applied). */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  /** RYCO_DEV_SEED_SOURCE: the database a new worktree home is seeded from. */
  readonly seedSource: string | undefined;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export interface DevRunPlan {
  readonly env: NodeJS.ProcessEnv;
  readonly offset: number;
  readonly source: string;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly worktreeRoot: string | undefined;
  readonly home: string;
  readonly homeSource: DevHomeSource;
  readonly seedPlan: DevSeedPlan;
}

/** Resolves everything a dev run needs (home, ports, env, seed) without starting anything. */
export function planDevRun<R = NetService>(
  input: DevRunnerCliInput,
  context: DevRunContext<R>,
): Effect.Effect<DevRunPlan, DevRunnerError, R | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const worktreeRoot = yield* resolveLinkedWorktreeRoot(context.repoRoot);
    const { offset, source } = yield* Effect.try({
      try: () =>
        resolveOffset({
          portOffset: context.portOffset,
          devInstance: context.devInstance,
          worktreeRoot,
        }),
      catch: (cause) =>
        new DevRunnerError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    const devHome = yield* resolveDevHome({ explicitHome: input.rycoHome, worktreeRoot });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
      ...(context.checkPortAvailability === undefined
        ? {}
        : { checkPortAvailability: context.checkPortAvailability }),
    });

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: context.baseEnv,
      serverOffset,
      webOffset,
      rycoHome: devHome.home,
      noBrowser: input.noBrowser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
      repoRoot: context.repoRoot,
    });
    const home = env.RYCO_HOME ?? (yield* DEFAULT_RYCO_HOME);

    // Every runner mode sets a dev URL, so the server keeps its state in <home>/dev.
    const stateDir = path.join(home, "dev");
    const targetDatabase = path.join(stateDir, "state.sqlite");
    const configuredSeedSource = context.seedSource?.trim();
    const seedSource = configuredSeedSource
      ? path.resolve(configuredSeedSource)
      : yield* DEFAULT_SEED_SOURCE;
    // Existence checks only (no reads), so they run whatever planDevSeed then decides.
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    const targetExists =
      (yield* exists(targetDatabase)) || (yield* exists(`${targetDatabase}-wal`));
    const sourceExists = yield* exists(seedSource);
    const seedPlan = planDevSeed({
      mode: input.mode,
      homeSource: devHome.source,
      seed: input.seed,
      source: seedSource,
      sourceExists,
      stateDir,
      targetExists,
    });

    return {
      env,
      offset,
      source,
      serverOffset,
      webOffset,
      worktreeRoot,
      home,
      homeSource: devHome.source,
      seedPlan,
    } satisfies DevRunPlan;
  });
}

/**
 * Seeds a new worktree home by running apps/server/scripts/seed-dev-home.ts.
 * Never fails: a seed that fails or is skipped leaves an empty home, which the
 * server starts on as before.
 */
const runDevSeed = (
  plan: Extract<DevSeedPlan, { readonly action: "seed" }>,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const script = path.join(repoRoot, ...SEED_SCRIPT_RELATIVE_PATH);
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(
          process.execPath,
          [script, "--source", plan.source, "--state-dir", plan.stateDir],
          {
            cwd: repoRoot,
            stdin: "ignore",
            stdout: "inherit",
            stderr: "inherit",
            env,
            extendEnv: false,
            // In the terminal's process group, so Ctrl+C reaches the seed too.
            detached: false,
            forceKillAfter: "1500 millis",
          },
        );
        return yield* child.exitCode;
      }),
    );
    if (exitCode === 0 || exitCode === SEED_SKIPPED_EXIT_CODE) {
      return;
    }
    yield* Effect.logWarning(
      `[dev-runner] seeding failed (exit ${exitCode}); starting with an empty home. --no-seed or RYCO_DEV_SEED=0 skips it.`,
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        `[dev-runner] seeding failed (${cause instanceof Error ? cause.message : String(cause)}); starting with an empty home. --no-seed or RYCO_DEV_SEED=0 skips it.`,
      ),
    ),
  );

export interface DevRunnerOptions {
  readonly repoRoot: string;
  /** What stripInheritedDevRunnerEnv removed from this process's environment. */
  readonly inherited: InheritedDevRunnerEnv;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput, options: DevRunnerOptions) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* DevRunnerConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerError({
            message:
              "Failed to read RYCO_PORT_OFFSET/RYCO_DEV_INSTANCE/RYCO_DEV_SEED_SOURCE configuration.",
            cause,
          }),
      ),
    );

    const plan = yield* planDevRun(input, {
      repoRoot: options.repoRoot,
      baseEnv: options.inherited.env,
      portOffset: config.portOffset,
      devInstance: config.devInstance,
      seedSource: config.seedSource,
    });
    const { env, offset, source, serverOffset, webOffset } = plan;

    const { inherited } = options;
    if (inherited.stripped.length > 0) {
      const keptSuffix =
        inherited.kept.length > 0
          ? `; keeping ${inherited.kept.join(", ")}, set after that server handed it out`
          : "";
      yield* Effect.logWarning(
        `[dev-runner] ignoring dev settings inherited from the dev server at ${String(inherited.inheritedFrom)}: ${inherited.stripped.join(", ")}${keptSuffix}`,
      );
      if (
        inherited.inheritedHome !== undefined &&
        path.resolve(inherited.inheritedHome) === path.resolve(plan.home)
      ) {
        yield* Effect.logWarning(
          `[dev-runner] that dev server keeps its state in this run's home too (${plan.home}); pass --home-dir <dir> to keep this run apart from it.`,
        );
      }
    }

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.RYCO_PORT)} webPort=${String(env.PORT)} home=${plan.home} (${plan.homeSource})`,
    );
    if (plan.worktreeRoot !== undefined && plan.homeSource === "explicit") {
      yield* Effect.logInfo(
        `[dev-runner] RYCO_HOME/--home-dir overrides this worktree's own home ${path.join(plan.worktreeRoot, DEV_HOME_DIRECTORY_NAME)}`,
      );
    }

    if (input.dryRun) {
      yield* Effect.logInfo(
        plan.seedPlan.action === "seed"
          ? `[dev-runner] seed: ${plan.seedPlan.reason}`
          : `[dev-runner] seed: skipped (${plan.seedPlan.reason})`,
      );
      return;
    }

    if (plan.seedPlan.action === "seed") {
      yield* runDevSeed(plan.seedPlan, options.repoRoot, env);
    }

    const child = yield* ChildProcess.make(
      "turbo",
      [...MODE_ARGS[input.mode], ...input.turboArgs],
      {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: false,
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
        // Keep turbo in the same process group so terminal signals (Ctrl+C)
        // reach it directly. Effect defaults to detached: true on non-Windows,
        // which would put turbo in a new group and require manual forwarding.
        detached: false,
        forceKillAfter: "1500 millis",
      },
    );

    const exitCode = yield* child.exitCode;
    if (exitCode !== 0) {
      return yield* new DevRunnerError({
        message: `turbo exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevRunnerError
        ? cause
        : new DevRunnerError({
            message: cause instanceof Error ? cause.message : "dev-runner failed",
            cause,
          }),
    ),
  );
}

const makeDevRunnerCli = (options: DevRunnerOptions) =>
  Command.make("dev-runner", {
    mode: Argument.Literals("mode", DEV_RUNNER_MODES).pipe(
      Argument.withDescription("Development mode to run."),
    ),
    rycoHome: Flag.String("home-dir").pipe(
      Flag.withDescription(
        "Base directory for all Ryco data (equivalent to RYCO_HOME). Defaults to <worktree>/.ryco-dev in a linked git worktree, else ~/.ryco.",
      ),
      Flag.withFallbackConfig(optionalStringConfig("RYCO_HOME")),
    ),
    noBrowser: Flag.Boolean("no-browser").pipe(
      Flag.withDescription("Browser auto-open toggle (equivalent to RYCO_NO_BROWSER)."),
      Flag.withFallbackConfig(optionalBooleanConfig("RYCO_NO_BROWSER")),
    ),
    autoBootstrapProjectFromCwd: Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
      Flag.withDescription(
        "Auto-bootstrap toggle (equivalent to RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
      ),
      Flag.withFallbackConfig(optionalBooleanConfig("RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
    ),
    logWebSocketEvents: Flag.Boolean("log-websocket-events").pipe(
      Flag.withDescription("WebSocket event logging toggle (equivalent to RYCO_LOG_WS_EVENTS)."),
      Flag.withAlias("log-ws-events"),
      Flag.withFallbackConfig(optionalBooleanConfig("RYCO_LOG_WS_EVENTS")),
    ),
    host: Flag.String("host").pipe(
      Flag.withDescription("Server host/interface override (forwards to RYCO_HOST)."),
      Flag.withFallbackConfig(optionalStringConfig("RYCO_HOST")),
    ),
    port: Flag.Int("port").pipe(
      Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
      Flag.withDescription("Server port override (forwards to RYCO_PORT)."),
      Flag.withFallbackConfig(optionalPortConfig("RYCO_PORT")),
    ),
    devUrl: Flag.String("dev-url").pipe(
      Flag.withSchema(Schema.URLFromString),
      Flag.withDescription("Web dev URL override (forwards to VITE_DEV_SERVER_URL)."),
      Flag.withFallbackConfig(optionalUrlConfig("VITE_DEV_SERVER_URL")),
    ),
    seed: Flag.Boolean("seed").pipe(
      Flag.withDescription(
        "Seed a new worktree home from a pruned copy of ~/.ryco/dev/state.sqlite (or RYCO_DEV_SEED_SOURCE) on its first start. On by default; --no-seed or RYCO_DEV_SEED=0 starts empty.",
      ),
      Flag.withFallbackConfig(optionalBooleanConfig("RYCO_DEV_SEED")),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Resolve mode/ports/env and print, but do not spawn turbo."),
      Flag.withDefault(false),
    ),
    turboArgs: Argument.String("turbo-arg").pipe(
      Argument.withDescription("Additional turbo args (pass after `--`)."),
      Argument.variadic(),
    ),
  }).pipe(
    Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
    Command.withHandler((input) => runDevRunnerWithInput(input, options)),
  );

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  // The runner always lives at <checkout>/scripts/.
  const repoRoot = NodePath.resolve(import.meta.dirname, "..");
  // Before the CLI parses: its flags fall back to these variables.
  const inherited = stripInheritedDevRunnerEnv(process.env);
  for (const key of inherited.stripped) {
    deleteEnv(process.env, key);
  }
  Command.run(makeDevRunnerCli({ repoRoot, inherited }), { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
