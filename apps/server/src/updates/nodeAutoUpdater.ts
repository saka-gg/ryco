/**
 * nodeAutoUpdater - a CLI service node installs Ryco's newest release on its own while nobody
 * uses it.
 *
 * Loaded with unattended updates (`unattendedUpdates.ts`), never on boot, and it acts only on a
 * global npm or pnpm install that runs under a service manager and can update itself
 * ({@link canUpdateUnattended}): never the desktop app, `npx`/`bunx`, a source checkout, an
 * unknown install or a node in the foreground. Nor a bun install: bun cannot hold back brand-new
 * dependency releases while it installs. Dev servers never load it.
 *
 * The first pass runs {@link FIRST_PASS_DELAY} after unattended updates start, then one every
 * {@link WINDOW_RECHECK}, and does nothing unless `automaticUpdates` and update checks are on. It
 * asks the registry for the newest release ({@link NodeUpdateServiceShape.check}) at most every
 * {@link RELEASE_CHECK_INTERVAL} (the service's own cache lifetime). Once a newer release on the
 * node's own channel is known, it waits for the update window in restart mode (5 quiet minutes,
 * no agent work, terminals or restart-sensitive work: `updateWindow.ts`), for the release to be
 * {@link MINIMUM_RELEASE_AGE} old by the registry's publish time, and then runs the same update a
 * person runs (`NodeUpdateService.update`: admission, a fresh registry check, the install, the
 * preflight, the snapshot, the marker and the boot guard), marked unattended, with dependency
 * releases younger than that age held back. It holds the host-wide install lock under the
 * installation's own key (the one a provider CLI update into the same global install takes) until
 * the run is over, however long that takes.
 *
 * Right before the restart the window is asked again; a closed one puts the previous release back
 * and postpones the update, for {@link POSTPONED_RETRY_AFTER}, then twice as long each time up to
 * {@link POSTPONED_RETRY_MAX}. A release is recorded as skipped before anything is installed and
 * taken off only when nothing changed (`nodeAutoSkip.ts`), so one that failed, was rolled back or
 * was postponed {@link MAX_POSTPONEMENTS} times is never tried unattended again. Why a release is
 * left alone shows in the node's update state (`automaticUpdateNote`).
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
 * After the first postponed update of a release (someone came back while it installed), the next
 * try waits this long; each further postponement doubles it, up to {@link POSTPONED_RETRY_MAX}.
 * Each try installs the release and puts the previous one back.
 */
export const POSTPONED_RETRY_AFTER = Duration.hours(1);
export const POSTPONED_RETRY_MAX = Duration.hours(24);
/** A release postponed this often is left alone like one whose update failed. */
export const MAX_POSTPONEMENTS = 5;
/**
 * After an update that was refused before it started (another update ran, a newer release came
 * out, the package manager cannot hold back new dependencies), the next try waits this long.
 */
export const REFUSED_RETRY_AFTER = RELEASE_CHECK_INTERVAL;

const RELEASE_CHECK_INTERVAL_NANOS = Duration.toNanosUnsafe(RELEASE_CHECK_INTERVAL);
const REFUSED_RETRY_AFTER_NANOS = Duration.toNanosUnsafe(REFUSED_RETRY_AFTER);
const MINIMUM_RELEASE_AGE_MS = Duration.toMillis(MINIMUM_RELEASE_AGE);

/** How long the try after postponement number `postponements` of one release waits. */
export const postponedRetryAfter = (postponements: number) =>
  Duration.min(
    Duration.times(POSTPONED_RETRY_AFTER, 2 ** Math.max(0, postponements - 1)),
    POSTPONED_RETRY_MAX,
  );

/**
 * Installations that replace their own release, come back through a service manager, and hold
 * back brand-new dependency releases while they install (npm's `--before`, pnpm's
 * `minimumReleaseAge`; `NodeUpdateService` checks pnpm's version).
 */
const SELF_UPDATING_KINDS: ReadonlySet<NodeInstallationKind> = new Set([
  "npm-global",
  "pnpm-global",
]);

