/**
 * nodeUpdate/processes - The child processes a node update runs: the package manager
 * install, the check of the installed release, and the service manager restart.
 *
 * Every command is bounded by its timeout and keeps only the tail of its output, which
 * is what explains a failed install. The restart is handed to launchd or systemd in a
 * detached process, because it ends this one.
 *
 * @module nodeUpdate/processes
 */
import { spawn } from "node:child_process";

import type { NodeServiceManager } from "@ryco/contracts";
import { Duration, Effect, Option } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import { systemdUnitName } from "../service/nodeService.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import type { NodeUpdateCommand } from "./installation.ts";

/** The contract's bound on `run.output`. */
export const NODE_UPDATE_OUTPUT_MAX_CHARS = 10_000;

export interface NodeUpdateCommandResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Set when the command could not be started at all. */
  readonly spawnError: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type NodeUpdateCommandRunner = (
  command: NodeUpdateCommand,
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
  (command) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, [...command.args], { stdin: "ignore" }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
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
