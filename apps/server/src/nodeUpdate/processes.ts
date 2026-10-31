/**
 * nodeUpdate/processes - The child processes a node update runs: the package manager
 * install, the check of the installed release, and the service manager restart.
 *
 * Every command is bounded by its timeout and keeps only the tail of its output, which
 * is what explains a failed install. The restart is handed to launchd or systemd in a
 * detached process, because it ends this one. Loaded with the first update.
 *
 * @module nodeUpdate/processes
 */
import { spawn } from "node:child_process";

import type { NodeServiceManager } from "@ryco/contracts";
import { Duration, Effect, Option } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { systemdUnitName } from "../service/nodeService.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { type DetectedNodeInstallation, RYCO_CLI_PACKAGE } from "./installation.ts";
import {
  NODE_UPDATE_OUTPUT_MAX_CHARS,
  NODE_UPDATE_PREFLIGHT_ARG,
  NODE_UPDATE_PREFLIGHT_DATABASE_FLAG,
} from "./updateProtocol.ts";

export { NODE_UPDATE_OUTPUT_MAX_CHARS };

export interface NodeUpdateCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Input;
}

export const NODE_INSTALL_TIMEOUT = Duration.minutes(10);
export const NODE_VERIFY_TIMEOUT = Duration.seconds(60);

/**
 * What an install nobody asked for leaves out: dependency releases published less than the
 * minimum release age ago. The `ryco-cli` release itself is that old already (the updater checks
 * it); its dependencies resolve at install time, install scripts included, so they are held back
 * too: npm takes nothing published after `publishedBeforeMs` (`--before`), pnpm 10.16+ nothing
 * younger than `minimumReleaseAgeMinutes` (`minimumReleaseAge`). bun installs without either, so
 * an unattended update never runs with bun.
 */
export interface NodeInstallHoldBack {
  readonly publishedBeforeMs: number;
  readonly minimumReleaseAgeMinutes: number;
}

export const nodeInstallHoldBack = (
  nowMs: number,
  minimumReleaseAge: Duration.Input,
): NodeInstallHoldBack => {
  const ageMs = Duration.toMillis(minimumReleaseAge);
  return {
    publishedBeforeMs: nowMs - ageMs,
    minimumReleaseAgeMinutes: Math.ceil(ageMs / 60_000),
  };
};

/** pnpm reads `minimumReleaseAge` from 10.16 on; older releases ignore it. */
export const PNPM_MINIMUM_RELEASE_AGE_RANGE = ">=10.16.0";

/**
 * Installs exactly `version` into the installation this process runs from: npm into its
 * own prefix (not whichever `npm` the PATH finds first), bun with the running bun. With
 * `holdBack` (an unattended update), recent dependency releases stay out; `null` for bun then.
 */
export function nodeInstallCommand(
  installation: DetectedNodeInstallation,
  version: string,
  execPath: string,
  holdBack?: NodeInstallHoldBack,
): NodeUpdateCommand | null {
  const target = `${RYCO_CLI_PACKAGE}@${version}`;
  switch (installation.kind) {
    case "npm-global":
      return installation.npmPrefix === null
        ? null
        : {
            command: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installation.npmPrefix,
              ...(holdBack === undefined
                ? []
                : [`--before=${new Date(holdBack.publishedBeforeMs).toISOString()}`]),
              target,
            ],
            timeout: NODE_INSTALL_TIMEOUT,
          };
    case "bun-global": {
      if (holdBack !== undefined) return null;
      const runtime = execPath.split(/[\\/]/u).at(-1) ?? "";
      return {
        command: /^bun(?:\.exe)?$/iu.test(runtime) ? execPath : "bun",
        args: ["add", "-g", target],
        timeout: NODE_INSTALL_TIMEOUT,
      };
    }
    case "pnpm-global":
      return {
        command: "pnpm",
        args: [
          "add",
          "-g",
          ...(holdBack === undefined
            ? []
            : [`--config.minimumReleaseAge=${holdBack.minimumReleaseAgeMinutes}`]),
          target,
        ],
        timeout: NODE_INSTALL_TIMEOUT,
      };
    default:
      return null;
  }
}

/**
 * Runs the installed entry script once; it must report the release that was installed. Only
 * for a release that predates the preflight ({@link nodePreflightCommand}).
 */
export function nodeVerifyCommand(
  installation: DetectedNodeInstallation,
  execPath: string,
): NodeUpdateCommand | null {
  return installation.entryScript === null
    ? null
    : {
        command: execPath,
        args: [installation.entryScript, "--version"],
        timeout: NODE_VERIFY_TIMEOUT,
      };
}

/** Migrating a copy of a large database can take minutes. */
export const NODE_PREFLIGHT_TIMEOUT = Duration.minutes(10);

/**
 * Runs the installed release's preflight (preflight.ts) against `databaseCopy`: it loads
 * its whole server graph, native modules included, and migrates the copy, without listening or
 * touching this node's own state.
 */
export function nodePreflightCommand(
  installation: DetectedNodeInstallation,
  execPath: string,
  databaseCopy: string,
): NodeUpdateCommand | null {
  return installation.entryScript === null
    ? null
    : {
        command: execPath,
        args: [
          installation.entryScript,
          NODE_UPDATE_PREFLIGHT_ARG,
          NODE_UPDATE_PREFLIGHT_DATABASE_FLAG,
          databaseCopy,
        ],
        timeout: NODE_PREFLIGHT_TIMEOUT,
      };
}

