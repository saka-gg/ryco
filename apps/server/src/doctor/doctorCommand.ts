/**
 * `ryco doctor`: check the database, and with `--apply` remove superseded history and shrink the
 * file while no server uses it (see `DatabaseDoctor.ts` and docs/storage-management.md).
 *
 * cli.ts passes in its location flags, `--json` flag and config resolution, so this module owns
 * the command and cli.ts only registers it.
 *
 * Exit codes: 0 done (or nothing to do, or declined), 1 a failure midway, 2 refused (nothing
 * changed: another server has the database, the schema differs, not enough disk, ...).
 *
 * @module doctor/doctorCommand
 */
import { Console, Effect, type LogLevel, type Option, References } from "effect";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import type { ServerConfigShape } from "../config.ts";
import { cliCommandPrefix, isInteractiveTerminal } from "../cliSetup/ui.ts";
import { defaultBaseDir } from "../os-jank.ts";
import { describeDatabaseOwner } from "../persistence/databaseOwnerLock.ts";
import { describeRepairKeys } from "../persistence/Migrations.ts";
import { nodeServiceLabel, nodeServicePlatform } from "../service/nodeService.ts";
import {
  type DoctorInspection,
  type DoctorPorts,
  type DoctorRepairResult,
  formatBytes,
  inspectDatabase,
  repairDatabase,
  silentDoctorReporter,
} from "./DatabaseDoctor.ts";
import { databaseOwnerLockOwnership, nodeServiceControl } from "./doctorOwnership.ts";
import { makeTerminalDoctorReporter } from "./doctorReporter.ts";
import { findFileHolders } from "./fileHolders.ts";
import { freeBytesOnVolume } from "./sqliteSwap.ts";

interface DoctorLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
}

export interface DoctorCommandDeps<E, R> {
  /** `--base-dir` and `--dev-url`, as every command that opens a data directory takes them. */
  readonly locationFlags: {
    readonly baseDir: Flag.Flag<Option.Option<string>>;
    readonly devUrl: Flag.Flag<Option.Option<URL>>;
  };
  readonly jsonFlag: Flag.Flag<boolean>;
  /** The one `--json` document form every command prints. */
  readonly emitJson: (value: unknown) => string;
  /** Resolves the data directory the way the other admin commands do. */
  readonly resolveConfig: (
    flags: DoctorLocationFlags,
    logLevel: Option.Option<LogLevel.LogLevel>,
  ) => Effect.Effect<ServerConfigShape, E, R>;
  /** Silences every log line below Error for the whole command (`--json` owns stdout). */
  readonly quietly: <A, E2, R2>(
    quiet: boolean,
    effect: Effect.Effect<A, E2, R2>,
  ) => Effect.Effect<A, E2, R2>;
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

export const makeDoctorCommand = <E, R>(deps: DoctorCommandDeps<E, R>) =>
  Command.make("doctor", {
    ...deps.locationFlags,
    apply: Flag.Boolean("apply").pipe(
      Flag.withDescription(
        "Remove superseded history and shrink the database file. Stops this data directory's background service and starts it again; refuses while another Ryco server uses the database.",
      ),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withAlias("y"),
      Flag.withDescription("Do not ask for confirmation (needed with --apply outside a terminal)."),
      Flag.withDefault(false),
    ),
    estimate: Flag.Boolean("estimate").pipe(
      Flag.withDescription(
        "Count exactly how much superseded history the database holds (reads the whole log).",
      ),
      Flag.withDefault(false),
    ),
    thorough: Flag.Boolean("thorough").pipe(
      Flag.withDescription("Check the database with integrity_check instead of quick_check first."),
      Flag.withDefault(false),
    ),
    restartService: Flag.Boolean("restart-service").pipe(
      Flag.withDescription(
        "Start the background service again after --apply stopped it (--no-restart-service leaves it stopped).",
      ),
      Flag.withDefault(true),
    ),
    json: deps.jsonFlag,
  }).pipe(
    Command.withDescription(
      "Check the database and how much it could shrink; with --apply, remove superseded history and shrink the file offline.",
    ),
    Command.withHandler((flags) =>
      deps.quietly(
        flags.json,
        Effect.gen(function* () {
          const logLevel = yield* GlobalFlag.LogLevel;
          const config = yield* deps.resolveConfig(
            { baseDir: flags.baseDir, devUrl: flags.devUrl },
            logLevel,
          );
          const platform = nodeServicePlatform();
          const reporter = flags.json
            ? { ...silentDoctorReporter, end: Effect.void }
            : makeTerminalDoctorReporter({
                tty: process.stderr.isTTY === true,
                write: (text) => {
                  process.stderr.write(text);
                },
              });
          const ports: DoctorPorts = {
            ownership: databaseOwnerLockOwnership,
            service: nodeServiceControl(
              platform,
              nodeServiceLabel(config.baseDir, defaultBaseDir()),
            ),
            freeBytes: (directory) =>
              Effect.promise(() => freeBytesOnVolume(directory).catch(() => null)),
            fileHolders: (paths) => Effect.promise(() => findFileHolders({ paths })),
            reporter,
            pid: process.pid,
            now: Date.now,
          };
          const target = {
            dbPath: config.dbPath,
            stateDir: config.stateDir,
            commandPrefix: cliCommandPrefix(),
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
            const result = yield* repairDatabase(
              target,
              { thorough: flags.thorough, restartService: flags.restartService },
              ports,
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
        }),
      ),
    ),
  );
