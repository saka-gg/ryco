/**
 * gitProcess - runs one git child process of a cross-node project copy.
 *
 * Every child is the `git` Ryco spawns everywhere (`resolveGitExecutable`: the git behind macOS's
 * xcrun shim, with the shim's environment), gets `NON_INTERACTIVE_GIT_ENV` and a closed stdin, is
 * reported to the step's observer (pid, process group, start time) so a later server can find it
 * after a crash, and is cancelled by interrupting the effect: its process group gets SIGTERM,
 * then SIGKILL after 5 s, and the effect completes only once the child exited. An overall timeout
 * and an optional no-output stall timeout end it the same way; both count only time the event
 * loop was free to run (`@ryco/shared/responsiveDeadline`), so a machine sleep does not expire
 * them. stdout is collected as text (bounded), stderr is redacted, kept as a tail and passed to
 * the observer in whole lines; patch and bundle bytes never pass through here, git reads and
 * writes them by path.
 *
 * @module gitProcess
 */
import { redactGitCredentials } from "@ryco/shared/gitRemoteUrl";
import {
  makeResponsiveIdleDeadline,
  timeoutWhileResponsiveOption,
} from "@ryco/shared/responsiveDeadline";
import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { governChildProcess } from "../processGovernor.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { resolveGitExecutable } from "../vcs/gitExecutable.ts";
import { NON_INTERACTIVE_GIT_ENV } from "../vcs/GitVcsDriver.ts";
import { GitNetworkError } from "./Errors.ts";
import type { ProjectCopyProcessObserver } from "./Services/ProjectCopyProcess.ts";

/** SIGTERM first; a child still alive this long after it gets SIGKILL. */
export const PROJECT_COPY_FORCE_KILL_AFTER = Duration.seconds(5);
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const STDERR_TAIL_CHARS = 16 * 1024;
/** A stderr line longer than this is passed on without waiting for its end. */
const MAX_PENDING_STDERR_CHARS = 64 * 1024;
/** Bound for `detail` and messages built from git's output (`ProjectCopyError.message` cap). */
export const GIT_DETAIL_MAX_CHARS = 2_000;

/**
 * `-c` options that switch git-lfs's filter off for one command: LFS files stay pointers, git-lfs
 * never runs, and a configured but missing git-lfs (`filter.lfs.required=true`, as `git lfs
 * install` writes it) cannot fail the command. `GIT_LFS_SKIP_SMUDGE` alone does not do this: only
 * git-lfs reads it. Export commands that read the working tree use it, so do the import's
 * checkout and patch; the import's `lfs` step brings the large files.
 */
export const GIT_LFS_FILTER_OFF_ARGS: ReadonlyArray<string> = [
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.required=false",
];

