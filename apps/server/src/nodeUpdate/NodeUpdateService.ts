/**
 * NodeUpdateService - This node's own Ryco release: which one it runs, the newest on its
 * channel, and the one-click update that installs that release and restarts the node.
 *
 * - CLI nodes (`ryco service` installs from npm, bun or pnpm) install the exact release
 *   into their own installation, run it once to check it, leave a marker and let their
 *   service manager restart them. A failed install or check reinstalls the previous
 *   release. The restarted process reports the result from the marker.
 * - Desktop backends ask their Electron app over the backend pipe and mirror its
 *   download, countdown and relaunch.
 * - Every other installation reports why it cannot, and what to run instead.
 *
 * The newest CLI release comes from the npm registry, cached for an hour (in memory and
 * beside the provider caches). Automatic checks run off the startup path, when someone
 * subscribes and the cache is stale, and not at all when update checks are turned off;
 * an explicit check always asks again. At most one update runs at a time.
 *
 * @module NodeUpdateService
 */
import os from "node:os";

import {
  IsoDateTime,
  NodeReleaseChannel,
  NodeUpdateError,
  type NodeUpdateInput,
  type NodeUpdateRun,
  type NodeUpdateState,
  TrimmedNonEmptyString,
} from "@ryco/contracts";
import type { DesktopAppUpdateSnapshot } from "@ryco/shared/desktopResourceTelemetry";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { type DesktopAppUpdateBridge, desktopAppUpdateBridge } from "../desktopAppUpdateBridge.ts";
import { fetchNpmDistTagVersion } from "../npmRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  applyDesktopRemoteInstall,
  desktopLatestVersion,
  presentIsoTime,
  presentText,
} from "./desktopApp.ts";
import {
  type DetectedNodeInstallation,
  isNewerNodeRelease,
  nodeInstallCommand,
  nodeReleaseChannel,
  nodeUpdateAvailability,
  nodeUpdateCapability,
  nodeVerifyCommand,
  probeNodeInstallation,
  RYCO_CLI_PACKAGE,
} from "./installation.ts";
import {
  bootRunFromMarker,
  NODE_UPDATE_MARKER_FILE_NAME,
  type NodeUpdateMarker,
  readNodeUpdateMarker,
  removeNodeUpdateMarker,
  writeNodeUpdateMarker,
} from "./marker.ts";
import {
  commandOutputTail,
  commandSucceeded,
  describeCommandFailure,
  makeNodeUpdateCommandRunner,
  type NodeServiceRestart,
  type NodeUpdateCommandRunner,
  outputReportsVersion,
  restartThroughServiceManager,
} from "./processes.ts";

export interface NodeUpdateServiceShape {
  /** The node's update state now. */
  readonly current: Effect.Effect<NodeUpdateState>;
  /** The current state, then every change. Subscribing starts a check when the last is stale. */
  readonly changes: Stream.Stream<NodeUpdateState>;
  /** Looks for the newest release now: the npm registry, or the desktop app's feed. */
  readonly check: Effect.Effect<NodeUpdateState, NodeUpdateError>;
  /** Starts installing `targetVersion` and answers once it is under way. */
  readonly update: (input: NodeUpdateInput) => Effect.Effect<NodeUpdateState, NodeUpdateError>;
}

export class NodeUpdateService extends Context.Service<NodeUpdateService, NodeUpdateServiceShape>()(
  "ryco/nodeUpdate/NodeUpdateService",
) {}

