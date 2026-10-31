/**
 * nodeAutoUpdater - a CLI service node installs Ryco's newest release on its own while nobody
 * uses it.
 *
 * Loaded with unattended updates (`unattendedUpdates.ts`), never on boot, and it acts only on a
 * global npm, bun or pnpm install that runs under a service manager and can update itself
 * ({@link canUpdateUnattended}): never the desktop app, `npx`/`bunx`, a source checkout, an
 * unknown install or a node in the foreground. Dev servers never load it.
 *
 * The first pass runs {@link FIRST_PASS_DELAY} after unattended updates start, then one every
 * {@link WINDOW_RECHECK}, and does nothing unless `automaticUpdates` and update checks are on. It
 * asks the registry for the newest release ({@link NodeUpdateServiceShape.check}) at most every
 * {@link RELEASE_CHECK_INTERVAL} (the service's own cache lifetime). Once a newer release on the
 * node's own channel is known, it waits for the update window in restart mode (5 quiet minutes,
 * no agent work, terminals or restart-sensitive work: `updateWindow.ts`), for the release to be
 * {@link MINIMUM_RELEASE_AGE} old by the registry's publish time, and then runs the same update a
 * person runs (`NodeUpdateService.update`: admission, a fresh registry check, the install, the
 * preflight, the snapshot, the marker and the boot guard), marked unattended. It holds the
 * host-wide install lock meanwhile, so no Ryco on this machine installs a provider CLI under it.
 *
 * Right before the restart the window is asked again; a closed one puts the previous release back
 * and postpones the update for {@link POSTPONED_RETRY_AFTER}. A release is recorded as skipped
 * before anything is installed and taken off only when nothing changed (`nodeAutoSkip.ts`), so
 * one that failed or was rolled back is never tried unattended again.
 *
 * Port of T3 Code's unmerged `ServerAutoUpdater` (pingdotgg/t3code#17586) and its numbers.
 *
 * @module nodeAutoUpdater
 */
import type {
  NodeInstallationKind,
  NodeReleaseChannel,
  NodeUpdateRun,
  NodeUpdateState,
} from "@ryco/contracts";
import { Cause, Clock, Duration, Effect, Option, Result, Schedule, Stream } from "effect";

import type { NodeUpdateServiceShape } from "../nodeUpdate/NodeUpdateService.ts";
import { MINIMUM_RELEASE_AGE } from "../provider/providerReleaseAge.ts";
import type { ProviderInstallLockShape } from "../provider/Services/ProviderInstallLock.ts";
import type { NodeAutoSkipList } from "./nodeAutoSkip.ts";
import type { UpdateWindow } from "./updateWindow.ts";

export const FIRST_PASS_DELAY = Duration.minutes(2);
/** How often a known newer release checks the update window again. */
export const WINDOW_RECHECK = Duration.minutes(1);
/** The registry is asked at most this often: `NodeUpdateService`'s cache lifetime. */
export const RELEASE_CHECK_INTERVAL = Duration.hours(1);
/**
 * After a postponed update (someone came back while the release installed), the next try waits
 * this long: each try installs the release and puts the previous one back.
 */
export const POSTPONED_RETRY_AFTER = Duration.hours(1);
/** The longest a started update is followed before it counts as failed. */
export const UPDATE_OUTCOME_TIMEOUT = Duration.minutes(30);
/** The host-wide install lock an unattended node update holds (`ProviderInstallLock`). */
export const NODE_SELF_UPDATE_LOCK_KEY = "ryco-node-self-update";

const RELEASE_CHECK_INTERVAL_NANOS = Duration.toNanosUnsafe(RELEASE_CHECK_INTERVAL);
const POSTPONED_RETRY_AFTER_NANOS = Duration.toNanosUnsafe(POSTPONED_RETRY_AFTER);
const MINIMUM_RELEASE_AGE_MS = Duration.toMillis(MINIMUM_RELEASE_AGE);

/** Installations that replace their own release and come back through a service manager. */
const SELF_UPDATING_KINDS: ReadonlySet<NodeInstallationKind> = new Set([
  "npm-global",
  "bun-global",
  "pnpm-global",
]);

const SETTLED_RUN_STATUSES: ReadonlySet<NodeUpdateRun["status"]> = new Set([
  "succeeded",
  "failed",
  "postponed",
]);

/** Whether this node may update Ryco itself unattended at all. */
export function canUpdateUnattended(state: NodeUpdateState): boolean {
  return (
    state.canUpdate &&
    state.installation.service !== null &&
    SELF_UPDATING_KINDS.has(state.installation.kind)
  );
}

export interface NodeAutoUpdaterSources {
  /** `automaticUpdates` and update checks are both on; false when unreadable. */
  readonly enabled: Effect.Effect<boolean>;
  readonly window: UpdateWindow;
  readonly nodeUpdate: Pick<NodeUpdateServiceShape, "current" | "check" | "update" | "changes">;
  readonly installLock: Pick<ProviderInstallLockShape, "lock">;
  readonly skipped: NodeAutoSkipList;
  /** When `version` of Ryco was published (epoch ms), `null` when the registry does not say. */
  readonly publishedAt: (version: string) => Effect.Effect<number | null>;
  /** The release channel `version` belongs to (`nodeReleaseChannel`). */
  readonly releaseChannelOf: (version: string) => NodeReleaseChannel;
  /** Whether `run` is still under way (`isActiveNodeUpdateRun`). */
  readonly isActiveRun: (run: NodeUpdateRun) => boolean;
}