/** At most `maxChars` of `text`, trimmed, keeping its end (where git puts the reason). */
export function tailOfText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-(maxChars - 1)).trimStart()}`;
}

export interface ProjectCopyGitInput {
  readonly operation: string;
  readonly cwd: string;
  /** The arguments after `git`. */
  readonly args: ReadonlyArray<string>;
  /** On top of the server's environment and `NON_INTERACTIVE_GIT_ENV`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** May be infinite: a transfer with a stall limit needs no other. */
  readonly timeoutMs: number;
  /** Fails `stalled` after this long without output on stdout or stderr. */
  readonly stallTimeoutMs?: number | undefined;
  /** Bounds the collected stdout (default 1 MiB); `stdoutTruncated` reports a cut. */
  readonly maxOutputBytes?: number | undefined;
  /** `onOutput` receives stderr in whole lines (git ends progress updates with `\r`), redacted. */
  readonly observer?: ProjectCopyProcessObserver | undefined;
}

export interface ProjectCopyGitOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  /** The end of stderr, credential-redacted. */
  readonly stderrTail: string;
}

const describeDuration = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;

const describeCause = (cause: unknown) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause);

/**
 * Runs `git <args>` in `cwd` and returns its exit code with the output; a non-zero exit is a
 * result, not a failure. Fails `GitNetworkError` with reason `timeout`, `stalled` or `internal`
 * (git could not start, or its output could not be read).
 */
export const runProjectCopyGit = Effect.fn("runProjectCopyGit")(function* (
  input: ProjectCopyGitInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const failure = (reason: GitNetworkError["reason"], detail: string) =>
    new GitNetworkError({
      operation: input.operation,
      reason,
      detail: tailOfText(redactGitCredentials(detail), GIT_DETAIL_MAX_CHARS) || reason,
      host: null,
      exitCode: null,
    });

  // Started over by every chunk of output; never expires without a stall limit.
  const quiet = yield* makeResponsiveIdleDeadline(input.stallTimeoutMs ?? Number.POSITIVE_INFINITY);
  let stderrTail = "";
  let pendingStderr = "";
  let reportedChild = false;

  const emitStderr = (text: string): Effect.Effect<void> => {
    if (text.length === 0) return Effect.void;
    const redacted = redactGitCredentials(text);
    stderrTail = (stderrTail + redacted).slice(-STDERR_TAIL_CHARS);
    return input.observer?.onOutput?.(redacted) ?? Effect.void;
  };

  const onStderrText = (text: string): Effect.Effect<void> => {
    quiet.touch();
    pendingStderr += text;
    const cut = Math.max(pendingStderr.lastIndexOf("\n"), pendingStderr.lastIndexOf("\r"));
    if (cut === -1 && pendingStderr.length < MAX_PENDING_STDERR_CHARS) return Effect.void;
    const end = cut === -1 ? pendingStderr.length : cut + 1;
    const complete = pendingStderr.slice(0, end);
    pendingStderr = pendingStderr.slice(end);
    return emitStderr(complete);
  };

  const stallWatch = (stallTimeoutMs: number): Effect.Effect<never, GitNetworkError> =>
    quiet.expired.pipe(
      Effect.andThen(
        Effect.fail(
          failure("stalled", `git printed nothing for ${describeDuration(stallTimeoutMs)}.`),
        ),
      ),
    );

  const runChild = Effect.gen(function* () {
    const env = { ...process.env, ...NON_INTERACTIVE_GIT_ENV, ...input.env };
    const git = yield* Effect.promise(() => resolveGitExecutable(env));
    const child = yield* spawner
      .spawn(
        ChildProcess.make(git.command, [...input.args], {
          cwd: input.cwd,
          env: { ...env, ...git.env },
          stdin: "ignore",
          forceKillAfter: PROJECT_COPY_FORCE_KILL_AFTER,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          failure("internal", `git could not start: ${describeCause(cause)}`),
        ),
      );
    quiet.touch();
    if (input.observer?.onChild) {
      reportedChild = true;
      yield* input.observer.onChild({
        pid: child.pid,
        // Spawned detached on POSIX, so the child leads its own process group.
        pgid: process.platform === "win32" ? null : child.pid,
        startedAt: new Date().toISOString(),
      });
    }

    const readFailure = (stream: string) => (cause: unknown) =>
      failure("internal", `git's ${stream} could not be read: ${describeCause(cause)}`);
    const work = Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout.pipe(Stream.tap(() => Effect.sync(quiet.touch))),
          maxBytes: maxOutputBytes,
        }).pipe(Effect.mapError(readFailure("stdout"))),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach(onStderrText),
          Effect.andThen(
            Effect.suspend(() => {
              const rest = pendingStderr;
              pendingStderr = "";
              return emitStderr(rest);
            }),
          ),
          Effect.mapError(readFailure("stderr")),
        ),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            failure("internal", `git ended abnormally: ${describeCause(cause)}`),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const [stdout, , exitCode] = yield* input.stallTimeoutMs === undefined
      ? work
      : Effect.raceFirst(work, stallWatch(input.stallTimeoutMs));
    return {
      exitCode,
      stdout: stdout.text,
      stdoutTruncated: stdout.truncated,
      stderrTail,
    } satisfies ProjectCopyGitOutput;
  });

  return yield* governChildProcess(
    "git",
    // Scope close (completion, timeout, stall, interruption) kills the group and waits for it.
    runChild.pipe(Effect.scoped, timeoutWhileResponsiveOption(Duration.millis(input.timeoutMs))),
  ).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            failure("timeout", `git did not finish within ${describeDuration(input.timeoutMs)}.`),
          ),
      }),
    ),
    Effect.ensuring(
      Effect.suspend(() =>
        reportedChild && input.observer?.onChild ? input.observer.onChild(null) : Effect.void,
      ),
    ),
  );
});
