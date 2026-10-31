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
 * A failed install, check, snapshot or marker reinstalls the previous release, and the node
 * keeps running without a restart. So does an unattended update whose quiet moment ended while
 * the release installed: it is postponed. After the restart, the boot guard (bootGuard.ts) rolls
 * back a release that keeps failing to start, and the release confirms the update once it is
 * ready ({@link awaitNodeReadyAfterUpdate}); after an unattended update it exits when it is not
 * ready in time, so the boot guard counts that start too ({@link awaitNodeReadyOrExit}).
 *
 * Loaded with the first update, and by a process restarted into one (NodeUpdateService.ts), so
 * no other boot pays for it. What it needs from the server is passed in, so loading it splits
 * none of the server's own modules into chunks of their own.
 *
 * @module nodeUpdate/cliUpdate
 */
import type { HubConnectorStatus, NodeUpdateRun } from "@ryco/contracts";
import { Cause, Duration, Effect, FileSystem, Option, Path, Result } from "effect";

import type { HubConnectorServiceShape } from "../hubConnector/HubConnectorService.ts";
import type { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";
import type { DetectedNodeInstallation } from "./installation.ts";
import { type NodeUpdateMarker, writeNodeUpdateMarker } from "./marker.ts";
import type { NodeUpdateRuntime } from "./NodeUpdateService.ts";
import {
  commandOutputTail,
  commandSucceeded,
  describeCommandFailure,
  nodeInstallCommand,
  nodePreflightCommand,
  nodeVerifyCommand,
  outputReportsVersion,
  recordNodeUpdateCommand,
} from "./processes.ts";
import {
  NODE_UPDATE_AUTO_SKIP_FILE_NAME,
  NODE_UPDATE_PREFLIGHT_PASSED,
  NODE_UPDATE_PREFLIGHT_STARTED,
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
  /**
   * An unattended update: asked once the release is installed and checked, right before the
   * snapshot and the restart. `false` puts the previous release back and postpones the update.
   */
  readonly beforeRestart?: Effect.Effect<boolean>;
}

export const runCliNodeUpdate = Effect.fn("runCliNodeUpdate")(function* (
  input: CliNodeUpdateInput,
) {
  const { runtime, detected, run, marker, setRun, finishFailed } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const reinstallOutcome = (version: string) =>
    Effect.gen(function* () {
      const command = nodeInstallCommand(detected, version, runtime.execPath);
      if (command === null) return { ok: false, message: `${version} could not be reinstalled.` };
      const result = yield* runtime.runCommand(command);
      return commandSucceeded(result)
        ? { ok: true, message: `Reinstalled ${version}.` }
        : { ok: false, message: `Reinstalling ${version} failed too; update it on that machine.` };
    });
  const reinstall = (version: string) =>
    Effect.map(reinstallOutcome(version), (outcome) => outcome.message);

  const removeDatabaseCopy = (filePath: string) =>
    Effect.forEach(
      ["", "-wal", "-shm", "-journal"],
      (suffix) => fileSystem.remove(`${filePath}${suffix}`, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

  /** `ryco --version` of the installed release, for one that predates the preflight. */
  const checkReportedVersion = (target: string) =>
    Effect.gen(function* () {
      const verify = nodeVerifyCommand(detected, runtime.execPath);
      if (verify === null) return releaseCheckFailed(NO_ENTRY_SCRIPT, null);
      const verified = yield* runtime.runCommand(verify);
      if (
        commandSucceeded(verified) &&
        outputReportsVersion(`${verified.stdout}\n${verified.stderr}`, target)
      ) {
        return RELEASE_CHECK_PASSED;
      }
      return releaseCheckFailed(
        commandSucceeded(verified)
          ? `The installed release did not report ${target}.`
          : describeCommandFailure(verify, verified, `checking ${target}`),
        commandOutputTail(verified),
      );
    });

  /**
   * Whether the installed `target` can start here: its preflight migrates a copy of the
   * database (removed again afterwards). Only a release whose output shows it does not know
   * the preflight is checked with `--version` instead; one that hangs or crashes fails.
   */
  const checkInstalledRelease = (target: string) =>
    Effect.gen(function* () {
      const copyPath = path.join(runtime.updateDirectory, PREFLIGHT_COPY_FILE_NAME);
      const preflight = nodePreflightCommand(detected, runtime.execPath, copyPath);
      if (preflight === null) return releaseCheckFailed(NO_ENTRY_SCRIPT, null);
      yield* removeDatabaseCopy(copyPath);
      const copied = yield* Effect.result(runtime.copyDatabase(copyPath));
      if (Result.isFailure(copied)) {
        yield* removeDatabaseCopy(copyPath);
        return releaseCheckFailed(
          `Could not copy the database to check ${target} with: ${copied.failure.reason}`,
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
        return yield* checkReportedVersion(target);
      }
      if (verdict.kind === "passed" && commandSucceeded(result)) {
        return verdict.version === target
          ? RELEASE_CHECK_PASSED
          : releaseCheckFailed(
              `The installed release is ${verdict.version}, not ${target}.`,
              commandOutputTail(result),
            );
      }
      return releaseCheckFailed(
        describeCommandFailure(preflight, result, `checking ${target}`),
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

  const target = marker.targetVersion;
  const install = nodeInstallCommand(detected, target, runtime.execPath);
  const reinstallPrevious = nodeInstallCommand(detected, marker.fromVersion, runtime.execPath);
  if (
    install === null ||
    reinstallPrevious === null ||
    detected.entryScript === null ||
    detected.service === null ||
    !detected.serviceLabel
  ) {
    return yield* finishFailed(run, "This installation cannot be updated from here.", null);
  }
  const installed = yield* runtime.runCommand(install);
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

  // The install and the check took a while: someone may have started using the node meanwhile.
  if (input.beforeRestart !== undefined && !(yield* input.beforeRestart)) {
    const rollback = yield* reinstallOutcome(marker.fromVersion);
    const reason = `Someone started using this node before it could restart into ${target}.`;
    // Only a node back on its previous release can wait; otherwise the files on disk are not
    // the release that runs, and that is a failure.
    return yield* rollback.ok
      ? input.finishPostponed(
          run,
          `${reason} ${rollback.message} It updates once the node is quiet again.`,
        )
      : finishFailed(run, `${reason} ${rollback.message}`, null);
  }

  // Taken last, so it misses only the writes of the next few seconds; the boot guard restores
  // it if the target never finishes starting.
  const snapshot = yield* Effect.result(snapshotDatabase(marker.fromVersion));
  if (Result.isFailure(snapshot)) {
    const rollback = yield* reinstall(marker.fromVersion);
    return yield* finishFailed(
      run,
      `Could not save the database before restarting: ${snapshot.failure.reason} ${rollback}`,
      null,
    );
  }
  // Without the marker the restarted node could neither report back nor be rolled back.
  const recorded = yield* writeNodeUpdateMarker(runtime.markerPath, {
    ...marker,
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
  if (!recorded) {
    const rollback = yield* reinstall(marker.fromVersion);
    return yield* finishFailed(run, `Could not record the update on this node. ${rollback}`, null);
  }
  yield* setRun({ ...run, status: "restarting" });
  yield* Effect.sleep(input.restartDelay);
  yield* runtime.restart({ manager: detected.service, label: detected.serviceLabel });
  yield* Effect.sleep(input.restartGrace);
  // Still running: the service manager did not restart this process. The marker stays, so the
  // next start reports the release it comes back on.
  yield* finishFailed(
    run,
    `Ryco ${target} is installed, but the node did not restart. Restart it to finish.`,
    null,
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

/** How long a release an unattended update restarted into may take to get ready. */
export const UNATTENDED_BOOT_READY_TIMEOUT = Duration.minutes(10);
/** The exit code of a release that did not get ready in time after an unattended update. */
export const NODE_NOT_READY_EXIT_CODE = 1;

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