/** `command` as the boot guard runs it during a rollback (bootGuard.ts). */
export const recordNodeUpdateCommand = (command: NodeUpdateCommand) => ({
  command: command.command,
  args: [...command.args],
  timeoutMs: Math.max(1, Math.round(Duration.toMillis(command.timeout))),
});

export interface NodeUpdateCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Set when the command could not be started at all. */
  readonly spawnError: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `command`. `onSpawned` gets the child's pid once it runs (an installer records it with its
 * install lock); when it fails, the child is stopped and the result is a spawn error.
 */
export type NodeUpdateCommandRunner = (
  command: NodeUpdateCommand,
  onSpawned?: (pid: number) => Effect.Effect<void, Error>,
) => Effect.Effect<NodeUpdateCommandResult>;

export const commandSucceeded = (result: NodeUpdateCommandResult) =>
  result.exitCode === 0 && !result.timedOut && result.spawnError === null;

/** The last {@link NODE_UPDATE_OUTPUT_MAX_CHARS} characters of what the command printed. */
export function commandOutputTail(result: NodeUpdateCommandResult): string | null {
  const output = [result.stdout.trim(), result.stderr.trim(), result.spawnError ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  if (output.length === 0) return null;
  return output.length <= NODE_UPDATE_OUTPUT_MAX_CHARS
    ? output
    : output.slice(output.length - NODE_UPDATE_OUTPUT_MAX_CHARS);
}

/** Why a command failed, in one sentence that names `what` it was doing. */
export function describeCommandFailure(
  command: NodeUpdateCommand,
  result: NodeUpdateCommandResult,
  what: string,
): string {
  const name = command.command.split(/[\\/]/u).at(-1) ?? command.command;
  if (result.spawnError !== null) return `Could not run ${name} while ${what}.`;
  if (result.timedOut) return `${name} timed out while ${what}.`;
  return `${name} exited with code ${result.exitCode ?? "unknown"} while ${what}.`;
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, "gu");

/** Whether `ryco --version` output names exactly `version` (as `0.1.2` or `v0.1.2`). */
export function outputReportsVersion(output: string, version: string): boolean {
  return output
    .replace(ANSI_ESCAPE_PATTERN, "")
    .split(/\s+/u)
    .some((token) => token.replace(/^v/u, "") === version);
}

const textTail = (stream: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
  collectUint8StreamText({ stream, maxBytes: NODE_UPDATE_OUTPUT_MAX_CHARS, keepTail: true });

/** Runs commands through the platform spawner; never fails, every failure is in the result. */
export const makeNodeUpdateCommandRunner =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): NodeUpdateCommandRunner =>
  (command, onSpawned) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, [...command.args], { stdin: "ignore" }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      if (onSpawned !== undefined) yield* onSpawned(child.pid);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [textTail(child.stdout), textTail(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        timedOut: false,
        spawnError: null,
        stdout: stdout.text,
        stderr: stderr.text,
      } satisfies NodeUpdateCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(command.timeout),
      Effect.map(
        Option.getOrElse((): NodeUpdateCommandResult => ({
          exitCode: null,
          timedOut: true,
          spawnError: null,
          stdout: "",
          stderr: "",
        })),
      ),
      Effect.catch((cause) =>
        Effect.succeed<NodeUpdateCommandResult>({
          exitCode: null,
          timedOut: false,
          spawnError: cause.message,
          stdout: "",
          stderr: "",
        }),
      ),
    );

export interface NodeServiceRestartTarget {
  readonly manager: NodeServiceManager;
  readonly label: string;
}

export type NodeServiceRestart = (target: NodeServiceRestartTarget) => Effect.Effect<void>;

/** The service manager command that restarts the `ryco service` job `target`. */
export function serviceRestartCommand(
  target: NodeServiceRestartTarget,
  uid: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return target.manager === "launchd"
    ? { command: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${target.label}`] }
    : {
        command: "systemctl",
        args: ["--user", "--no-block", "restart", systemdUnitName(target.label)],
      };
}

const RESTART_HANDOFF_TIMEOUT = Duration.seconds(15);

/**
 * Hands the restart to the service manager. The command runs detached in its own
 * process group, so it outlives this process when launchd or systemd stops it. When it
 * cannot run or refuses, this process ends itself instead; the service definition's
 * KeepAlive / Restart=always starts it again.
 */
export const restartThroughServiceManager: NodeServiceRestart = (target) =>
  Effect.callback<void>((resume) => {
    let settled = false;
    const settle = (handedOff: boolean) => {
      if (settled) return;
      settled = true;
      if (!handedOff) process.kill(process.pid, "SIGTERM");
      resume(Effect.void);
    };
    const { command, args } = serviceRestartCommand(target, process.getuid?.() ?? 0);
    try {
      const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
      child.once("error", () => settle(false));
      child.once("exit", (code) => settle(code === 0));
      child.unref();
    } catch {
      settle(false);
    }
  }).pipe(
    // `kickstart -k` usually ends this process before it exits itself.
    Effect.timeoutOption(RESTART_HANDOFF_TIMEOUT),
    Effect.asVoid,
  );
