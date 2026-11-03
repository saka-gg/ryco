/**
 * What `ryco trace summary` does once it runs: find the trace files, summarize them, print the
 * report. Loaded by `traceCommand.ts` only when the command runs; never import it statically from
 * the server graph.
 *
 * @module cliTrace/traceRun
 */
import { Clock, Console, Data, Duration, Effect, FileSystem, Option, Path } from "effect";

import { expandHomePath } from "../os-jank.ts";
import { rotatedTraceFilePaths } from "../observability/TraceRecord.ts";
import type { TraceCommandDeps, TraceLocationFlags, TraceSummaryFlags } from "./traceCommand.ts";
import {
  formatTraceSummary,
  makeTraceSpanSummary,
  readTraceFileLines,
  traceSummaryJson,
} from "./traceSummary.ts";

/** Backups read next to an explicit `--file`: the writer's default `RYCO_TRACE_MAX_FILES`. */
const EXPLICIT_FILE_MAX_BACKUPS = 10;

export class TraceSummaryError extends Data.TaggedError("TraceSummaryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The trace file to read and how many rotated backups sit next to it. */
const resolveTraceFiles = <E, R>(
  deps: TraceCommandDeps<E, R>,
  flags: TraceLocationFlags & { readonly file: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (Option.isSome(flags.file)) {
      const file = flags.file.value.trim();
      if (file.length === 0) {
        return yield* new TraceSummaryError({ message: "--file needs a path." });
      }
      const traceFilePath = path.resolve(yield* expandHomePath(file));
      return { traceFilePath, maxBackups: EXPLICIT_FILE_MAX_BACKUPS, explicit: true };
    }
    const location = yield* deps.resolveTraceLocation({
      baseDir: flags.baseDir,
      devUrl: flags.devUrl,
    });
    // A folder with no state directory (a mistyped `--base-dir`, a `RYCO_HOME` no server used) is
    // refused rather than reported as holding no spans.
    if (!location.traceFileFromEnv) {
      const exists = yield* fs.exists(location.stateDir).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return yield* new TraceSummaryError({
          message: `No Ryco data directory at ${location.baseDir}.`,
        });
      }
    }
    return {
      traceFilePath: location.traceFilePath,
      maxBackups: location.maxBackups,
      explicit: false,
    };
  });

export const runTraceSummary = <E, R>(deps: TraceCommandDeps<E, R>, flags: TraceSummaryFlags) =>
  Effect.gen(function* () {
    const files = yield* resolveTraceFiles(deps, flags);
    const sinceMs = Option.isSome(flags.since)
      ? (yield* Clock.currentTimeMillis) - Duration.toMillis(flags.since.value)
      : undefined;
    const summarizer = makeTraceSpanSummary({ sinceMs });
    const { filesRead, filesUnreadable } = yield* Effect.tryPromise({
      try: () =>
        readTraceFileLines({
          paths: rotatedTraceFilePaths(files.traceFilePath, files.maxBackups),
          sinceMs,
          followSymlinks: files.explicit,
          onLine: summarizer.addLine,
        }),
      catch: (cause) =>
        new TraceSummaryError({
          message: `Could not read the trace files: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });
    const report = {
      traceFilePath: files.traceFilePath,
      filesRead,
      filesUnreadable,
      sinceMs,
      limit: flags.limit,
      summary: summarizer.finish(),
    };
    yield* Console.log(
      flags.json ? deps.emitJson(traceSummaryJson(report)) : formatTraceSummary(report),
    );
  });
