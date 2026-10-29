/**
 * Per-repository index of recent change requests.
 *
 * Status, sidebar badges and worktree discovery all need "the change request
 * for this branch". Asking the forge once per branch and head selector costs a
 * CLI process and a network round trip each; one lean repository-wide list
 * answers every branch of every checkout of that repository instead. The index
 * holds the most recent change requests in any state and, only when that list
 * is full, every open one; a branch it cannot answer for falls back to a
 * per-branch query, cached here too: in a busy repository the same old or
 * PR-less branches miss the recent window on every read.
 *
 * While the forge is rate limiting (see `lastGoodWhilePaused`), background
 * readers get the last good listing, marked, and the forge's rate-limited
 * answer is held until its pause ends, through invalidations while the pause
 * runs, so interactive readers share it instead of asking again.
 */
import { Cache, Clock, Duration, Effect, Exit, Option } from "effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
} from "@ryco/contracts";

import { isForgeRequestRefusedWhilePaused } from "./forgeRequestPaused.ts";
import {
  heldUntil,
  type LastGood,
  makeLastGood,
  markServedWhilePaused,
} from "./lastGoodWhilePaused.ts";
import type { SourceControlProviderShape } from "./SourceControlProvider.ts";

export const PULL_REQUEST_INDEX_LIMIT = 100;
const PULL_REQUEST_INDEX_TTL = Duration.seconds(60);
/** A failed listing (offline, no auth) is retried after a short pause, not on every read. */
const PULL_REQUEST_INDEX_FAILURE_TTL = Duration.seconds(10);

/**
 * How long a failed listing is kept. A read Ryco refused itself while the
 * forge was paused after a rate limit is not kept: it reached no forge, and the
 * cache runs a lookup in the lane of the reader that started it, so a refused
 * background read would otherwise answer interactive readers, which the pause
 * lets through.
 */
const failureTimeToLive = (exit: Exit.Exit<unknown, unknown>) =>
  isForgeRequestRefusedWhilePaused(Option.getOrUndefined(Exit.findErrorOption(exit)))
    ? Duration.zero
    : PULL_REQUEST_INDEX_FAILURE_TTL;
const PULL_REQUEST_INDEX_CAPACITY = 256;

export const BRANCH_CHANGE_REQUEST_LIMIT = 20;
/**
 * Per-branch answers only matter for branches the recent window misses, and a
 * new change request on such a branch enters that window first, so they can
 * live longer than the index itself. An open one still changes state soon.
 */
const BRANCH_OPEN_TTL = Duration.seconds(60);
const BRANCH_FINISHED_TTL = Duration.minutes(15);
const BRANCH_NONE_TTL = Duration.minutes(3);
const BRANCH_CAPACITY = 2048;

export type PullRequestIndexScope = "all" | "open";

export interface PullRequestIndexListing {
  readonly items: ReadonlyArray<ChangeRequest>;
  /** The forge returned fewer than the limit: no other change request matches the scope. */
  readonly complete: boolean;
}

/** Identifies a forge repository: provider kind plus normalized remote URL. */
export function pullRequestIndexRepositoryKey(input: {
  readonly providerKind: string;
  readonly remoteUrl: string;
}): string {
  const url = input.remoteUrl
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return `${input.providerKind}\u0000${url}`;
}