/** What the service needs from the process and the machine; tests replace each part. */
export interface NodeUpdateRuntime {
  readonly packageVersion: string;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  /** Run once, on first use. */
  readonly detectInstallation: Effect.Effect<DetectedNodeInstallation>;
  readonly markerPath: string;
  /** Where the newest known release persists across restarts; `null` keeps it in memory. */
  readonly latestCachePath: string | null;
  /** The release a dist-tag points at, `null` when unknown; bounded by the caller. */
  readonly fetchLatestVersion: (channel: NodeReleaseChannel) => Effect.Effect<string | null>;
  /** Whether automatic (not explicit) checks may contact the registry. */
  readonly automaticChecksEnabled: Effect.Effect<boolean>;
  readonly runCommand: NodeUpdateCommandRunner;
  /** Ends this process through its service manager, which starts it again. */
  readonly restart: NodeServiceRestart;
  readonly desktop: DesktopAppUpdateBridge;
  /** Between publishing `restarting` and the restart, so subscribers receive it. */
  readonly restartDelay?: Duration.Input;
  /** How long a restart may take before the run reports that it did not happen. */
  readonly restartGrace?: Duration.Input;
}

export const NODE_LATEST_RELEASE_TTL = Duration.hours(1);
/** After a failed lookup, automatic checks wait this long; explicit checks do not. */
const FAILED_LOOKUP_RETRY_AFTER = Duration.minutes(5);
/** Beside the provider caches; the leading underscore keeps it apart from instance files. */
export const NODE_LATEST_RELEASE_CACHE_FILE_NAME = "_node-latest-release.json";

export const IDLE_NODE_UPDATE_RUN: NodeUpdateRun = {
  status: "idle",
  requestId: null,
  fromVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  restartAt: null,
  progressPercent: null,
  message: null,
  output: null,
};

const ACTIVE_RUN_STATUSES: ReadonlySet<NodeUpdateRun["status"]> = new Set([
  "preparing",
  "verifying",
  "waiting",
  "restarting",
]);

export const isActiveNodeUpdateRun = (run: NodeUpdateRun) => ACTIVE_RUN_STATUSES.has(run.status);

export interface NodeLatestRelease {
  readonly channel: NodeReleaseChannel;
  readonly version: string;
  readonly checkedAt: string;
}

/** The state clients see, from the installation and what the node currently knows. */
export function deriveNodeUpdateState(input: {
  readonly packageVersion: string;
  readonly platform: NodeJS.Platform;
  readonly installation: DetectedNodeInstallation;
  readonly latest: NodeLatestRelease | null;
  readonly desktop: DesktopAppUpdateSnapshot | null;
  readonly run: NodeUpdateRun;
}): NodeUpdateState {
  const { installation } = input;
  const desktopApp = installation.kind === "desktop-app";
  const desktop = desktopApp ? input.desktop : null;
  const currentVersion = presentText(desktop?.currentVersion) ?? input.packageVersion;
  const channel = desktop?.channel ?? nodeReleaseChannel(currentVersion);
  const latest = !desktopApp && input.latest?.channel === channel ? input.latest : null;
  const latestVersion = desktopApp
    ? desktop === null
      ? null
      : desktopLatestVersion(desktop)
    : (latest?.version ?? null);
  return {
    currentVersion,
    latestVersion,
    channel,
    availability: nodeUpdateAvailability(currentVersion, latestVersion),
    installation: { kind: installation.kind, service: installation.service },
    ...nodeUpdateCapability({ installation, platform: input.platform, channel, desktop }),
    checkedAt: desktopApp ? presentIsoTime(desktop?.checkedAt) : (latest?.checkedAt ?? null),
    run: input.run,
  };
}

const sameState = (left: NodeUpdateState, right: NodeUpdateState) =>
  JSON.stringify(left) === JSON.stringify(right);

const PersistedLatestRelease = Schema.fromJsonString(
  Schema.Struct({
    channel: NodeReleaseChannel,
    version: TrimmedNonEmptyString,
    checkedAt: IsoDateTime,
  }),
);
const decodePersistedLatestRelease = Schema.decodeUnknownEffect(PersistedLatestRelease);
const encodePersistedLatestRelease = Schema.encodeEffect(PersistedLatestRelease);

interface KnownLatestRelease extends NodeLatestRelease {
  readonly checkedAtMs: number;
}

