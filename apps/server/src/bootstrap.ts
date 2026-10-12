import * as NFS from "node:fs";
import * as Net from "node:net";
import * as readline from "node:readline";
import type { Readable } from "node:stream";

import { Data, Effect, Option, Predicate, Result, Schema } from "effect";
import { decodeJsonResult } from "@ryco/shared/schemaJson";
import { applyShellEnvironment, pickShellEnvironment } from "@ryco/shared/shellEnvironment";

class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A bootstrap fd was passed explicitly but delivered no envelope: the pipe
 * closed, the fd does not exist, or nothing arrived within the timeout. The
 * process that started this server is gone or stalled, so booting on defaults
 * would only leave an orphan on a default port. Startup exits with EX_CONFIG.
 */
export class BootstrapEnvelopeUnavailableError extends Data.TaggedError(
  "BootstrapEnvelopeUnavailableError",
)<{
  readonly fd: number;
  readonly message: string;
}> {}

/**
 * Merge a login-shell environment delivered in the bootstrap envelope into
 * `env` (PATH entries first, other variables only fill gaps). Unknown names
 * and empty values are ignored. Must run before any layer spawns a process.
 */
export function applyBootstrapShellEnvironment(
  shellEnvironment: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (shellEnvironment === undefined) return;
  applyShellEnvironment(env, pickShellEnvironment(shellEnvironment), platform);
}

export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* <A, I>(
  schema: Schema.Codec<A, I>,
  fd: number,
  options?: {
    timeoutMs?: number;
  },
): Effect.fn.Return<Option.Option<A>, BootstrapError> {
  const fdReady = yield* isFdReady(fd);
  if (!fdReady) return Option.none();

  const stream = yield* makeBootstrapInputStream(fd);

  // Only an explicit bootstrap fd gets here, and Ryco Desktop may start the
  // backend before it can write the envelope (it needs Electron ready first).
  // A closed pipe still ends the wait at once; this only bounds a stalled one.
  const timeoutMs = options?.timeoutMs ?? 10_000;

  return yield* Effect.callback<Option.Option<A>, BootstrapError>((resume) => {
    const input = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const cleanup = () => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
      stream.destroy();
    };

    const handleError = (error: Error) => {
      if (isUnavailableBootstrapFdError(error)) {
        resume(Effect.succeedNone);
        return;
      }
      resume(
        Effect.fail(
          new BootstrapError({
            message: "Failed to read bootstrap envelope.",
            cause: error,
          }),
        ),
      );
    };

    const handleLine = (line: string) => {
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        resume(Effect.succeedSome(parsed.success));
      } else {
        resume(
          Effect.fail(
            new BootstrapError({
              message: "Failed to decode bootstrap envelope.",
              cause: parsed.failure,
            }),
          ),
        );
      }
    };

    const handleClose = () => {
      resume(Effect.succeedNone);
    };

    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(cleanup);
  }).pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.flatten));
});

const isUnavailableBootstrapFdError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "EBADF" || _.code === "ENOENT",
);

const isFdReady = (fd: number) =>
  Effect.try({
    try: () => NFS.fstatSync(fd),
    catch: (error) =>
      new BootstrapError({
        message: "Failed to stat bootstrap fd.",
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => isUnavailableBootstrapFdError(error.cause),
      () => Effect.succeed(false),
    ),
  );

const makeBootstrapInputStream = (fd: number) =>
  Effect.try<Readable, BootstrapError>({
    try: () => {
      const fdPath = resolveFdPath(fd);
      if (fdPath === undefined) {
        return makeDirectBootstrapStream(fd);
      }

      let streamFd: number | undefined;
      try {
        streamFd = NFS.openSync(fdPath, "r");
        return NFS.createReadStream("", {
          fd: streamFd,
          encoding: "utf8",
          autoClose: true,
        });
      } catch (error) {
        if (isBootstrapFdPathDuplicationError(error)) {
          if (streamFd !== undefined) {
            NFS.closeSync(streamFd);
          }
          return makeDirectBootstrapStream(fd);
        }
        throw error;
      }
    },
    catch: (error) =>
      new BootstrapError({
        message: "Failed to duplicate bootstrap fd.",
        cause: error,
      }),
  });

const makeDirectBootstrapStream = (fd: number): Readable => {
  try {
    return NFS.createReadStream("", {
      fd,
      encoding: "utf8",
      autoClose: true,
    });
  } catch {
    const stream = new Net.Socket({
      fd,
      readable: true,
      writable: false,
    });
    stream.setEncoding("utf8");
    return stream;
  }
};

const isBootstrapFdPathDuplicationError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "ENXIO" || _.code === "EINVAL" || _.code === "EPERM",
);

export function resolveFdPath(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