/** Whether this node may update Ryco itself unattended at all. */
export function canUpdateUnattended(state: NodeUpdateState): boolean {
  return (
    state.canUpdate &&
    state.installation.service !== null &&
    SELF_UPDATING_KINDS.has(state.installation.kind)
  );
}

const NOTE_PREFIX = "Automatic update: ";
export const skippedReleaseNote = (version: string) =>
  `${NOTE_PREFIX}Ryco ${version} is left alone because an automatic update to it did not finish: it failed, was rolled back, or was postponed too often. Update it yourself to try it again.`;
export const UNREADABLE_SKIP_LIST_NOTE = `${NOTE_PREFIX}this node cannot read its list of releases to leave alone (node-update/auto-skip.json in its state folder), so it does not update itself. Fix or remove that file.`;
const UNWRITABLE_SKIP_LIST_NOTE = `${NOTE_PREFIX}this node cannot write its list of releases to leave alone (node-update/auto-skip.json in its state folder), so it does not update itself.`;
const refusedNote = (version: string, reason: string) =>
  `${NOTE_PREFIX}Ryco ${version} did not install: ${reason}`;

export interface NodeAutoUpdaterSources {
  /** `automaticUpdates` and update checks are both on; false when unreadable. */
  readonly enabled: Effect.Effect<boolean>;
  readonly window: UpdateWindow;
  readonly nodeUpdate: Pick<
    NodeUpdateServiceShape,
    "current" | "check" | "update" | "changes" | "installLockKey" | "setAutomaticUpdateNote"
  >;
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
  // Monotonic: when a postponed or refused release, or one the registry did not date, is due.
  const notBefore = new Map<string, bigint>();
  // Per release, for the life of the process.
  const postponements = new Map<string, number>();
  const refusals = new Map<string, string>();
  const note = (value: string | null) => sources.nodeUpdate.setAutomaticUpdateNote(value);
  const waitBeforeRetry = (version: string, nanos: bigint) =>
    Effect.map(Clock.monotonicTimeNanos, (now) => {
      notBefore.set(version, now + nanos);
    });

  /** The update window in restart mode, with the install lock key the caller holds set aside. */
  const restartWindow = (heldLockKey?: string) =>
    sources.window.isOpen({
      restart: true,
      ...(heldLockKey === undefined ? {} : { heldLockKey }),
    });
  const isWindowOpen = (heldLockKey?: string) =>
    Effect.gen(function* () {
      if (!(yield* sources.enabled)) return false;
      return yield* restartWindow(heldLockKey);
    });

