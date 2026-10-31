/**
 * nodeUpdate/cliUpdate - One update of a CLI node, from the install to the restart.
 *
 * 1. Installs the exact release into the installation this process runs from.
 * 2. Checks it: its preflight (preflight.ts) loads its whole server graph and migrates a copy of
 *    the database, without touching this node's state. A release that does not know the
 *    preflight (updateProtocol.ts) is checked with `--version` instead.
 * 3. Snapshots the database (`node-update/pre-<from>.sqlite`, the only snapshot kept) and
 *    records the marker with what undoes the update: the command that reinstalls the previous
 *    release, the database and the snapshot.
 * 4. Hands the restart to the service manager.
 *
 * The installs hold the host-wide install lock under the installation's own key, the one a
 * provider CLI update into the same global install takes (`installLockKeys.ts`): a person's update
 * waits for it, an unattended one is run by a caller that holds it.
 *
 * A failed install, check, snapshot or marker reinstalls the previous release, and the node
 * keeps running without a restart. An unattended update whose quiet moment ended (asked once the
 * release is checked and again once the restart is recorded) puts the previous release back,
 * checks it like the target, and is postponed. When the previous release cannot go back, the
 * target (checked again) is what runs next: its next start is guarded at once and the node
 * restarts into it at the next quiet moment. An unattended install also holds back brand-new
 * dependency releases (`NodeInstallHoldBack`).
 *
 * After the restart, the boot guard (bootGuard.ts) rolls back a release that keeps failing to
 * start, and the release confirms the update once it is ready ({@link awaitNodeReadyAfterUpdate});
 * after an unattended update it exits when it is not ready in time, so the boot guard counts that
 * start too ({@link awaitNodeReadyOrExit}).
 *
 * Loaded with the first update, and by a process restarted into one (NodeUpdateService.ts), so
 * no other boot pays for it. What it needs from the server is passed in, so loading it splits
 * none of the server's own modules into chunks of their own.
 *
 * @module nodeUpdate/cliUpdate
 */
import type { HubConnectorStatus, NodeUpdateRun } from "@ryco/contracts";
import { Cause, Clock, Duration, Effect, FileSystem, Option, Path, Result } from "effect";

import type { HubConnectorServiceShape } from "../hubConnector/HubConnectorService.ts";
import { isParseableCliVersion, satisfiesCliVersionRange } from "../provider/cliVersion.ts";
import type { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import { type DetectedNodeInstallation, nodeInstallLockKey } from "./installation.ts";
import { type NodeUpdateMarker, removeNodeUpdateMarker, writeNodeUpdateMarker } from "./marker.ts";
import type { NodeUpdateRuntime, UnattendedNodeUpdate } from "./NodeUpdateService.ts";
import {
  commandOutputTail,
  commandSucceeded,
  describeCommandFailure,
  NODE_VERIFY_TIMEOUT,
  type NodeUpdateCommand,
  nodeInstallCommand,
  nodeInstallHoldBack,
  nodePreflightCommand,
  nodeVerifyCommand,
  outputReportsVersion,
  PNPM_MINIMUM_RELEASE_AGE_RANGE,
  recordNodeUpdateCommand,
} from "./processes.ts";
import {
  NODE_NOT_READY_EXIT_CODE,
  NODE_UPDATE_AUTO_SKIP_FILE_NAME,
  NODE_UPDATE_PREFLIGHT_PASSED,
  NODE_UPDATE_PREFLIGHT_STARTED,
  UNATTENDED_BOOT_READY_TIMEOUT_MS,
} from "./updateProtocol.ts";

export { makeNodeUpdateCommandRunner, restartThroughServiceManager } from "./processes.ts";

/** In the update directory; removed again once the preflight is done. */
const PREFLIGHT_COPY_FILE_NAME = "preflight.sqlite";

/** The snapshot the boot guard restores when the update is rolled back. */
export const nodeUpdateSnapshotFileName = (fromVersion: string) =>
  `pre-${fromVersion.replace(/[^A-Za-z0-9._-]/gu, "_")}.sqlite`;

export type NodeUpdatePreflightVerdict =
  | { readonly kind: "unsupported" }
  | { readonly kind: "passed"; readonly version: string }
  | { readonly kind: "failed" };

/**
 * What the candidate's stdout says (updateProtocol.ts): `unsupported` without the announcement.
 * The exit code is checked by the caller.
 */
export function nodeUpdatePreflightVerdict(stdout: string): NodeUpdatePreflightVerdict {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim());
  if (!lines.includes(NODE_UPDATE_PREFLIGHT_STARTED)) return { kind: "unsupported" };
  const passed = lines.findLast((line) => line.startsWith(`${NODE_UPDATE_PREFLIGHT_PASSED} `));
  const version = passed?.slice(NODE_UPDATE_PREFLIGHT_PASSED.length + 1).trim();
  return version ? { kind: "passed", version } : { kind: "failed" };
}

type ReleaseCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly output: string | null };

const RELEASE_CHECK_PASSED: ReleaseCheck = { ok: true };
const releaseCheckFailed = (reason: string, output: string | null): ReleaseCheck => ({
  ok: false,
  reason,
  output,
});
const NO_ENTRY_SCRIPT = "Ryco could not find its entry script.";

export interface CliNodeUpdateInput {
  readonly runtime: NodeUpdateRuntime;
  readonly detected: DetectedNodeInstallation;
  /** As admitted (`preparing`). */
  readonly run: NodeUpdateRun;
  readonly marker: NodeUpdateMarker;
  readonly setRun: (run: NodeUpdateRun) => Effect.Effect<void>;
  readonly finishFailed: (
    run: NodeUpdateRun,
    message: string,
    output: string | null,
  ) => Effect.Effect<void>;
  readonly finishPostponed: (run: NodeUpdateRun, message: string) => Effect.Effect<void>;
  readonly restartDelay: Duration.Input;
  readonly restartGrace: Duration.Input;
  /** How often a node that has to restart asks `unattended.restartWindow` again. */
  readonly restartRecheck: Duration.Input;
  /** An update nobody asked for (`NodeUpdateOptions.unattended`). */
  readonly unattended?: UnattendedNodeUpdate;
}

/** While another Ryco on this machine installs into the same global install. */
export const NODE_UPDATE_INSTALL_LOCK_HELD_MESSAGE =
  "Waiting for another Ryco on this machine to finish installing with the same package manager.";

/**
 * Why this installation does not update itself unattended, `null` when it may. Only npm and pnpm
 * 10.16 or later can hold back dependency releases younger than the minimum release age
 * (`NodeInstallHoldBack`); bun cannot.
 */
export const unattendedInstallRefusal = (
  detected: DetectedNodeInstallation,
  runCommand: NodeUpdateRuntime["runCommand"],
) =>
  Effect.gen(function* () {
    switch (detected.kind) {
      case "npm-global":
        return null;
      case "pnpm-global": {
        const probed = yield* runCommand({
          command: "pnpm",
          args: ["--version"],
          timeout: NODE_VERIFY_TIMEOUT,
        });
        const version = commandSucceeded(probed) ? probed.stdout.trim() : "";
        return isParseableCliVersion(version) &&
          satisfiesCliVersionRange(version, PNPM_MINIMUM_RELEASE_AGE_RANGE)
          ? null
          : `${version ? `pnpm ${version}` : "This node's pnpm (its version could not be read)"} cannot hold back brand-new dependency releases, so this node does not update itself. pnpm 10.16 or later can.`;
      }
      default:
        return "Only an npm or pnpm install can hold back brand-new dependency releases, so this node does not update itself.";
    }
  });

type RestartRecord =
  | { readonly ok: true; readonly snapshotPath: string }
  | { readonly ok: false; readonly reason: string };