interface NodeUpdateInternalState {
  readonly latest: KnownLatestRelease | null;
  readonly desktop: DesktopAppUpdateSnapshot | null;
  readonly run: NodeUpdateRun;
}

const DESKTOP_NOT_CONNECTED = "The desktop app is not connected to this node.";

const refuse = (reason: string) => Effect.fail(new NodeUpdateError({ reason }));

export const makeNodeUpdateService = Effect.fn("makeNodeUpdateService")(function* (
  runtime: NodeUpdateRuntime,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const io = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const installation = yield* Effect.cached(runtime.detectInstallation);
  const state = yield* SubscriptionRef.make<NodeUpdateInternalState>({
    latest: null,
    desktop: null,
    run: IDLE_NODE_UPDATE_RUN,
  });
  // Admits one update at a time: validation and the switch to `preparing` happen under it.
  const admission = yield* Semaphore.make(1);
  // One registry lookup at a time; callers that queued behind one share its answer.
  const lookupLock = yield* Semaphore.make(1);
  let completedLookups = 0;
  let lastFailedLookupMs: number | null = null;
  let automaticCheckRunning = false;
  const restartDelay = runtime.restartDelay ?? Duration.seconds(1);
  const restartGrace = runtime.restartGrace ?? Duration.minutes(2);
  const cliChannel = nodeReleaseChannel(runtime.packageVersion);
  const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());

  const toState = (detected: DetectedNodeInstallation, internal: NodeUpdateInternalState) =>
    deriveNodeUpdateState({
      packageVersion: runtime.packageVersion,
      platform: runtime.platform,
      installation: detected,
      latest: internal.latest,
      desktop: internal.desktop,
      run: internal.run,
    });

  const current = Effect.gen(function* () {
    const detected = yield* installation;
    return toState(detected, yield* SubscriptionRef.get(state));
  });

  const setRun = (run: NodeUpdateRun) =>
    SubscriptionRef.update(state, (internal) => ({ ...internal, run }));

  const finishFailed = (run: NodeUpdateRun, message: string, output: string | null) =>
    Effect.flatMap(nowIso, (finishedAt) =>
      setRun({ ...run, status: "failed", finishedAt, message, output }),
    );

  // ── Newest release (CLI nodes) ────────────────────────────────────────────

  const loadPersistedLatest = yield* Effect.cached(
    Effect.gen(function* () {
      if (runtime.latestCachePath === null) return;
      const raw = yield* io(fileSystem.readFileString(runtime.latestCachePath)).pipe(Effect.option);
      if (Option.isNone(raw)) return;
      const persisted = yield* decodePersistedLatestRelease(raw.value).pipe(Effect.option);
      if (Option.isNone(persisted) || persisted.value.channel !== cliChannel) return;
      const checkedAtMs = Date.parse(persisted.value.checkedAt);
      if (!Number.isFinite(checkedAtMs)) return;
      const latest: KnownLatestRelease = { ...persisted.value, checkedAtMs };
      yield* SubscriptionRef.update(state, (internal) =>
        internal.latest === null ? { ...internal, latest } : internal,
      );
    }).pipe(Effect.ignoreCause({ log: false })),
  );

  const persistLatest = (latest: KnownLatestRelease) =>
    runtime.latestCachePath === null
      ? Effect.void
      : encodePersistedLatestRelease({
          channel: latest.channel,
          version: latest.version,
          checkedAt: latest.checkedAt,
        }).pipe(
          Effect.flatMap((contents) =>
            io(writeFileStringAtomically({ filePath: runtime.latestCachePath!, contents })),
          ),
          Effect.ignoreCause({ log: false }),
        );

  /**
   * The newest release on this node's channel. `stale` answers from a cache younger than
   * the TTL; `fresh` asks the registry unless a lookup finished while this one waited.
   */
  const lookupLatest = (mode: "fresh" | "stale") =>
    Effect.suspend(() => {
      const lookupsBefore = completedLookups;
      return lookupLock.withPermit(
        Effect.gen(function* () {
          const known = (yield* SubscriptionRef.get(state)).latest;
          const nowMs = yield* Clock.currentTimeMillis;
          if (known !== null && known.channel === cliChannel) {
            if (completedLookups > lookupsBefore) return known.version;
            if (
              mode === "stale" &&
              nowMs - known.checkedAtMs < Duration.toMillis(NODE_LATEST_RELEASE_TTL)
            ) {
              return known.version;
            }
          }
          // An unreachable registry is not asked again on every reconnect.
          if (
            mode === "stale" &&
            lastFailedLookupMs !== null &&
            nowMs - lastFailedLookupMs < Duration.toMillis(FAILED_LOOKUP_RETRY_AFTER)
          ) {
            return known?.version ?? null;
          }
          const version = presentText(yield* runtime.fetchLatestVersion(cliChannel));
          if (version === null) {
            lastFailedLookupMs = nowMs;
            return null;
          }
          lastFailedLookupMs = null;
          const checkedAtMs = yield* Clock.currentTimeMillis;
          const latest: KnownLatestRelease = {
            channel: cliChannel,
            version,
            checkedAt: new Date(checkedAtMs).toISOString(),
            checkedAtMs,
          };
          completedLookups += 1;
          yield* SubscriptionRef.update(state, (internal) => ({ ...internal, latest }));
          yield* persistLatest(latest);
          return version;
        }),
      );
    });

  const automaticCheck = Effect.gen(function* () {
    const detected = yield* installation;
    if (detected.kind === "desktop-app") return;
    yield* loadPersistedLatest;
    if (!(yield* runtime.automaticChecksEnabled)) return;
    yield* lookupLatest("stale");
  }).pipe(
    Effect.ignoreCause({ log: false }),
    Effect.ensuring(
      Effect.sync(() => {
        automaticCheckRunning = false;
      }),
    ),
  );

  const startAutomaticCheck = Effect.suspend(() => {
    if (automaticCheckRunning) return Effect.void;
    automaticCheckRunning = true;
    return Effect.forkIn(automaticCheck, scope).pipe(Effect.asVoid);
  });

  // ── Desktop app reports ───────────────────────────────────────────────────

  const applyDesktopSnapshot = (snapshot: DesktopAppUpdateSnapshot) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const settled = yield* SubscriptionRef.modify(state, (internal) => {
        const run = applyDesktopRemoteInstall(internal.run, snapshot, now);
        return [
          run !== null && (run.status === "postponed" || run.status === "failed"),
          { ...internal, desktop: snapshot, run: run ?? internal.run },
        ] as const;
      });
      // A postponed or failed relaunch will not report back after a restart.
      if (settled) yield* io(removeNodeUpdateMarker(runtime.markerPath));
    });

  const followDesktopApp = Stream.callback<DesktopAppUpdateSnapshot>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = runtime.desktop.subscribe((snapshot) => {
            Queue.offerUnsafe(queue, snapshot);
          });
          const latest = runtime.desktop.current();
          if (latest !== null) Queue.offerUnsafe(queue, latest);
          return unsubscribe;
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    { bufferSize: 64, strategy: "sliding" },
  ).pipe(Stream.runForEach(applyDesktopSnapshot));

  // ── Boot ──────────────────────────────────────────────────────────────────

  /** Reports the update this process was restarted for, once; an update waits for it. */
  const settleBootMarker = yield* Effect.cached(
    Effect.gen(function* () {
      const marker = yield* io(readNodeUpdateMarker(runtime.markerPath));
      if (Option.isNone(marker)) return;
      yield* io(removeNodeUpdateMarker(runtime.markerPath));
      const run = bootRunFromMarker({
        marker: marker.value,
        runningVersion: runtime.packageVersion,
        nowMs: yield* Clock.currentTimeMillis,
      });
      if (run === null) return;
      yield* SubscriptionRef.update(state, (internal) =>
        internal.run.status === "idle" ? { ...internal, run } : internal,
      );
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  yield* Effect.gen(function* () {
    const detected = yield* installation;
    yield* settleBootMarker;
    if (detected.kind === "desktop-app") {
      yield* followDesktopApp;
    } else {
      yield* loadPersistedLatest;
    }
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

  // ── Updates ───────────────────────────────────────────────────────────────

  const reinstall = (detected: DetectedNodeInstallation, version: string) =>
    Effect.gen(function* () {
      const command = nodeInstallCommand(detected, version, runtime.execPath);
      if (command === null) return `${version} could not be reinstalled.`;
      const result = yield* runtime.runCommand(command);
      return commandSucceeded(result)
        ? `Reinstalled ${version}.`
        : `Reinstalling ${version} failed too; update it on that machine.`;
    });

  const runCliUpdate = (
    detected: DetectedNodeInstallation,
    run: NodeUpdateRun,
    marker: NodeUpdateMarker,
  ) =>
    Effect.gen(function* () {
      const target = marker.targetVersion;
      const install = nodeInstallCommand(detected, target, runtime.execPath);
      const verify = nodeVerifyCommand(detected, runtime.execPath);
      if (
        install === null ||
        verify === null ||
        detected.service === null ||
        !detected.serviceLabel
      ) {
        return yield* finishFailed(run, "This installation cannot be updated from here.", null);
      }
      const installed = yield* runtime.runCommand(install);
      if (!commandSucceeded(installed)) {
        const rollback = yield* reinstall(detected, marker.fromVersion);
        return yield* finishFailed(
          run,
          `${describeCommandFailure(install, installed, `installing ${target}`)} ${rollback}`,
          commandOutputTail(installed),
        );
      }

      yield* setRun({ ...run, status: "verifying" });
      const verified = yield* runtime.runCommand(verify);
      if (
        !commandSucceeded(verified) ||
        !outputReportsVersion(`${verified.stdout}\n${verified.stderr}`, target)
      ) {
        const rollback = yield* reinstall(detected, marker.fromVersion);
        const reason = commandSucceeded(verified)
          ? `The installed release did not report ${target}.`
          : describeCommandFailure(verify, verified, `checking ${target}`);
        return yield* finishFailed(run, `${reason} ${rollback}`, commandOutputTail(verified));
      }

      // Without the marker the restarted node cannot report back, but it still runs the target.
      yield* io(writeNodeUpdateMarker(runtime.markerPath, marker)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("node update marker could not be written", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      yield* setRun({ ...run, status: "restarting" });
      yield* Effect.sleep(restartDelay);
      yield* runtime.restart({ manager: detected.service, label: detected.serviceLabel });
      yield* Effect.sleep(restartGrace);
      // Still running: the service manager did not restart this process. The marker stays,
      // so the next start reports the release it comes back on.
      yield* finishFailed(
        run,
        `Ryco ${target} is installed, but the node did not restart. Restart it to finish.`,
        null,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("node update failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.andThen(finishFailed(run, "The update stopped unexpectedly.", null)),
            ),
      ),
    );

  const startDesktopUpdate = (run: NodeUpdateRun, marker: NodeUpdateMarker) =>
    Effect.gen(function* () {
      yield* io(writeNodeUpdateMarker(runtime.markerPath, marker)).pipe(
        Effect.catchCause(() => refuse("Could not record the update request on this node.")),
      );
      yield* setRun(run);
      const sent = runtime.desktop.request({
        type: "app-update-install",
        requestId: marker.requestId,
        targetVersion: marker.targetVersion,
      });
      if (sent) return;
      yield* io(removeNodeUpdateMarker(runtime.markerPath));
      yield* finishFailed(run, DESKTOP_NOT_CONNECTED, null);
      return yield* refuse(DESKTOP_NOT_CONNECTED);
    });

  const update = (input: NodeUpdateInput) =>
    Effect.gen(function* () {
      yield* settleBootMarker;
      const detected = yield* installation;
      const desktopApp = detected.kind === "desktop-app";
      return yield* admission.withPermit(
        Effect.gen(function* () {
          const before = yield* current;
          if (!before.canUpdate) {
            return yield* refuse(before.manualReason ?? "This node cannot update itself.");
          }
          if (isActiveNodeUpdateRun(before.run)) {
            return yield* refuse("An update is already running on this node.");
          }
          // The registry again, not the cache: a release published since the client looked
          // must not be installed unseen. The desktop app checks its target itself.
          const latest = desktopApp ? before.latestVersion : yield* lookupLatest("fresh");
          if (latest === null) {
            return yield* refuse(
              desktopApp
                ? "The desktop app has not found a release to install."
                : "Could not confirm the newest release with the npm registry. Try again.",
            );
          }
          if (input.targetVersion !== latest) {
            return yield* refuse(
              `The newest release is ${latest} now, not ${input.targetVersion}. Review it and try again.`,
            );
          }
          if (!isNewerNodeRelease(latest, before.currentVersion)) {
            return yield* refuse(`This node already runs ${before.currentVersion}.`);
          }
          const startedAt = yield* nowIso;
          const marker: NodeUpdateMarker = {
            requestId: input.requestId,
            fromVersion: before.currentVersion,
            targetVersion: latest,
            startedAt,
          };
          const run: NodeUpdateRun = {
            ...IDLE_NODE_UPDATE_RUN,
            status: "preparing",
            requestId: marker.requestId,
            fromVersion: marker.fromVersion,
            targetVersion: marker.targetVersion,
            startedAt,
          };
          if (desktopApp) {
            yield* startDesktopUpdate(run, marker);
          } else {
            yield* setRun(run);
            yield* Effect.forkIn(runCliUpdate(detected, run, marker), scope);
          }
          return yield* current;
        }),
      );
    });

  const check = Effect.gen(function* () {
    const detected = yield* installation;
    if (detected.kind === "desktop-app") {
      // The app answers with a new report; the state follows it.
      runtime.desktop.request({ type: "app-update-check" });
      return yield* current;
    }
    yield* loadPersistedLatest;
    const version = yield* lookupLatest("fresh");
    if (version === null) {
      return yield* refuse("Could not reach the npm registry to look for a newer Ryco.");
    }
    return yield* current;
  });

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const detected = yield* installation;
      yield* startAutomaticCheck;
      return SubscriptionRef.changes(state).pipe(
        Stream.map((internal) => toState(detected, internal)),
        Stream.changesWith(sameState),
      );
    }),
  );

  return { current, changes, check, update } satisfies NodeUpdateServiceShape;
});

export const NodeUpdateServiceLive = Layer.effect(
  NodeUpdateService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* makeNodeUpdateService({
      packageVersion: packageJson.version,
      platform: process.platform,
      execPath: process.execPath,
      detectInstallation: probeNodeInstallation({
        mode: config.mode,
        argv1: process.argv[1],
        platform: process.platform,
        serviceLabel: process.env.RYCO_SERVICE_LABEL,
        parentPid: process.ppid,
        temporaryDirectory: os.tmpdir(),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      markerPath: path.join(config.stateDir, NODE_UPDATE_MARKER_FILE_NAME),
      latestCachePath: path.join(
        config.providerStatusCacheDir,
        NODE_LATEST_RELEASE_CACHE_FILE_NAME,
      ),
      fetchLatestVersion: (channel) =>
        fetchNpmDistTagVersion(RYCO_CLI_PACKAGE, channel).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      automaticChecksEnabled: settings.getSettings.pipe(
        Effect.map((value) => value.enableProviderUpdateChecks),
        Effect.orElseSucceed(() => true),
      ),
      runCommand: makeNodeUpdateCommandRunner(spawner),
      restart: restartThroughServiceManager,
      desktop: desktopAppUpdateBridge,
    });
  }),
);