/** Tells an update the node ran on its own from one a client asked for, in logs and the run. */
const newRequestId = Effect.sync(() => `auto-${crypto.randomUUID()}`);

export function makeNodeAutoUpdater(sources: NodeAutoUpdaterSources) {
  let nextReleaseCheckAt: bigint | null = null;
  // Monotonic: when a postponed release, or one the registry did not date, is due again.
  const notBefore = new Map<string, bigint>();
  const isWindowOpen = (heldLockKey?: string) =>
    Effect.gen(function* () {
      if (!(yield* sources.enabled)) return false;
      return yield* sources.window.isOpen({
        restart: true,
        ...(heldLockKey === undefined ? {} : { heldLockKey }),
      });
    });

  /** The release to install now, or undefined. */
  const due = Effect.gen(function* () {
    const now = yield* Clock.monotonicTimeNanos;
    if (nextReleaseCheckAt === null || now >= nextReleaseCheckAt) {
      nextReleaseCheckAt = now + RELEASE_CHECK_INTERVAL_NANOS;
      // An unreachable registry leaves what the node knew; the next hour asks again.
      yield* Effect.ignore(sources.nodeUpdate.check);
    }
    const state = yield* sources.nodeUpdate.current;
    const target = state.latestVersion;
    if (
      target === null ||
      !canUpdateUnattended(state) ||
      sources.isActiveRun(state.run) ||
      // Newer than the running release (`behind_latest` never holds for a downgrade), on its
      // own channel.
      state.availability !== "behind_latest" ||
      sources.releaseChannelOf(target) !== state.channel
    ) {
      return undefined;
    }
    const waitUntil = notBefore.get(target);
    if (waitUntil !== undefined && now < waitUntil) return undefined;
    if (yield* sources.skipped.has(target)) return undefined;
    // Cheapest first: the window before the registry's publish time.
    if (!(yield* isWindowOpen())) return undefined;
    const publishedAt = yield* sources.publishedAt(target);
    if (publishedAt === null) {
      notBefore.set(target, now + RELEASE_CHECK_INTERVAL_NANOS);
      return undefined;
    }
    if ((yield* Clock.currentTimeMillis) - publishedAt < MINIMUM_RELEASE_AGE_MS) return undefined;
    return target;
  });

  /** How the run `id` ended, `None` when it did not report in time. */
  const outcomeOf = (id: string) =>
    sources.nodeUpdate.changes.pipe(
      Stream.map((state) => state.run),
      Stream.filter((run) => run.requestId === id && SETTLED_RUN_STATUSES.has(run.status)),
      Stream.runHead,
      Effect.timeoutOption(UPDATE_OUTCOME_TIMEOUT),
      Effect.map(Option.flatten),
    );

  /** Under the install lock: the window once more, then the update a person would run. */
  const install = Effect.fn("NodeAutoUpdater.install")(function* (targetVersion: string) {
    if (!(yield* isWindowOpen(NODE_SELF_UPDATE_LOCK_KEY))) return;
    // Before anything is installed: a failure, a rollback or a crash from here on keeps it.
    yield* sources.skipped.add(targetVersion);
    const id = yield* newRequestId;
    yield* Effect.logInfo("Updating Ryco automatically", { targetVersion, requestId: id });
    const started = yield* Effect.result(
      sources.nodeUpdate.update(
        { requestId: id, targetVersion },
        { unattended: { beforeRestart: isWindowOpen(NODE_SELF_UPDATE_LOCK_KEY) } },
      ),
    );
    if (Result.isFailure(started)) {
      // Refused before anything ran (another update, a newer release meanwhile).
      yield* sources.skipped.remove(targetVersion);
      return yield* Effect.logInfo("Automatic Ryco update did not start", {
        targetVersion,
        reason: started.failure.reason,
      });
    }
    // A successful run never reports here: the restart ends this process.
    const outcome = yield* outcomeOf(id);
    if (Option.isSome(outcome) && outcome.value.status === "postponed") {
      yield* sources.skipped.remove(targetVersion);
      notBefore.set(targetVersion, (yield* Clock.monotonicTimeNanos) + POSTPONED_RETRY_AFTER_NANOS);
      return yield* Effect.logInfo("Automatic Ryco update postponed", {
        targetVersion,
        message: outcome.value.message,
      });
    }
    yield* Effect.logWarning("Automatic Ryco update failed; this release is not tried again", {
      targetVersion,
      status: Option.isSome(outcome) ? outcome.value.status : "no-report",
      message: Option.isSome(outcome) ? outcome.value.message : null,
    });
  });

  /** One pass; it never fails, so the schedule keeps running. */
  const pass = Effect.gen(function* () {
    if (!(yield* sources.enabled)) return;
    const target = yield* due;
    if (target === undefined) return;
    const lock = yield* sources.installLock.lock;
    // Held elsewhere: another Ryco on this machine installs something; the next pass tries again.
    yield* lock.tryRun(NODE_SELF_UPDATE_LOCK_KEY, () => install(target));
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Automatic Ryco update pass failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("updates.NodeAutoUpdater.pass"),
  );

  return {
    pass,
    /**
     * Nothing on an installation that cannot update itself unattended; otherwise the first pass
     * after {@link FIRST_PASS_DELAY}, then one every {@link WINDOW_RECHECK}.
     */
    run: Effect.gen(function* () {
      const state = yield* sources.nodeUpdate.current;
      if (!canUpdateUnattended(state)) return;
      yield* Effect.sleep(FIRST_PASS_DELAY);
      yield* pass.pipe(Effect.repeat(Schedule.spaced(WINDOW_RECHECK)));
    }),
  };
}