export const runCliNodeUpdate = Effect.fn("runCliNodeUpdate")(function* (
  input: CliNodeUpdateInput,
) {
  const { runtime, detected, run, marker, setRun, finishFailed, unattended } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  // An unattended install holds back dependency releases younger than the release age.
  const holdBack =
    unattended === undefined
      ? undefined
      : nodeInstallHoldBack(yield* Clock.currentTimeMillis, unattended.minimumReleaseAge);
  const installCommand = (version: string) =>
    nodeInstallCommand(detected, version, runtime.execPath, holdBack);
  const target = marker.targetVersion;
  const install = installCommand(target);
  const reinstallPrevious = installCommand(marker.fromVersion);
  const lockKey = nodeInstallLockKey(detected);
  const service = detected.service;
  const serviceLabel = detected.serviceLabel;
  if (
    install === null ||
    reinstallPrevious === null ||
    lockKey === null ||
    detected.entryScript === null ||
    service === null ||
    !serviceLabel
  ) {
    return yield* finishFailed(run, "This installation cannot be updated from here.", null);
  }

  const removeDatabaseCopy = (filePath: string) =>
    Effect.forEach(
      ["", "-wal", "-shm", "-journal"],
      (suffix) => fileSystem.remove(`${filePath}${suffix}`, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

  /** `ryco --version` of the installed release, for one that predates the preflight. */
  const checkReportedVersion = (version: string) =>
    Effect.gen(function* () {
      const verify = nodeVerifyCommand(detected, runtime.execPath);
      if (verify === null) return releaseCheckFailed(NO_ENTRY_SCRIPT, null);
      const verified = yield* runtime.runCommand(verify);
      if (
        commandSucceeded(verified) &&
        outputReportsVersion(`${verified.stdout}\n${verified.stderr}`, version)
      ) {
        return RELEASE_CHECK_PASSED;
      }
      return releaseCheckFailed(
        commandSucceeded(verified)
          ? `The installed release did not report ${version}.`
          : describeCommandFailure(verify, verified, `checking ${version}`),
        commandOutputTail(verified),
      );
    });

  /**
   * Whether the installed `version` can start here: its preflight migrates a copy of the
   * database (removed again afterwards). Only a release whose output shows it does not know
   * the preflight is checked with `--version` instead; one that hangs or crashes fails.
   */
  const checkInstalledRelease = (version: string) =>
    Effect.gen(function* () {
      const copyPath = path.join(runtime.updateDirectory, PREFLIGHT_COPY_FILE_NAME);
      const preflight = nodePreflightCommand(detected, runtime.execPath, copyPath);
      if (preflight === null) return releaseCheckFailed(NO_ENTRY_SCRIPT, null);
      yield* removeDatabaseCopy(copyPath);
      const copied = yield* Effect.result(runtime.copyDatabase(copyPath));
      if (Result.isFailure(copied)) {
        yield* removeDatabaseCopy(copyPath);
        return releaseCheckFailed(
          `Could not copy the database to check ${version} with: ${copied.failure.reason}`,
          null,
        );
      }
      const result = yield* runtime
        .runCommand(preflight)
        .pipe(Effect.ensuring(removeDatabaseCopy(copyPath)));
      const verdict = nodeUpdatePreflightVerdict(result.stdout);
      if (
        verdict.kind === "unsupported" &&
        result.exitCode !== null &&
        !result.timedOut &&
        result.spawnError === null
      ) {
        return yield* checkReportedVersion(version);
      }
      if (verdict.kind === "passed" && commandSucceeded(result)) {
        return verdict.version === version
          ? RELEASE_CHECK_PASSED
          : releaseCheckFailed(
              `The installed release is ${verdict.version}, not ${version}.`,
              commandOutputTail(result),
            );
      }
      return releaseCheckFailed(
        describeCommandFailure(preflight, result, `checking ${version}`),
        commandOutputTail(result),
      );
    });

  /**
   * The database right before the restart, as `pre-<fromVersion>.sqlite` in the update
   * directory. Everything else there goes first (an older snapshot, a database an earlier
   * rollback set aside), so one snapshot is kept at most; only the releases unattended updates
   * skip stay.
   */
  const snapshotDatabase = (fromVersion: string) =>
    Effect.gen(function* () {
      const directory = runtime.updateDirectory;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      yield* Effect.forEach(
        entries.filter((entry) => entry !== NODE_UPDATE_AUTO_SKIP_FILE_NAME),
        (entry) =>
          fileSystem
            .remove(path.join(directory, entry), { recursive: true, force: true })
            .pipe(Effect.ignore),
        { discard: true },
      );
      const snapshotPath = path.join(directory, nodeUpdateSnapshotFileName(fromVersion));
      yield* runtime.copyDatabase(snapshotPath);
      return snapshotPath;
    });

  /**
   * What makes the next start of the target a guarded one: the snapshot, taken as late as
   * possible, and the marker that records how to undo the update. Without the marker the
   * restarted node could neither report back nor be rolled back.
   */
  const recordRestart = (startedAt: string) =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.result(snapshotDatabase(marker.fromVersion));
      if (Result.isFailure(snapshot)) {
        return {
          ok: false,
          reason: `Could not save the database before restarting: ${snapshot.failure.reason}`,
        } satisfies RestartRecord;
      }
      const recorded = yield* writeNodeUpdateMarker(runtime.markerPath, {
        ...marker,
        startedAt,
        rollback: {
          install: recordNodeUpdateCommand(reinstallPrevious),
          databasePath: runtime.databasePath,
          snapshotPath: snapshot.success,
        },
      }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("node update marker could not be written", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      return recorded
        ? ({ ok: true, snapshotPath: snapshot.success } satisfies RestartRecord)
        : ({
            ok: false,
            reason: "Could not record the update on this node.",
          } satisfies RestartRecord);
    });

  const restartNow = Effect.gen(function* () {
    yield* setRun({ ...run, status: "restarting" });
    yield* Effect.sleep(input.restartDelay);
    yield* runtime.restart({ manager: service, label: serviceLabel });
    yield* Effect.sleep(input.restartGrace);
    // Still running: the service manager did not restart this process. The marker stays, so the
    // next start reports the release it comes back on.
    yield* finishFailed(
      run,
      `Ryco ${target} is installed, but the node did not restart. Restart it to finish.`,
      null,
    );
  });

  /** The install, the check and the restart, holding this installation's install lock. */
  const update = (recordInstallerPid: (pid: number) => Effect.Effect<void, Error>) =>
    Effect.gen(function* () {
      // The lock records each installer, so an installer that outlives this process keeps it.
      const runInstaller = (command: NodeUpdateCommand) =>
        runtime.runCommand(command, recordInstallerPid);
      const reinstall = (version: string) =>
        Effect.gen(function* () {
          const command = installCommand(version);
          if (command === null) return `${version} could not be reinstalled.`;
          return commandSucceeded(yield* runInstaller(command))
            ? `Reinstalled ${version}.`
            : `Reinstalling ${version} failed too; update it on that machine.`;
        });

      /**
       * The previous release cannot run from disk any more, so the target, which passed its
       * check, is what the node runs next: installed again when the previous one replaced it,
       * and checked again either way.
       */
      const forwardToTarget = (installAgain: boolean) =>
        Effect.gen(function* () {
          if (installAgain) {
            const again = yield* runInstaller(install);
            if (!commandSucceeded(again)) {
              return releaseCheckFailed(
                describeCommandFailure(install, again, `installing ${target} again`),
                commandOutputTail(again),
              );
            }
          }
          return yield* checkInstalledRelease(target);
        });

      /**
       * The target is installed and checked and the previous release cannot go back, so the node
       * has to restart into the target. The next start is guarded at once, so a crash or a reboot
       * meanwhile is rolled back like any update, and the restart itself waits until it would
       * cut nobody off (the update window alone: turning automatic updates off cannot leave the
       * node on files that are not the release it runs).
       */
      const restartWhenQuiet = (problem: string, restartWindow: Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          const guarded = yield* recordRestart(marker.startedAt);
          if (!guarded.ok) return yield* finishFailed(run, `${problem} ${guarded.reason}`, null);
          yield* setRun({
            ...run,
            status: "waiting",
            message: `${problem} Ryco ${target} is installed and checked, so the node restarts into it once nobody is using it.`,
          });
          while (!(yield* restartWindow)) yield* Effect.sleep(input.restartRecheck);
          // The node kept running meanwhile: a fresh snapshot, and a marker as young as the
          // restart, so the boot guard does not count it as one nobody waits for.
          const recorded = yield* recordRestart(yield* nowIso);
          if (!recorded.ok) return yield* finishFailed(run, `${problem} ${recorded.reason}`, null);
          return yield* restartNow;
        });

      /**
       * Someone started using the node: the previous release goes back, checked like the target,
       * and the update waits. A previous release that cannot go back means the target runs next.
       */
      const postpone = (restartWindow: Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          const reason = `Someone started using this node before it could restart into ${target}.`;
          const reinstalled = yield* runInstaller(reinstallPrevious);
          let problem: string;
          if (commandSucceeded(reinstalled)) {
            const checked = yield* checkInstalledRelease(marker.fromVersion);
            if (checked.ok) {
              return yield* input.finishPostponed(
                run,
                `${reason} Reinstalled ${marker.fromVersion}. It updates once the node is quiet again.`,
              );
            }
            problem = `Reinstalled ${marker.fromVersion}, but it did not pass its check: ${checked.reason}`;
          } else {
            problem = describeCommandFailure(
              reinstallPrevious,
              reinstalled,
              `reinstalling ${marker.fromVersion}`,
            );
          }
          const forward = yield* forwardToTarget(commandSucceeded(reinstalled));
          if (!forward.ok) {
            return yield* finishFailed(
              run,
              `${reason} ${problem} ${forward.reason} Update it on that machine.`,
              forward.output,
            );
          }
          return yield* restartWhenQuiet(`${reason} ${problem}`, restartWindow);
        });

      const installed = yield* runInstaller(install);
      if (!commandSucceeded(installed)) {
        const rollback = yield* reinstall(marker.fromVersion);
        return yield* finishFailed(
          run,
          `${describeCommandFailure(install, installed, `installing ${target}`)} ${rollback}`,
          commandOutputTail(installed),
        );
      }

      yield* setRun({ ...run, status: "verifying" });
      const checked = yield* checkInstalledRelease(target);
      if (!checked.ok) {
        const rollback = yield* reinstall(marker.fromVersion);
        return yield* finishFailed(run, `${checked.reason} ${rollback}`, checked.output);
      }

      // The install and the check took a while: someone may have started using the node.
      if (unattended !== undefined && !(yield* unattended.beforeRestart)) {
        return yield* postpone(unattended.restartWindow);
      }
      // Taken last, so it misses only the writes of the next few seconds; the boot guard
      // restores it if the target never finishes starting.
      const recorded = yield* recordRestart(marker.startedAt);
      if (!recorded.ok) {
        const rollback = yield* reinstall(marker.fromVersion);
        return yield* finishFailed(run, `${recorded.reason} ${rollback}`, null);
      }
      // The snapshot and the marker took a moment too.
      if (unattended !== undefined && !(yield* unattended.beforeRestart)) {
        yield* removeNodeUpdateMarker(runtime.markerPath);
        yield* fileSystem.remove(recorded.snapshotPath, { force: true }).pipe(Effect.ignore);
        return yield* postpone(unattended.restartWindow);
      }
      return yield* restartNow;
    });

  // Unattended, the caller holds the lock for the whole run. A person's update waits while
  // another Ryco on this machine installs into the same global install (a provider CLI update).
  if (unattended !== undefined) return yield* update(unattended.recordInstallerPid);
  return yield* runtime.installLock.pipe(
    Effect.flatMap((lock) =>
      lock.runWhenFree(
        lockKey,
        setRun({ ...run, message: NODE_UPDATE_INSTALL_LOCK_HELD_MESSAGE }),
        (recordInstallerPid) => setRun(run).pipe(Effect.andThen(update(recordInstallerPid))),
      ),
    ),
    Effect.catch((error) =>
      finishFailed(run, `Ryco could not use this machine's install lock: ${error.message}`, null),
    ),
  );
});

