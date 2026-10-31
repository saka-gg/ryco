/**
 * NodeUpdateService - This node's own Ryco release: which one it runs, the newest on its
 * channel, and the one-click update that installs that release and restarts the node.
 *
 * - CLI nodes (`ryco service` installs from npm, bun or pnpm) install the exact release
 *   into their own installation and check it: its preflight loads its whole server graph
 *   and migrates a copy of the database (preflight.ts; `--version` for a release that
 *   predates it). Then they snapshot the database, leave a marker that says how to undo
 *   the update, and let their service manager restart them. A failed install, check or
 *   snapshot reinstalls the previous release. The restarted process confirms the update
 *   once it is ready (cliUpdate.ts) and reports it from the marker; one that keeps
 *   failing to start is rolled back before it boots (bootGuard.ts), and the previous
 *   release reports that instead. The installs hold the host-wide install lock under the
 *   installation's own key, the one a provider CLI update into the same install takes.
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
  Deferred,
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
import { makeRuntimeSqliteLayer } from "../persistence/Layers/Sqlite.ts";
import type { ProviderInstallLockRuntime } from "../provider/providerInstallLock.ts";
import { ProviderInstallLock } from "../provider/Services/ProviderInstallLock.ts";
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
  nodeInstallLockKey,
  nodeReleaseChannel,
  nodeUpdateAvailability,
  nodeUpdateCapability,
  probeNodeInstallation,
  RYCO_CLI_PACKAGE,
} from "./installation.ts";
import {
  bootRunFromMarker,
  markerAwaitsBootReady,
  type NodeUpdateMarker,
  readNodeUpdateMarker,
  removeNodeUpdateMarker,
  writeNodeUpdateMarker,
} from "./marker.ts";
import type { NodeBootReadiness } from "./cliUpdate.ts";
import type { NodeServiceRestart, NodeUpdateCommandRunner } from "./processes.ts";
import {
  disarmNodeBootWatchdog,
  NODE_UPDATE_DIRECTORY_NAME,
  NODE_UPDATE_MARKER_FILE_NAME,
  nodeUpdateNextStartRollsBack,
} from "./updateProtocol.ts";

export interface NodeUpdateServiceShape {
  /** The node's update state now. */
  readonly current: Effect.Effect<NodeUpdateState>;
  /** The current state, then every change. Subscribing starts a check when the last is stale. */
  readonly changes: Stream.Stream<NodeUpdateState>;
  /** Looks for the newest release now: the npm registry, or the desktop app's feed. */
  readonly check: Effect.Effect<NodeUpdateState, NodeUpdateError>;
  /** Starts installing `targetVersion` and answers once it is under way. */
  readonly update: (
    input: NodeUpdateInput,
    options?: NodeUpdateOptions,
  ) => Effect.Effect<NodeUpdateState, NodeUpdateError>;
  /**
   * Whether this process was restarted into an update it has yet to confirm. The server then
   * waits until it is ready (`confirmNodeUpdateAfterServe`) and calls {@link confirmBootReady}.
   */
  readonly awaitsBootReady: Effect.Effect<boolean>;
  /** {@link awaitsBootReady}, for an update the node ran on its own (the marker's `unattended`). */
  readonly awaitsUnattendedBootReady: Effect.Effect<boolean>;
  /** This process is ready: the update it was restarted into succeeded. */
  readonly confirmBootReady: Effect.Effect<void>;
  /**
   * The host-wide install lock key of this installation (`nodeInstallLockKey`), which its updates
   * hold: an unattended caller takes it itself (`UnattendedNodeUpdate`). `null` when it has none.
   */
  readonly installLockKey: Effect.Effect<string | null>;
  /** What the node's own unattended updates tell its owner (`automaticUpdateNote`); `null` clears. */
  readonly setAutomaticUpdateNote: (note: string | null) => Effect.Effect<void>;
}

export class NodeUpdateService extends Context.Service<NodeUpdateService, NodeUpdateServiceShape>()(
  "ryco/nodeUpdate/NodeUpdateService",
) {}

/**
 * An update nobody asked for: the node updates itself (`nodeAutoUpdater.ts`). The marker records
 * it. CLI nodes installed with npm, or pnpm 10.16 or later, only (`unattendedInstallRefusal`).
 */
