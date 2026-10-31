/**
 * GitHub pull request fingerprints for everything that polls pull requests (sidebar rows, the
 * pull request watch), batched per host and kept for a short while, so that a node showing many
 * pull requests asks GitHub about one point's worth per pass instead of one per pull request.
 *
 * - Batched (T3 Code 758dc290e9, #16270): reads that start within 10 ms of each other on one host
 *   go out as one aliased document, twenty-five pull requests to a request. T3 batches with
 *   Effect's `RequestResolver`; this window is hand-rolled because `Effect.request` lives in the
 *   `Effect` module every boot loads, and using it would pull its machinery onto the boot path.
 * - Shared: every document is filled up to twenty-five with the other pull requests readers
 *   asked about lately whose last answer is more than 10 s old, so readers that poll on their
 *   own timers (each row polls every 30 s with jitter) find a fresh answer instead of each
 *   sending their own document.
 * - Reused: a reader that passes `reuseSinceMs` takes an answer GitHub gave at or after that
 *   time while it is younger than the reuse window: 20 s, or 5 min once nobody updated the pull
 *   request for 30 min and nothing is in flight (T3 Code 8dec2ffef9, #22073: quiet pull requests
 *   are read every five minutes). A caller that must see a change at once (a push, a finished
 *   turn, a mutation) passes the time of that change.
 *
 * Process memory, bounded; a restart starts empty.
 *
 * @module gitHubPullRequestFingerprintBoard
 */
import { Deferred, Duration, Effect, Exit } from "effect";

import {
  GITHUB_WATCH_FINGERPRINTS_PER_REQUEST,
  type GitHubWatchFingerprintAnswer,
  type GitHubWatchFingerprintTarget,
} from "./gitHubPullRequestWatchFingerprint.ts";
import type { ChangeRequestWatchFingerprint } from "./SourceControlProvider.ts";

/** How long an answer stands in for a read. */
export const GITHUB_FINGERPRINT_REUSE_MS = 20_000;
/** The same for a quiet pull request (T3 `QUIET_SYNC_INTERVAL_MS`). */
export const GITHUB_QUIET_FINGERPRINT_REUSE_MS = 5 * 60_000;
/** Untouched this long, with nothing in flight, a pull request is quiet (T3 `QUIET_AFTER_MS`). */
export const GITHUB_FINGERPRINT_QUIET_AFTER_MS = 30 * 60_000;
/**
 * A pull request nobody asked about for this long no longer rides along in other documents. Above
 * the watch's two-minute sweep, so watched pull requests keep sharing one document.
 */
export const GITHUB_FINGERPRINT_TRACK_MS = 5 * 60_000;
/** Reads that start this close together share a document (T3 `SUMMARY_BATCH_WINDOW`). */
const BATCH_WINDOW = Duration.millis(10);
const BOARD_CAPACITY = 512;

export interface GitHubFingerprintTarget extends GitHubWatchFingerprintTarget {
  /** The checkout to run `gh` in when the read cannot go over HTTPS. */
  readonly cwd: string;
  readonly host: string;
}

/** One batched document: answers in the order of `targets`. */
export type GitHubFingerprintsRead<E> = (input: {
  readonly cwd: string;
  readonly host: string;
  readonly targets: ReadonlyArray<GitHubWatchFingerprintTarget>;
}) => Effect.Effect<ReadonlyArray<GitHubWatchFingerprintAnswer>, E>;

interface Answer {
  readonly fingerprint: ChangeRequestWatchFingerprint | null;
  /** When the read that brought it started: GitHub's answer is at least this fresh. */
  readonly fetchedAtMs: number;
  readonly quietFromMs: number | null;
}

interface Tracked {
  readonly target: GitHubFingerprintTarget;
  askedAtMs: number;
  answer: Answer | null;
}

/** Reads of one host waiting for their document. */
interface Batch<E> {
  readonly asks: Map<
    string,
    {
      readonly target: GitHubFingerprintTarget;
      readonly waiters: Array<Deferred.Deferred<ChangeRequestWatchFingerprint | null, E>>;
    }
  >;
  startedAtMs: number;
}

const hostKey = (host: string) => host.trim().toLowerCase();
const targetKey = (target: GitHubFingerprintTarget) =>
  `${hostKey(target.host)}\u0000${target.owner.toLowerCase()}/${target.name.toLowerCase()}#${target.number}`;

const reuseWindowMs = (answer: Answer, nowMs: number) =>
  answer.quietFromMs !== null && nowMs >= answer.quietFromMs
    ? GITHUB_QUIET_FINGERPRINT_REUSE_MS
    : GITHUB_FINGERPRINT_REUSE_MS;

export interface GitHubPullRequestFingerprintBoard<E> {
  readonly get: (
    target: GitHubFingerprintTarget,
    options: {
      readonly nowMs: number;
      readonly reuseSinceMs?: number | undefined;
    },
  ) => Effect.Effect<ChangeRequestWatchFingerprint | null, E>;
}