// ── After the restart ─────────────────────────────────────────────────────────

export const NODE_BOOT_HUB_WAIT = Duration.minutes(2);
const HUB_STATUS_POLL_INTERVAL = Duration.millis(500);

/** Online, or in a state the connector does not leave without a person. */
export function hubConnectorSettledForBoot(status: HubConnectorStatus): boolean {
  switch (status.state) {
    case "online":
    case "disabled":
    case "enrolling":
    case "awaiting_approval":
    case "revoked":
    case "version_incompatible":
      return true;
    case "degraded":
      return status.degradedMode === "operator_action_required";
    default:
      return false;
  }
}

/** What the server tells a process restarted into an update about its own start (server.ts). */
export interface NodeBootReadiness {
  /** Migrations ran and the runtime is built: the startup command gate opened. */
  readonly commandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  /** The Hub connector once built, when it is enabled; `null` when it is not. */
  readonly hubConnector: Effect.Effect<
    Pick<HubConnectorServiceShape, "connectorEnabled" | "status">
  > | null;
}

/**
 * How long a release an unattended update restarted into may take to get ready once it serves.
 * The boot guard's watchdog bounds the same time from the process start.
 */
export const UNATTENDED_BOOT_READY_TIMEOUT = Duration.millis(UNATTENDED_BOOT_READY_TIMEOUT_MS);
export { NODE_NOT_READY_EXIT_CODE };