export interface UnattendedNodeUpdate {
  /**
   * Asked once the release is installed and checked, and again once the restart is recorded:
   * `false` puts the previous release back and the run ends `postponed`.
   */
  readonly beforeRestart: Effect.Effect<boolean>;
  /**
   * Whether a restart would cut nobody off now (the update window alone, whatever the setting),
   * for a node that has to restart into the release because the previous one could not go back.
   */
  readonly restartWindow: Effect.Effect<boolean>;
  /**
   * The caller holds this installation's install lock (`installLockKey`) for the whole run;
   * each installer records its pid with it.
   */
  readonly recordInstallerPid: (pid: number) => Effect.Effect<void, Error>;
  /** Dependency releases younger than this stay out of the install (`NodeInstallHoldBack`). */
  readonly minimumReleaseAge: Duration.Input;
}

/** Server-side only, never on the wire: what a client's update cannot ask for. */
export interface NodeUpdateOptions {
  readonly unattended?: UnattendedNodeUpdate;
}

/** What the service needs from the process and the machine; tests replace each part. */
export interface NodeUpdateRuntime {
  readonly packageVersion: string;
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  /** Run once, on first use. */
  readonly detectInstallation: Effect.Effect<DetectedNodeInstallation>;
  readonly markerPath: string;
  /** This node's database, which the preflight copies and the restart snapshots. */
  readonly databasePath: string;
  /** Where updates keep the preflight copy, the snapshot, and a rolled-back database. */
  readonly updateDirectory: string;
  /** A consistent copy of the live database at `destination`, replacing it. */
  readonly copyDatabase: (destination: string) => Effect.Effect<void, NodeUpdateError>;
  /** Where the newest known release persists across restarts; `null` keeps it in memory. */
  readonly latestCachePath: string | null;
  /** The release a dist-tag points at, `null` when unknown; bounded by the caller. */
  readonly fetchLatestVersion: (channel: NodeReleaseChannel) => Effect.Effect<string | null>;
  /** Whether automatic (not explicit) checks may contact the registry. */
  readonly automaticChecksEnabled: Effect.Effect<boolean>;
  readonly runCommand: NodeUpdateCommandRunner;
  /**
   * The host-wide install lock (`ProviderInstallLock`), loaded on first use: a person's update
   * holds its installation's key, waiting while another Ryco on this machine holds it.
   */
  readonly installLock: Effect.Effect<Pick<ProviderInstallLockRuntime, "runWhenFree">>;
  /** Ends this process through its service manager, which starts it again. */
  readonly restart: NodeServiceRestart;
  readonly desktop: DesktopAppUpdateBridge;
  /** Between publishing `restarting` and the restart, so subscribers receive it. */
  readonly restartDelay?: Duration.Input;
  /** How long a restart may take before the run reports that it did not happen. */
  readonly restartGrace?: Duration.Input;
  /** How often a node that has to restart into an installed release asks its window again. */
  readonly restartRecheck?: Duration.Input;
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
  readonly automaticUpdateNote?: string | null;
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
    ...(input.automaticUpdateNote ? { automaticUpdateNote: input.automaticUpdateNote } : {}),
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
  readonly automaticUpdateNote: string | null;
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
    automaticUpdateNote: null,
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
  const restartRecheck = runtime.restartRecheck ?? Duration.minutes(1);
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
      automaticUpdateNote: internal.automaticUpdateNote,
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
  const finishPostponed = (run: NodeUpdateRun, message: string) =>
    Effect.flatMap(nowIso, (finishedAt) =>
      setRun({ ...run, status: "postponed", finishedAt, message, output: null }),
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

  const bootReady = yield* Deferred.make<void>();
  let bootConfirmationPending = false;
  let bootConfirmationUnattended = false;

  /**
   * Once the server is ready: records `readyAt`, so the boot guard stops counting starts even
   * if the marker then cannot be deleted, then reports the update as succeeded and forgets it.
   */
  const confirmBoot = (marker: NodeUpdateMarker) =>
    Effect.gen(function* () {
      yield* Deferred.await(bootReady);
      const readyAt = yield* nowIso;
      yield* io(writeNodeUpdateMarker(runtime.markerPath, { ...marker, readyAt })).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("node update marker could not be marked ready", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
      const run = bootRunFromMarker({
        marker,
        runningVersion: runtime.packageVersion,
        nowMs: yield* Clock.currentTimeMillis,
      });
      yield* io(removeNodeUpdateMarker(runtime.markerPath));
      if (run === null) return;
      yield* SubscriptionRef.update(state, (internal) =>
        internal.run.status === "restarting" && internal.run.requestId === marker.requestId
          ? { ...internal, run }
          : internal,
      );
    }).pipe(Effect.ignoreCause({ log: true }));

  /** Reports the update this process was restarted for, once; an update waits for it. */
  const settleBootMarker = yield* Effect.cached(
    Effect.gen(function* () {
      const marker = yield* io(readNodeUpdateMarker(runtime.markerPath));
      if (Option.isNone(marker)) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        markerAwaitsBootReady({
          marker: marker.value,
          runningVersion: runtime.packageVersion,
          nowMs,
        })
      ) {
        // Still `restarting` until the node is ready, which also keeps another update out.
        bootConfirmationPending = true;
        // Exiting helps only while the next start still rolls back: past that the boot guard
        // lets the release start anyway, and an exit would only restart it again and again.
        bootConfirmationUnattended =
          marker.value.unattended === true &&
          nodeUpdateNextStartRollsBack(marker.value.bootAttempts ?? 0);
        const pending: NodeUpdateRun = {
          ...IDLE_NODE_UPDATE_RUN,
          status: "restarting",
          requestId: marker.value.requestId,
          fromVersion: marker.value.fromVersion,
          targetVersion: marker.value.targetVersion,
          startedAt: marker.value.startedAt,
        };
        yield* SubscriptionRef.update(state, (internal) =>
          internal.run.status === "idle" ? { ...internal, run: pending } : internal,
        );
        yield* Effect.forkIn(confirmBoot(marker.value), scope);
        return;
      }
      yield* io(removeNodeUpdateMarker(runtime.markerPath));
      const run = bootRunFromMarker({
        marker: marker.value,
        runningVersion: runtime.packageVersion,
        nowMs,
      });
      if (run === null) return;
      yield* SubscriptionRef.update(state, (internal) =>
        internal.run.status === "idle" ? { ...internal, run } : internal,
      );
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const awaitsBootReady = Effect.map(settleBootMarker, () => bootConfirmationPending);
  const awaitsUnattendedBootReady = Effect.map(
    settleBootMarker,
    () => bootConfirmationPending && bootConfirmationUnattended,
  );
  const confirmBootReady = Deferred.succeed(bootReady, undefined).pipe(
    Effect.andThen(Effect.sync(disarmNodeBootWatchdog)),
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

  /** The CLI update loads with the first update (cliUpdate.ts), not with every boot. */
  const runCliUpdate = (
    detected: DetectedNodeInstallation,
    run: NodeUpdateRun,
    marker: NodeUpdateMarker,
    options: NodeUpdateOptions | undefined,
  ) =>
    Effect.tryPromise(() => import("./cliUpdate.ts")).pipe(
      Effect.flatMap(({ runCliNodeUpdate }) =>
        io(
          runCliNodeUpdate({
            runtime,
            detected,
            run,
            marker,
            setRun,
            finishFailed,
            finishPostponed,
            restartDelay,
            restartGrace,
            restartRecheck,
            ...(options?.unattended ? { unattended: options.unattended } : {}),
          }),
        ),
      ),
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

  const update = (input: NodeUpdateInput, options?: NodeUpdateOptions) =>
    Effect.gen(function* () {
      yield* settleBootMarker;
      const detected = yield* installation;
      const desktopApp = detected.kind === "desktop-app";
      if (desktopApp && options?.unattended) {
        return yield* refuse("The desktop app does not update itself unattended.");
      }
      if (options?.unattended) {
        // Loaded only for an update nobody asked for; pnpm's version is asked each time.
        const refusal = yield* Effect.promise(() => import("./cliUpdate.ts")).pipe(
          Effect.flatMap(({ unattendedInstallRefusal }) =>
            unattendedInstallRefusal(detected, runtime.runCommand),
          ),
        );
        if (refusal !== null) return yield* refuse(refusal);
      }
      return yield* admission.withPermit(
        Effect.gen(function* () {
          const before = yield* current;
          if (!before.canUpdate) {
            return yield* refuse(before.manualReason ?? "This node cannot update itself.");
          }
          if (isActiveNodeUpdateRun(before.run)) {
            return yield* refuse("An update is already running on this node.");
          }
          const otherChannel =
            input.channel !== undefined && input.channel !== cliChannel ? input.channel : null;
          if (otherChannel !== null && desktopApp) {
            return yield* refuse(
              "The desktop app follows its own channel: Ryco Nightly is a separate app.",
            );
          }
          // The registry again, not the cache: a release published since the client looked
          // must not be installed unseen. The desktop app checks its target itself.
          const latest = desktopApp
            ? before.latestVersion
            : otherChannel === null
              ? yield* lookupLatest("fresh")
              : presentText(yield* runtime.fetchLatestVersion(otherChannel));
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
            return yield* refuse(
              otherChannel === null
                ? `This node already runs ${before.currentVersion}.`
                : `The newest ${otherChannel} release, ${latest}, is not newer than ${before.currentVersion}. A channel switch never downgrades: switch again after that channel's next release.`,
            );
          }
          const startedAt = yield* nowIso;
          const marker: NodeUpdateMarker = {
            requestId: input.requestId,
            fromVersion: before.currentVersion,
            targetVersion: latest,
            startedAt,
            ...(options?.unattended ? { unattended: true } : {}),
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
            yield* Effect.forkIn(runCliUpdate(detected, run, marker, options), scope);
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

  return {
    current,
    changes,
    check,
    update,
    awaitsBootReady,
    awaitsUnattendedBootReady,
    confirmBootReady,
    installLockKey: Effect.map(installation, nodeInstallLockKey),
    setAutomaticUpdateNote: (note) =>
      SubscriptionRef.update(state, (internal) =>
        internal.automaticUpdateNote === note
          ? internal
          : { ...internal, automaticUpdateNote: note },
      ),
  } satisfies NodeUpdateServiceShape;
});

const exitThisProcess = (code: number) =>
  Effect.sync(() => {
    process.exit(code);
  });

/**
 * Run once request handlers are attached (server.ts), in the background: confirms the update
 * this process was restarted into, if any, once the node is ready (cliUpdate.ts, loaded only
 * then). After an update the node ran on its own, a release that is not ready in time exits
 * (`awaitNodeReadyOrExit`), so its service manager starts it again and the boot guard counts it.
 */
export const confirmNodeUpdateAfterServe = (
  readiness: NodeBootReadiness,
  exitProcess: (code: number) => Effect.Effect<void> = exitThisProcess,
) =>
  Effect.gen(function* () {
    const nodeUpdate = yield* NodeUpdateService;
    const unattended = yield* nodeUpdate.awaitsUnattendedBootReady;
    // The boot guard's watchdog (armed at process start) ends only a start this process still
    // has to confirm after an unattended update; any other start keeps running.
    if (!unattended) disarmNodeBootWatchdog();
    if (!(yield* nodeUpdate.awaitsBootReady)) return;
    const { awaitNodeReadyAfterUpdate, awaitNodeReadyOrExit } = yield* Effect.promise(
      () => import("./cliUpdate.ts"),
    );
    yield* unattended
      ? awaitNodeReadyOrExit(readiness, exitProcess)
      : awaitNodeReadyAfterUpdate(readiness);
    yield* nodeUpdate.confirmBootReady;
  }).pipe(Effect.ignoreCause({ log: true }));

export const NodeUpdateServiceLive = Layer.effect(
  NodeUpdateService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const installLock = yield* ProviderInstallLock;
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
        pid: process.pid,
        parentPid: process.ppid,
        systemdExecPid: process.env.SYSTEMD_EXEC_PID,
        temporaryDirectory: os.tmpdir(),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
      markerPath: path.join(config.stateDir, NODE_UPDATE_MARKER_FILE_NAME),
      databasePath: config.dbPath,
      updateDirectory: path.join(config.stateDir, NODE_UPDATE_DIRECTORY_NAME),
      copyDatabase: (destination) =>
        // The copy code loads with the first update, not with every boot.
        Effect.tryPromise(() => import("../persistence/databaseBackups.ts")).pipe(
          Effect.flatMap(({ copyLiveDatabase }) =>
            copyLiveDatabase({
              dbPath: config.dbPath,
              destination,
              openSqlite: makeRuntimeSqliteLayer,
            }),
          ),
          Effect.asVoid,
          Effect.mapError((error) => new NodeUpdateError({ reason: error.message })),
        ),
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
      // The update's child processes (processes.ts, through cliUpdate.ts) load with the first
      // update.
      runCommand: (command, onSpawned) =>
        Effect.promise(() => import("./cliUpdate.ts")).pipe(
          Effect.flatMap(({ makeNodeUpdateCommandRunner }) =>
            makeNodeUpdateCommandRunner(spawner)(command, onSpawned),
          ),
        ),
      restart: (target) =>
        Effect.promise(() => import("./cliUpdate.ts")).pipe(
          Effect.flatMap(({ restartThroughServiceManager }) =>
            restartThroughServiceManager(target),
          ),
        ),
      installLock: installLock.lock,
      desktop: desktopAppUpdateBridge,
    });
  }),
);
