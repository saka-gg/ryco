/**
 * What `ryco doctor` does once its flags are parsed and its data directory is resolved. Loaded by
 * `doctorCommand.ts` with `import()` only when the command runs, so none of the doctor is on the
 * server's boot path (see serverBundleBoundaries.test.ts).
 *
 * @module doctor/doctorRun
 */
import type { EventEmitter } from "node:events";

import { Console, Effect, type LogLevel, type Option, References } from "effect";
import { Prompt } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import type { ServerConfigShape } from "../config.ts";
import { isInteractiveTerminal } from "../cliSetup/ui.ts";
import { defaultBaseDir } from "../os-jank.ts";
import { describeDatabaseOwner } from "../persistence/databaseOwnerLock.ts";
import { describeRepairKeys } from "../persistence/Migrations.ts";
import {
  isEphemeralCliInstall,
  nodeServiceLabel,
  nodeServicePlatform,
} from "../service/nodeService.ts";
import {
  type DoctorInspection,
  type DoctorPorts,
  type DoctorRepairResult,
  type DoctorTarget,
  formatBytes,
  inspectDatabase,
  repairDatabase,
  silentDoctorReporter,
} from "./DatabaseDoctor.ts";
import { databaseOwnerLockOwnership, nodeServiceControl } from "./doctorOwnership.ts";
import { makeTerminalDoctorReporter } from "./doctorReporter.ts";
import { doctorApplyCommand } from "./doctorSuggestion.ts";
import { findFileHolders } from "./fileHolders.ts";
import { freeBytesOnVolume } from "./sqliteSwap.ts";

export interface DoctorFlags {
  readonly json: boolean;
  readonly apply: boolean;
  readonly yes: boolean;
  readonly estimate: boolean;
  readonly thorough: boolean;
  readonly restartService: boolean;
}

export interface DoctorRunInput {
  readonly flags: DoctorFlags;
  readonly config: ServerConfigShape;
  readonly logLevel: Option.Option<LogLevel.LogLevel>;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
  readonly adminCommandLogLevel: (
    requested: Option.Option<LogLevel.LogLevel>,
    configured: LogLevel.LogLevel,
  ) => LogLevel.LogLevel;
}

const count = (value: number) => value.toLocaleString("en-US");

const describeOwner = (inspection: DoctorInspection): string => {
  const owner = inspection.owner;
  switch (owner.state) {
    case "free":
      return "nothing (no Ryco server has it open)";
    case "unknown":
      return `unknown: ${owner.message}`;
    case "owned":
      return `${describeDatabaseOwner(owner.owner)}${owner.endpoint ? `, listening on ${owner.endpoint}` : ""}${
        owner.service ? ": --apply stops it and starts it again" : ""
      }`;
  }
};

export function formatDoctorInspection(inspection: DoctorInspection, apply: boolean): string {
  const lines: Array<string> = [`Database    ${inspection.dbPath}`];
  if (inspection.exists && inspection.pages !== null) {
    const { pages } = inspection;
    lines.push(
      `Size        ${formatBytes(inspection.fileBytes + inspection.walBytes)} on disk${
        inspection.walBytes > 0 ? ` (${formatBytes(inspection.walBytes)} not yet merged)` : ""
      }; ${formatBytes(pages.freePages * pages.pageSize)} free inside the file`,
      `Shrinking   ${
        pages.autoVacuum === "incremental"
          ? "on: free space is returned to the disk automatically"
          : pages.autoVacuum === "full"
            ? "on (full): free space is returned to the disk at every write; --apply switches it to incremental"
            : "off: created before automatic shrinking, so the file never gets smaller"
      }`,
    );
  }
  if (inspection.schema !== null) {
    lines.push(
      `Schema      ${inspection.schema.applied} (this ryco: ${inspection.schema.supported})${
        inspection.schema.repairs.length > 0
          ? `, needs compatibility repairs (${describeRepairKeys(inspection.schema.repairs)})`
          : ""
      }`,
    );
  }
  const compaction = inspection.compaction;
  if (compaction !== null) {
    lines.push(
      `History     ${count(compaction.headSequence)} events written; background compaction removed ${count(
        compaction.removedEvents,
      )} (${formatBytes(compaction.removedBytes)}) so far`,
      `Removable   ${
        compaction.removableBytes === null
          ? "unknown before the first background compaction pass (--estimate counts it)"
          : compaction.exact
            ? `${count(compaction.removableEvents ?? 0)} superseded events (${formatBytes(
                compaction.removableBytes,
              )}) and ${count(compaction.removableReceipts ?? 0)} old receipts`
            : `about ${formatBytes(compaction.removableBytes)} of superseded history (estimate; --estimate counts it)`
      }`,
    );
  }
  lines.push(`In use by   ${describeOwner(inspection)}`);
  if (inspection.disk.freeBytes !== null || inspection.disk.neededBytes !== null) {
    lines.push(
      `Disk        ${
        inspection.disk.freeBytes === null
          ? "free space unknown"
          : `${formatBytes(inspection.disk.freeBytes)} free`
      }${
        inspection.disk.neededBytes === null
          ? ""
          : `; the compacted copy needs about ${formatBytes(inspection.disk.neededBytes)}`
      }`,
    );
  }
  if (inspection.estimatedBytesAfter !== null) {
    // Removed payload bytes undercount what a row frees (index entries, receipts, page slack).
    lines.push(`After       at most about ${formatBytes(inspection.estimatedBytesAfter)}`);
  }
  if (inspection.plan.length > 0) {
    lines.push(
      "",
      apply ? "The doctor will:" : "`--apply` would:",
      ...inspection.plan.map((step, index) => `  ${index + 1}. ${step}`),
    );
  }
  if (inspection.blockers.length > 0) {
    lines.push(
      "",
      apply ? "It cannot run now:" : "`--apply` cannot run now:",
      ...inspection.blockers.map((blocker) => `  - ${blocker}`),
    );
  }
  return lines.join("\n");
}