/**
 * Waits until a node restarted into an update is ready: its runtime is built (migrations ran),
 * the router serves (the caller runs once it does), and, when the Hub connector is enabled, the
 * connector is online, authenticated with the Hub. Until then the boot guard counts each start
 * of the release as an attempt that may have failed. Fails when the startup failed.
 *
 * The Hub wait is bounded by {@link NODE_BOOT_HUB_WAIT}: an unreachable Hub is not the release's
 * failure, so it must not roll the release back, and past the bound the node counts as ready all
 * the same. A connector waiting for a person (revoked, awaiting approval, a failure that needs an
 * operator) ends the wait at once, and so does one that could not be built.
 */
export const awaitNodeReadyAfterUpdate = (readiness: NodeBootReadiness) =>
  Effect.gen(function* () {
    yield* readiness.commandReady;
    if (readiness.hubConnector === null) return;
    // A connector that could not be built has logged why (HubConnectorDeferred).
    yield* readiness.hubConnector.pipe(
      Effect.flatMap((connector) =>
        Effect.gen(function* () {
          if (!connector.connectorEnabled) return;
          while (!hubConnectorSettledForBoot(connector.status())) {
            yield* Effect.sleep(HUB_STATUS_POLL_INTERVAL);
          }
        }),
      ),
      Effect.timeoutOption(NODE_BOOT_HUB_WAIT),
      Effect.ignoreCause({ log: false }),
    );
  });