export interface PullRequestIndex {
  /**
   * The repository's listing for `scope`. While the forge is rate limiting, a
   * background reader may get the last good listing instead, marked (its
   * `items` too) with the pause's end (`pausedUntilOf`).
   */
  readonly read: (input: {
    readonly repository: string;
    readonly scope: PullRequestIndexScope;
    readonly cwd: string;
    readonly provider: SourceControlProviderShape;
  }) => Effect.Effect<PullRequestIndexListing, SourceControlProviderError>;
  /**
   * Change requests whose head matches one selector, for a branch the index
   * cannot answer for. Cached per repository and selector; dropped with the
   * index on `invalidate` (their last good answers and holds stay keyed by
   * selector, like the index's).
   */
  readonly readBranch: (input: {
    readonly repository: string;
    readonly headSelector: string;
    readonly cwd: string;
    readonly provider: SourceControlProviderShape;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  /**
   * Listings loaded from the forge only (never one served while it is paused);
   * never asks the forge.
   */
  readonly peek: (
    repository: string,
  ) => Effect.Effect<ReadonlyArray<PullRequestIndexListing>, never>;
  /**
   * Drops the repository's listings and branch answers. A held rate-limited
   * answer stays when `keepHeldWhile` (asked only when one is held) says the
   * forge's pause still runs.
   */
  readonly invalidate: (
    repository: string,
    options?: { readonly keepHeldWhile?: Effect.Effect<boolean> },
  ) => Effect.Effect<void>;
}

const indexKey = (repository: string, scope: PullRequestIndexScope) =>
  `${scope}\u0000${repository}`;

/** A listing served while paused: it and its rows carry the mark. */
const markListing = (listing: PullRequestIndexListing, pausedUntilMs: number) =>
  markServedWhilePaused(
    { ...listing, items: markServedWhilePaused(listing.items, pausedUntilMs) },
    pausedUntilMs,
  );

export const makePullRequestIndex = Effect.gen(function* () {
  // Who to ask for a repository's listing: the latest checkout and provider
  // that read it. Every checkout of the repository shares the one listing.
  const lookups = new Map<
    string,
    { readonly cwd: string; readonly provider: SourceControlProviderShape }
  >();

  // Last good answers by index key and by branch key without the generation,
  // so they outlive invalidations.
  const lastGoodListings = makeLastGood<PullRequestIndexListing>(
    PULL_REQUEST_INDEX_CAPACITY,
    markListing,
  );
  const lastGoodBranches = makeLastGood<ReadonlyArray<ChangeRequest>>(BRANCH_CAPACITY);
  // The forge's rate-limited answers, held until their pause ends: "i" + index
  // key, "b" + branch key without the generation.
  const holds = new Map<
    string,
    {
      readonly repository: string;
      readonly error: SourceControlProviderError;
      readonly untilMs: number;
    }
  >();

  /** Remembers a lookup's outcome: a success as last good, a rate limit as a hold. */
  const learn = <V extends object>(
    read: Effect.Effect<V, SourceControlProviderError>,
    lastGood: LastGood<V>,
    lastGoodKey: string,
    holdKey: string,
    repository: string,
  ) =>
    read.pipe(
      Effect.tap((value) =>
        Effect.map(Clock.currentTimeMillis, (nowMs) =>
          lastGood.remember(lastGoodKey, value, nowMs),
        ),
      ),
      Effect.tapError((error) =>
        Effect.map(Clock.currentTimeMillis, (nowMs) => {
          const untilMs = heldUntil(error, nowMs);
          if (untilMs === null) return;
          for (const [key, hold] of holds) if (hold.untilMs <= nowMs) holds.delete(key);
          holds.set(holdKey, { repository, error, untilMs });
        }),
      ),
    );

  /**
   * A cached read through a pause: a held answer instead of the read, then
   * for a rate limit the last good value to a background reader.
   */
  const throughPause = <V extends object>(
    read: Effect.Effect<V, SourceControlProviderError>,
    lastGood: LastGood<V>,
    lastGoodKey: string,
    holdKey: string,
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) => {
      const hold = holds.get(holdKey);
      return hold !== undefined && hold.untilMs > nowMs ? Effect.fail(hold.error) : read;
    }).pipe(
      Effect.catch((error) =>
        Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
          lastGood.serve(lastGoodKey, error, nowMs),
        ),
      ),
    );

  const listIndex = (key: string) =>
    Effect.suspend(() => {
      const separator = key.indexOf("\u0000");
      const scope = key.slice(0, separator) as PullRequestIndexScope;
      const repository = key.slice(separator + 1);
      const lookup = lookups.get(repository);
      if (!lookup) return Effect.die(new Error("Change request index read without a checkout."));
      const read = lookup.provider
        .listChangeRequests({
          cwd: lookup.cwd,
          headSelector: "",
          state: scope satisfies ChangeRequestState | "all",
          limit: PULL_REQUEST_INDEX_LIMIT,
          includeStackSummary: false,
          fields: "summary",
        })
        .pipe(
          Effect.map((items): PullRequestIndexListing => ({
            items,
            complete: items.length < PULL_REQUEST_INDEX_LIMIT,
          })),
        );
      return learn(read, lastGoodListings, key, `i${key}`, repository);
    });

  const cache = yield* Cache.makeWith(listIndex, {
    capacity: PULL_REQUEST_INDEX_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? PULL_REQUEST_INDEX_TTL : failureTimeToLive(exit)),
  });

  // Invalidation bumps the repository's generation, which every branch key
  // carries, so a refresh drops all of its branch answers at once; the old
  // entries age out of the bounded cache.
  const generations = new Map<string, number>();
  let nextGeneration = 0;
  const generationOf = (repository: string) => generations.get(repository) ?? 0;
  const branchKey = (repository: string, headSelector: string) =>
    `${generationOf(repository)}\u0000${headSelector}\u0000${repository}`;

  const listBranch = (key: string) =>
    Effect.suspend(() => {
      const first = key.indexOf("\u0000");
      const second = key.indexOf("\u0000", first + 1);
      const headSelector = key.slice(first + 1, second);
      const repository = key.slice(second + 1);
      const lookup = lookups.get(repository);
      if (!lookup) return Effect.die(new Error("Change request branch read without a checkout."));
      const read = lookup.provider.listChangeRequests({
        cwd: lookup.cwd,
        headSelector,
        state: "all",
        limit: BRANCH_CHANGE_REQUEST_LIMIT,
        includeStackSummary: false,
        fields: "summary",
      });
      const stableKey = key.slice(first + 1);
      return learn(read, lastGoodBranches, stableKey, `b${stableKey}`, repository);
    });

  const branchCache = yield* Cache.makeWith(listBranch, {
    capacity: BRANCH_CAPACITY,
    timeToLive: (exit) => {
      if (!Exit.isSuccess(exit)) return failureTimeToLive(exit);
      if (exit.value.length === 0) return BRANCH_NONE_TTL;
      return exit.value.some((item) => item.state === "open")
        ? BRANCH_OPEN_TTL
        : BRANCH_FINISHED_TTL;
    },
  });

