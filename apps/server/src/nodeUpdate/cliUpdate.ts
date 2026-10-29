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
 * keeps running without a restart. After the restart, the boot guard (bootGuard.ts) rolls back
 * a release that keeps failing to start, and the release confirms the update once it is ready
 * ({@link awaitNodeReadyAfterUpdate}).
 *
 * Loaded with the first update, and by a process restarted into one (NodeUpdateService.ts), so
 * no other boot pays for it. What it needs from the server is passed in, so loading it splits
 * none of the server's own modules into chunks of their own.
 *
 * @module nodeUpdate/cliUpdate
 */
import type { HubConnectorStatus, NodeUpdateRun } from "@ryco/contracts";
import { Cause, Duration, Effect, FileSystem, Path, Result } from "effect";

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
import { NODE_UPDATE_PREFLIGHT_PASSED, NODE_UPDATE_PREFLIGHT_STARTED } from "./updateProtocol.ts";

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
  readonly restartDelay: Duration.Input;
  readonly restartGrace: Duration.Input;
}

export const runCliNodeUpdate = Effect.fn("runCliNodeUpdate")(function* (
  input: CliNodeUpdateInput,
) {
  const { runtime, detected, run, marker, setRun, finishFailed } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const reinstall = (version: string) =>
    Effect.gen(function* () {
      const command = nodeInstallCommand(detected, version, runtime.execPath);
      if (command === null) return `${version} could not be reinstalled.`;
      const result = yield* runtime.runCommand(command);
      return commandSucceeded(result)
        ? `Reinstalled ${version}.`
        : `Reinstalling ${version} failed too; update it on that machine.`;
    });

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
   * rollback set aside), so one snapshot is kept at most.
   */
  const snapshotDatabase = (fromVersion: string) =>
    Effect.gen(function* () {
      const directory = runtime.updateDirectory;
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      yield* Effect.forEach(
        entries,
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