/**
 * {@link awaitNodeReadyAfterUpdate} for a release an unattended update restarted into: when it is
 * not ready {@link UNATTENDED_BOOT_READY_TIMEOUT} after it started serving, or its startup failed,
 * it calls `exitProcess` with {@link NODE_NOT_READY_EXIT_CODE} and never returns. The service
 * manager starts it again, the boot guard counts that start as a failed attempt, and after
 * `NODE_UPDATE_MAX_BOOT_ATTEMPTS` the previous release goes back. Nobody watches an update
 * nobody asked for, so a release that hangs must not wait for a person to restart it.
 *
 * Port of the service launcher's readiness bound in T3 Code's unmerged pingdotgg/t3code#17586
 * (`PREPARED_TIMEOUT_MS`, 10 minutes).
 */
export const awaitNodeReadyOrExit = (
  readiness: NodeBootReadiness,
  exitProcess: (code: number) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const ready = yield* awaitNodeReadyAfterUpdate(readiness).pipe(
      Effect.timeoutOption(UNATTENDED_BOOT_READY_TIMEOUT),
      Effect.map(Option.isSome),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(false),
      ),
    );
    if (ready) return;
    yield* Effect.logError(
      "Ryco did not get ready after an automatic update; exiting so the service manager starts it again",
      { timeoutMinutes: Duration.toMinutes(UNATTENDED_BOOT_READY_TIMEOUT) },
    );
    yield* exitProcess(NODE_NOT_READY_EXIT_CODE);
    return yield* Effect.never;
  });