export function makeGitHubPullRequestFingerprintBoard<E>(options: {
  readonly read: GitHubFingerprintsRead<E>;
  /** The error for a pull request whose part of the answer failed alone. */
  readonly failed: (detail: string) => E;
}): GitHubPullRequestFingerprintBoard<E> {
  const tracked = new Map<string, Tracked>();

  /**
   * Pull requests of `host` that ride along in a document for `requested`: asked about within
   * the track window, and never answered or answered more than half the short window ago,
   * quiet ones too (riding along costs nothing; their long window only spares them a document
   * of their own), oldest answer first.
   */
  const companions = (
    host: string,
    requested: ReadonlyMap<string, unknown>,
    nowMs: number,
    room: number,
  ) => {
    const due: Array<{ readonly key: string; readonly entry: Tracked }> = [];
    for (const [key, entry] of tracked) {
      if (room <= 0) break;
      if (requested.has(key) || hostKey(entry.target.host) !== host) continue;
      if (nowMs - entry.askedAtMs >= GITHUB_FINGERPRINT_TRACK_MS) continue;
      const { answer } = entry;
      if (answer !== null && nowMs - answer.fetchedAtMs < GITHUB_FINGERPRINT_REUSE_MS / 2) continue;
      due.push({ key, entry });
    }
    return due
      .toSorted(
        (left, right) =>
          (left.entry.answer?.fetchedAtMs ?? Number.NEGATIVE_INFINITY) -
          (right.entry.answer?.fetchedAtMs ?? Number.NEGATIVE_INFINITY),
      )
      .slice(0, Math.max(0, room));
  };

  const pending = new Map<string, Batch<E>>();

  /** Sends a batch's document and settles every reader waiting for it. */
  const flush = (host: string, batch: Batch<E>) =>
    Effect.gen(function* () {
      if (pending.get(host) === batch) pending.delete(host);
      const startedAtMs = batch.startedAtMs;
      const keys = [...batch.asks.keys()];
      const targets = [...batch.asks.values()].map((ask) => ask.target);
      for (const { key, entry } of companions(
        host,
        batch.asks,
        startedAtMs,
        GITHUB_WATCH_FINGERPRINTS_PER_REQUEST - keys.length,
      )) {
        keys.push(key);
        targets.push(entry.target);
      }
      const read = yield* Effect.exit(
        options.read({ cwd: targets[0]!.cwd, host: targets[0]!.host, targets }),
      );
      if (Exit.isFailure(read)) {
        // A failed document (a rate limit, GitHub unreachable) fails every pull request in it.
        for (const ask of batch.asks.values()) {
          for (const waiter of ask.waiters) yield* Deferred.failCause(waiter, read.cause);
        }
        return;
      }
      for (const [index, key] of keys.entries()) {
        const answer = read.value[index] ?? {
          kind: "failed" as const,
          detail: "GitHub gave no answer for the pull request.",
        };
        const entry = tracked.get(key);
        // A slower read that started earlier never replaces a newer answer.
        if (
          entry !== undefined &&
          answer.kind !== "failed" &&
          (entry.answer === null || entry.answer.fetchedAtMs <= startedAtMs)
        ) {
          entry.answer =
            answer.kind === "found"
              ? {
                  fingerprint: answer.fingerprint,
                  fetchedAtMs: startedAtMs,
                  quietFromMs: answer.quietFromMs,
                }
              : { fingerprint: null, fetchedAtMs: startedAtMs, quietFromMs: null };
        }
        for (const waiter of batch.asks.get(key)?.waiters ?? []) {
          yield* Deferred.done(
            waiter,
            answer.kind === "found"
              ? Exit.succeed(answer.fingerprint)
              : answer.kind === "gone"
                ? Exit.succeed(null)
                : Exit.fail(options.failed(answer.detail)),
          );
        }
      }
    });

  /**
   * Joins the host's open batch, or opens one whose document goes out after the window (in the
   * reader's context: its clock and process lane). A full batch takes no more readers.
   */
  const join = (key: string, target: GitHubFingerprintTarget, nowMs: number) =>
    Effect.gen(function* () {
      const host = hostKey(target.host);
      const waiter = yield* Deferred.make<ChangeRequestWatchFingerprint | null, E>();
      let batch = pending.get(host);
      if (batch === undefined) {
        const opened: Batch<E> = { asks: new Map(), startedAtMs: nowMs };
        batch = opened;
        pending.set(host, opened);
        yield* Effect.forkDetach(
          Effect.sleep(BATCH_WINDOW).pipe(Effect.andThen(flush(host, opened))),
        );
      }
      // GitHub's answer is at least as fresh as the last reader that joined.
      batch.startedAtMs = Math.max(batch.startedAtMs, nowMs);
      const ask = batch.asks.get(key) ?? { target, waiters: [] };
      ask.waiters.push(waiter);
      batch.asks.set(key, ask);
      if (batch.asks.size >= GITHUB_WATCH_FINGERPRINTS_PER_REQUEST) pending.delete(host);
      return yield* Deferred.await(waiter);
    });

  /** Marks `target` asked about now (most recent last) and drops the longest unasked beyond capacity. */
  const track = (key: string, target: GitHubFingerprintTarget, nowMs: number): Tracked => {
    const entry = tracked.get(key) ?? { target, askedAtMs: nowMs, answer: null };
    entry.askedAtMs = Math.max(entry.askedAtMs, nowMs);
    tracked.delete(key);
    tracked.set(key, entry);
    while (tracked.size > BOARD_CAPACITY) {
      const oldest = tracked.keys().next().value;
      if (oldest === undefined) break;
      tracked.delete(oldest);
    }
    return entry;
  };

  return {
    get: (target, { nowMs, reuseSinceMs }) =>
      Effect.suspend(() => {
        const key = targetKey(target);
        const { answer } = track(key, target, nowMs);
        if (
          reuseSinceMs !== undefined &&
          answer !== null &&
          answer.fetchedAtMs >= reuseSinceMs &&
          nowMs - answer.fetchedAtMs < reuseWindowMs(answer, nowMs)
        ) {
          return Effect.succeed(answer.fingerprint);
        }
        return join(key, target, nowMs);
      }),
  };
}