  const rememberLookup = (input: {
    readonly repository: string;
    readonly cwd: string;
    readonly provider: SourceControlProviderShape;
  }) => {
    lookups.delete(input.repository);
    lookups.set(input.repository, { cwd: input.cwd, provider: input.provider });
    for (const oldest of lookups.keys()) {
      if (lookups.size <= PULL_REQUEST_INDEX_CAPACITY) break;
      lookups.delete(oldest);
    }
  };

  return {
    read: (input) =>
      Effect.suspend(() => {
        rememberLookup(input);
        const key = indexKey(input.repository, input.scope);
        return throughPause(Cache.get(cache, key), lastGoodListings, key, `i${key}`);
      }),
    readBranch: (input) =>
      Effect.suspend(() => {
        rememberLookup(input);
        const stableKey = `${input.headSelector}\u0000${input.repository}`;
        return throughPause(
          Cache.get(branchCache, branchKey(input.repository, input.headSelector)),
          lastGoodBranches,
          stableKey,
          `b${stableKey}`,
        );
      }),
    peek: (repository) =>
      Effect.forEach(["all", "open"] as const, (scope) =>
        Cache.getSuccess(cache, indexKey(repository, scope)),
      ).pipe(
        Effect.map((listings) =>
          listings.flatMap((listing) => (listing._tag === "Some" ? [listing.value] : [])),
        ),
      ),
    invalidate: (repository, options?) =>
      Effect.gen(function* () {
        generations.delete(repository);
        generations.set(repository, ++nextGeneration);
        for (const oldest of generations.keys()) {
          if (generations.size <= BRANCH_CAPACITY) break;
          generations.delete(oldest);
        }
        yield* Cache.invalidate(cache, indexKey(repository, "all"));
        yield* Cache.invalidate(cache, indexKey(repository, "open"));
        const nowMs = yield* Clock.currentTimeMillis;
        const holding = [...holds.values()].some(
          (hold) => hold.repository === repository && hold.untilMs > nowMs,
        );
        if (holding && options?.keepHeldWhile !== undefined && (yield* options.keepHeldWhile)) {
          return;
        }
        for (const [key, hold] of holds) if (hold.repository === repository) holds.delete(key);
      }),
  } satisfies PullRequestIndex;
});

/** Newest open match, else the newest match; `updatedAt` orders, unknown last. */
export function pickLatestChangeRequest<T extends { readonly state: string }>(
  matches: ReadonlyArray<T>,
  updatedAtMs: (item: T) => number | null,
): T | null {
  let latestOpen: T | null = null;
  let latest: T | null = null;
  const newer = (candidate: T, current: T | null) => {
    if (current === null) return true;
    return (updatedAtMs(candidate) ?? -Infinity) > (updatedAtMs(current) ?? -Infinity);
  };
  for (const item of matches) {
    if (item.state === "open" && newer(item, latestOpen)) latestOpen = item;
    if (newer(item, latest)) latest = item;
  }
  return latestOpen ?? latest;
}

export type IndexedChangeRequestLookup<T> =
  | { readonly resolved: true; readonly match: T | null }
  | { readonly resolved: false };

/**
 * Answers "the change request for this branch" from the index when it can.
 * An open match is final. Otherwise the answer is final only when the
 * listings prove nothing newer exists: the recent list is complete, or the
 * open list is complete and either a finished match was found or only open
 * change requests matter (`openOnly`, the default branch). A failed listing
 * fails the lookup: a per-branch query would ask the same unreachable forge.
 */
export const lookupIndexedChangeRequest = Effect.fn("lookupIndexedChangeRequest")(function* <
  T extends { readonly state: string },
  E,
>(input: {
  readonly readListing: (scope: PullRequestIndexScope) => Effect.Effect<PullRequestIndexListing, E>;
  readonly matches: (item: ChangeRequest) => T | null;
  readonly updatedAtMs: (item: T) => number | null;
  readonly openOnly: boolean;
}) {
  const select = (listing: PullRequestIndexListing) =>
    pickLatestChangeRequest(
      listing.items.flatMap((item) => {
        const matched = input.matches(item);
        return matched === null ? [] : [matched];
      }),
      input.updatedAtMs,
    );

  const recent = yield* input.readListing("all");
  const recentMatch = select(recent);
  if (recentMatch?.state === "open" || recent.complete) {
    return { resolved: true, match: recentMatch } as IndexedChangeRequestLookup<T>;
  }

  const open = yield* input.readListing("open");
  const openMatch = select(open);
  if (openMatch !== null) {
    return { resolved: true, match: openMatch } as IndexedChangeRequestLookup<T>;
  }
  if (open.complete && (recentMatch !== null || input.openOnly)) {
    return { resolved: true, match: recentMatch } as IndexedChangeRequestLookup<T>;
  }
  return { resolved: false } as IndexedChangeRequestLookup<T>;
});