  /** The release to install now, or undefined; it also tells the owner why a release waits. */
  const due = Effect.gen(function* () {
    const now = yield* Clock.monotonicTimeNanos;
    if (nextReleaseCheckAt === null || now >= nextReleaseCheckAt) {
      nextReleaseCheckAt = now + RELEASE_CHECK_INTERVAL_NANOS;
      // An unreachable registry leaves what the node knew; the next hour asks again.
      yield* Effect.ignore(sources.nodeUpdate.check);
    }
    const state = yield* sources.nodeUpdate.current;
    const target = state.latestVersion;
    if (sources.isActiveRun(state.run)) return undefined;
    if (
      target === null ||
      !canUpdateUnattended(state) ||
      // Newer than the running release (`behind_latest` never holds for a downgrade), on its
      // own channel.
      state.availability !== "behind_latest" ||
      sources.releaseChannelOf(target) !== state.channel
    ) {
      yield* note(null);
      return undefined;
    }
    switch (yield* sources.skipped.status(target)) {
      case "unreadable":
        yield* note(UNREADABLE_SKIP_LIST_NOTE);
        return undefined;
      case "skipped":
        yield* note(skippedReleaseNote(target));
        return undefined;
      case "allowed":
        yield* note(refusals.get(target) ?? null);
    }
    const waitUntil = notBefore.get(target);
    if (waitUntil !== undefined && now < waitUntil) return undefined;
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

  /**
   * How the run `id` ended: followed for as long as it is under way, however long that takes, so
   * the install lock is never let go of in the middle of it. `None` when another run replaced it.
   */
  const outcomeOf = (id: string) =>
    sources.nodeUpdate.changes.pipe(
      Stream.map((state) => state.run),
      Stream.filter((run) => run.requestId !== id || !sources.isActiveRun(run)),
      Stream.runHead,
      Effect.map(Option.filter((run) => run.requestId === id)),
    );

  /** Under the install lock: the window once more, then the update a person would run. */
  const install = Effect.fn("NodeAutoUpdater.install")(function* (
    targetVersion: string,
    lockKey: string,
    recordInstallerPid: (pid: number) => Effect.Effect<void, Error>,
  ) {
    if (!(yield* isWindowOpen(lockKey))) return;
    // Before anything is installed: a failure, a rollback or a crash from here on keeps it.
    const recorded = yield* Effect.result(sources.skipped.add(targetVersion));
    if (Result.isFailure(recorded)) {
      yield* note(UNWRITABLE_SKIP_LIST_NOTE);
      yield* waitBeforeRetry(targetVersion, REFUSED_RETRY_AFTER_NANOS);
      return yield* Effect.logWarning("Automatic Ryco update did not start", {
        targetVersion,
        reason: recorded.failure.message,
      });
    }
    const id = yield* newRequestId;
    yield* Effect.logInfo("Updating Ryco automatically", { targetVersion, requestId: id });
    const started = yield* Effect.result(
      sources.nodeUpdate.update(
        { requestId: id, targetVersion },
        {
          unattended: {
            beforeRestart: isWindowOpen(lockKey),
            restartWindow: restartWindow(lockKey),
            recordInstallerPid,
            minimumReleaseAge: MINIMUM_RELEASE_AGE,
          },
        },
      ),
    );
    if (Result.isFailure(started)) {
      // Refused before anything ran (another update, a newer release meanwhile, a package
      // manager that cannot hold back new dependencies).
      yield* sources.skipped.remove(targetVersion);
      const reason = started.failure.reason;
      refusals.set(targetVersion, refusedNote(targetVersion, reason));
      yield* note(refusals.get(targetVersion)!);
      yield* waitBeforeRetry(targetVersion, REFUSED_RETRY_AFTER_NANOS);
      return yield* Effect.logInfo("Automatic Ryco update did not start", {
        targetVersion,
        reason,
      });
    }
    refusals.delete(targetVersion);
    yield* note(null);
    // A successful run never reports here: the restart ends this process.
    const outcome = yield* outcomeOf(id);
    if (Option.isSome(outcome) && outcome.value.status === "postponed") {
      const count = (postponements.get(targetVersion) ?? 0) + 1;
      postponements.set(targetVersion, count);
      if (count >= MAX_POSTPONEMENTS) {
        // Each try installs the release and puts the previous one back: stop, as after a failure.
        yield* note(skippedReleaseNote(targetVersion));
        return yield* Effect.logWarning(
          "Automatic Ryco update postponed too often; this release is not tried again",
          { targetVersion, postponements: count },
        );
      }
      yield* sources.skipped.remove(targetVersion);
      const retryAfter = postponedRetryAfter(count);
      yield* waitBeforeRetry(targetVersion, Duration.toNanosUnsafe(retryAfter));
      return yield* Effect.logInfo("Automatic Ryco update postponed", {
        targetVersion,
        message: outcome.value.message,
        retryAfterMinutes: Duration.toMinutes(retryAfter),
      });
    }
    yield* note(skippedReleaseNote(targetVersion));
    yield* Effect.logWarning("Automatic Ryco update failed; this release is not tried again", {
      targetVersion,
      status: Option.isSome(outcome) ? outcome.value.status : "replaced",
      message: Option.isSome(outcome) ? outcome.value.message : null,
    });
  });

  /** One pass; it never fails, so the schedule keeps running. */
  const pass = Effect.gen(function* () {
    if (!(yield* sources.enabled)) return yield* note(null);
    const target = yield* due;
    if (target === undefined) return;
    const lockKey = yield* sources.nodeUpdate.installLockKey;
    if (lockKey === null) return;
    const lock = yield* sources.installLock.lock;
    // Held elsewhere: another Ryco on this machine installs into the same global install (a
    // provider CLI, another node); the next pass tries again.
    yield* lock.tryRun(lockKey, (recordInstallerPid) =>
      install(target, lockKey, recordInstallerPid),
    );
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
