/**
 * ProjectSetupCommandLive - runs an import's setup command in the new project's root.
 *
 * The command goes through the user's shell as the terminal manager resolves it, started
 * non-interactively (`$SHELL -l -c`; PowerShell or `cmd.exe` on Windows), falling back to the
 * next shell only when one cannot be found. stdin is `/dev/null`, so a prompt reads end of input
 * instead of waiting. The child leads its own process group: a timeout or an interrupted run
 * signals the whole group (SIGTERM, SIGKILL after 5 s) and completes once it is gone, and
 * whatever the command left running in the background is ended with it.
 *
 * @module ProjectSetupCommandLive
 */
import {
  PROJECT_COPY_SETUP_COMMAND_MAX_CHARS,
  PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES,
} from "@ryco/contracts/project-copy";
import { projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import { Clock, Duration, Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { TerminalOutputTail } from "../../project/worktreeSetupOutputTail.ts";
import { utf8ByteLength } from "../../terminal/historyBuffer.ts";
import { createTerminalSpawnEnv } from "../../terminal/terminalSpawnEnv.ts";
import {
  defaultShellResolver,
  formatShellCandidate,
  nonInteractiveShellCommand,
  resolveShellCandidates,
  type ShellCandidate,
} from "../../terminal/terminalShell.ts";
import { ProjectSetupCommandError } from "../Errors.ts";
import type { ProjectCopyChildProcess } from "../Services/ProjectCopyProcess.ts";
import {
  ProjectSetupCommand,
  type ProjectSetupCommandResult,
  type ProjectSetupCommandShape,
} from "../Services/ProjectSetupCommand.ts";

export const PROJECT_SETUP_COMMAND_DEFAULT_TIMEOUT_MS = 30 * 60_000;
/** Lines of the result's `outputTail`. */
export const PROJECT_SETUP_OUTPUT_TAIL_LINES = 40;
/** The result's `outputTail` takes at most half the snapshot's, which also shows clone progress. */
export const PROJECT_SETUP_OUTPUT_TAIL_MAX_BYTES = PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES / 2;
const DEFAULT_FORCE_KILL_AFTER_MS = 5_000;
/**
 * After the shell exits, how long output still in the pipes may take to arrive. A background
 * process that keeps the pipes open is not waited for: the group is ended after this.
 */
const OUTPUT_DRAIN_GRACE_MS = 2_000;

export interface ProjectSetupCommandOptions {
  /** The server environment the command's is derived from; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The shell to try first; default `$SHELL` (`pwsh.exe` on Windows), as terminals do. */
  readonly shellResolver?: (() => string) | undefined;
  /** SIGTERM to SIGKILL; default 5 s. */
  readonly forceKillAfterMs?: number | undefined;
}

/** The last lines, dropping whole lines from the head until they fit the byte budget. */
function boundedOutputTail(lines: ReadonlyArray<string>): string {
  let start = 0;
  let bytes = lines.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0) - 1;
  while (bytes > PROJECT_SETUP_OUTPUT_TAIL_MAX_BYTES && start < lines.length) {
    bytes -= utf8ByteLength(lines[start]!) + 1;
    start += 1;
  }
  return lines.slice(start).join("\n");
}

/** The shell itself is missing or not executable: the next candidate may work. */
function isUnstartableShell(error: PlatformError.PlatformError): boolean {
  const reason = error.reason;
  return (
    reason.method === "spawn" && (reason._tag === "NotFound" || reason._tag === "PermissionDenied")
  );
}

export const makeProjectSetupCommand = Effect.fn("makeProjectSetupCommand")(function* (
  options: ProjectSetupCommandOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = process.platform;
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const forceKillAfter = Duration.millis(options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS);

  const assertProjectRoot = (projectRoot: string) =>
    fileSystem.stat(projectRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupCommandError({
            reason: "cwd-missing",
            message: `The project folder ${projectRoot} is not available: ${cause.message}`,
          }),
      ),
      Effect.flatMap((info) =>
        info.type === "Directory"
          ? Effect.void
          : Effect.fail(
              new ProjectSetupCommandError({
                reason: "cwd-missing",
                message: `The project folder ${projectRoot} is not a directory.`,
              }),
            ),
      ),
    );

  /** Starts the first shell that exists. Needs the scope the child lives in. */
  const spawnInFirstShell = Effect.fnUntraced(function* (
    candidates: ReadonlyArray<ShellCandidate>,
    commandLine: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    let lastError: PlatformError.PlatformError | null = null;
    for (const candidate of candidates) {
      const invocation = nonInteractiveShellCommand(candidate, commandLine, platform);
      const attempt = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make(invocation.command, [...invocation.args], {
            cwd,
            env,
            ...(invocation.shell !== undefined ? { shell: invocation.shell } : {}),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter,
          }),
        ),
      );
      if (attempt._tag === "Success") return attempt.success;
      if (!isUnstartableShell(attempt.failure)) {
        return yield* new ProjectSetupCommandError({
          reason: "spawn-failed",
          message: `The setup command could not start: ${attempt.failure.message}`,
        });
      }
      lastError = attempt.failure;
    }
    const tried = candidates.map(formatShellCandidate).join(", ");
    return yield* new ProjectSetupCommandError({
      reason: "spawn-failed",
      message: `The setup command could not start: no usable shell (tried ${tried})${
        lastError ? `: ${lastError.message}` : ""
      }.`,
    });
  });

  const run: ProjectSetupCommandShape["run"] = Effect.fn("ProjectSetupCommand.run")(
    function* (input) {
      if (
        input.command.trim().length === 0 ||
        input.command.length > PROJECT_COPY_SETUP_COMMAND_MAX_CHARS
      ) {
        return yield* new ProjectSetupCommandError({
          reason: "internal",
          message: `The setup command must have 1 to ${PROJECT_COPY_SETUP_COMMAND_MAX_CHARS} characters.`,
        });
      }
      yield* assertProjectRoot(input.projectRoot);

      const env = createTerminalSpawnEnv(
        baseEnv,
        projectScriptRuntimeEnv({
          project: { cwd: input.projectRoot },
          worktreePath: input.projectRoot,
        }),
      );
      const candidates = resolveShellCandidates(shellResolver, platform, baseEnv);
      const timeout = Duration.millis(input.timeoutMs ?? PROJECT_SETUP_COMMAND_DEFAULT_TIMEOUT_MS);
      const onChild = input.observer?.onChild;
      const onOutput = input.observer?.onOutput;
      const tail = new TerminalOutputTail(PROJECT_SETUP_OUTPUT_TAIL_LINES);
      let reportedChild = false;

      const execute = Effect.gen(function* () {
        const child = yield* spawnInFirstShell(candidates, input.command, input.projectRoot, env);
        const childProcess: ProjectCopyChildProcess = {
          pid: child.pid,
          pgid: platform === "win32" ? null : child.pid,
          startedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        };
        if (onChild) {
          reportedChild = true;
          yield* onChild(childProcess);
        }

        // Each stream is decoded on its own so a character split across chunks stays whole.
        const output = yield* Stream.merge(
          child.stdout.pipe(Stream.decodeText()),
          child.stderr.pipe(Stream.decodeText()),
        ).pipe(
          Stream.runForEach((chunk) => {
            tail.append(chunk);
            return onOutput ? onOutput(chunk) : Effect.void;
          }),
          Effect.ignore,
          Effect.forkScoped,
        );

        // `exitCode` fails only for a child ended by a signal, which has no exit code.
        const exited = yield* child.exitCode.pipe(
          Effect.map((code): number | null => Number(code)),
          Effect.orElseSucceed(() => null),
          Effect.timeoutOption(timeout),
        );
        if (Option.isNone(exited)) {
          yield* Effect.ignore(child.kill({ killSignal: "SIGTERM", forceKillAfter }));
        }
        yield* Effect.timeoutOption(Fiber.join(output), Duration.millis(OUTPUT_DRAIN_GRACE_MS));

        const outputTail = boundedOutputTail(tail.snapshot());
        const result: ProjectSetupCommandResult = Option.isNone(exited)
          ? { outcome: "timed-out", exitCode: null, outputTail }
          : {
              outcome: exited.value === 0 ? "succeeded" : "failed",
              exitCode: exited.value,
              outputTail,
            };
        return result;
      });

      // Closing the scope ends the process group and waits for it, also when interrupted;
      // only then is the child reported gone.
      return yield* Effect.scoped(execute).pipe(
        Effect.ensuring(
          Effect.suspend(() => (reportedChild && onChild ? onChild(null) : Effect.void)),
        ),
      );
    },
  );

  return ProjectSetupCommand.of({ run });
});

export const ProjectSetupCommandLive = Layer.effect(ProjectSetupCommand, makeProjectSetupCommand());