const ignoreOutputError = () => undefined;

/**
 * Runs `effect` (the `--apply` run) so that a lost terminal ends it the way Ctrl-C does: the
 * fiber is interrupted, and the run's finalizers remove the copy, release ownership and start a
 * paused service. `NodeRuntime.runMain` interrupts on SIGINT and SIGTERM only; on SIGHUP Node
 * ends the process at once. A hung-up terminal also fails writes with EIO (a closed pipe with
 * EPIPE), and an unhandled stream error ends the process just as abruptly, so output errors are
 * ignored meanwhile, and for good once the terminal hung up.
 */
export const interruptOnHangup = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  io: {
    readonly signals: EventEmitter;
    readonly output: ReadonlyArray<EventEmitter>;
  } = { signals: process, output: [process.stdout, process.stderr] },
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    let hungUp = false;
    const onHangup = () => {
      hungUp = true;
      fiber.interruptUnsafe(fiber.id);
    };
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        io.signals.on("SIGHUP", onHangup);
        for (const stream of io.output) stream.on("error", ignoreOutputError);
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          io.signals.removeListener("SIGHUP", onHangup);
          if (hungUp) return;
          for (const stream of io.output) stream.removeListener("error", ignoreOutputError);
        }),
    );
  });

/** The command that runs `--apply` again: the same program (pinned under npx) and location. */
export const doctorRerunCommand = (
  config: Pick<ServerConfigShape, "baseDir" | "devUrl">,
  scriptPath: string | undefined = process.argv[1],
): string =>
  doctorApplyCommand({
    npx: scriptPath !== undefined && isEphemeralCliInstall(scriptPath),
    baseDir: config.baseDir,
    defaultBaseDir: defaultBaseDir(),
    devUrl: config.devUrl,
    version: packageJson.version,
  });

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function formatDoctorResult(result: DoctorRepairResult): string {
  const heading =
    result.status === "refused" ? "Not run" : result.status === "failed" ? "Failed" : "Done";
  const timings = Object.entries(result.durationsMs)
    .filter(([, ms]) => ms >= 100)
    .map(([step, ms]) => `${step} ${seconds(ms)}`);
  return [
    `${heading}: ${result.message}`,
    ...(timings.length > 0 ? [`Time: ${timings.join(", ")}.`] : []),
  ].join("\n");
}

export const runDoctor = (input: DoctorRunInput) =>
  Effect.gen(function* () {
    const { flags, config, logLevel } = input;
    const deps = input;
    const platform = nodeServicePlatform();
    const reporter = flags.json
      ? { ...silentDoctorReporter, end: Effect.void }
      : makeTerminalDoctorReporter({
          tty: process.stderr.isTTY === true,
          write: (text) => {
            try {
              process.stderr.write(text);
            } catch {
              // Best effort: a write a closed terminal or a full disk refuses must not end the
              // run before its finalizers (see interruptOnHangup).
            }
          },
        });
    const ports: DoctorPorts = {
      ownership: databaseOwnerLockOwnership,
      service: nodeServiceControl(platform, nodeServiceLabel(config.baseDir, defaultBaseDir())),
      freeBytes: (directory) =>
        Effect.promise(() => freeBytesOnVolume(directory).catch(() => null)),
      fileHolders: (paths) => Effect.promise(() => findFileHolders({ paths })),
      reporter,
      pid: process.pid,
      now: Date.now,
    };
    const target: DoctorTarget = {
      dbPath: config.dbPath,
      stateDir: config.stateDir,
      rerunCommand: doctorRerunCommand(config),
    };
    const run = Effect.gen(function* () {
      const inspection = yield* inspectDatabase(target, { estimate: flags.estimate }, ports);
      yield* reporter.end;
      if (!flags.apply) {
        yield* Console.log(
          flags.json
            ? deps.emitJson({ inspection })
            : `${formatDoctorInspection(inspection, false)}\n`,
        );
        return;
      }
      if (!flags.json) yield* Console.log(`${formatDoctorInspection(inspection, true)}\n`);
      const refusal = (message: string) =>
        Effect.gen(function* () {
          yield* Console.log(
            flags.json
              ? deps.emitJson({
                  inspection,
                  result: { status: "refused", exitCode: 2, message },
                })
              : `Not run: ${message}`,
          );
          process.exitCode = 2;
        });
      if (inspection.blockers.length > 0) {
        return yield* refusal("see above; nothing was changed.");
      }
      if (!flags.yes) {
        if (flags.json || !isInteractiveTerminal()) {
          return yield* refusal(
            "--apply changes the database. Run it in a terminal to confirm, or pass --yes.",
          );
        }
        const confirmed = yield* Prompt.run(
          Prompt.Confirm({
            message:
              inspection.owner.state === "owned" && inspection.owner.service
                ? "Stop the background service, shrink the database and start the service again?"
                : "Shrink the database now? Ryco servers cannot use it until the doctor is done.",
            initial: false,
          }),
        ).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
        if (!confirmed) {
          yield* Console.log("Nothing was changed.");
          return;
        }
      }
      const result = yield* interruptOnHangup(
        repairDatabase(
          target,
          { thorough: flags.thorough, restartService: flags.restartService },
          ports,
        ),
      );
      yield* reporter.end;
      yield* Console.log(
        flags.json ? deps.emitJson({ inspection, result }) : formatDoctorResult(result),
      );
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });
    return yield* run.pipe(
      Effect.provideService(
        References.MinimumLogLevel,
        flags.json ? "Error" : deps.adminCommandLogLevel(logLevel, config.logLevel),
      ),
    );
  });
