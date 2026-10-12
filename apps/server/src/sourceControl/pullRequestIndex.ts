/**
 * Per-repository index of recent change requests.
 *
 * Status, sidebar badges and worktree discovery all need "the change request
 * for this branch". Asking the forge once per branch and head selector costs a
 * CLI process and a network round trip each; one lean repository-wide list
 * answers every branch of every checkout of that repository instead. The index
 * holds the most recent change requests in any state and, only when that list
 * is full, every open one; a branch it cannot answer for falls back to a
 * per-branch query.
 */
import { Cache, Duration, Effect, Exit } from "effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
} from "@ryco/contracts";

import type { SourceControlProviderShape } from "./SourceControlProvider.ts";

export const PULL_REQUEST_INDEX_LIMIT = 100;
const PULL_REQUEST_INDEX_TTL = Duration.seconds(60);
/** A failed listing (offline, no auth) is retried after a short pause, not on every read. */
const PULL_REQUEST_INDEX_FAILURE_TTL = Duration.seconds(10);
const PULL_REQUEST_INDEX_CAPACITY = 256;

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
  readonly read: (input: {
    readonly repository: string;
    readonly scope: PullRequestIndexScope;
    readonly cwd: string;
    readonly provider: SourceControlProviderShape;
  }) => Effect.Effect<PullRequestIndexListing, SourceControlProviderError>;
  /** Already-loaded listings only; never asks the forge. */
  readonly peek: (
    repository: string,
  ) => Effect.Effect<ReadonlyArray<PullRequestIndexListing>, never>;
  readonly invalidate: (repository: string) => Effect.Effect<void>;
}

const indexKey = (repository: string, scope: PullRequestIndexScope) =>
  `${scope}\u0000${repository}`;

export const makePullRequestIndex = Effect.gen(function* () {
  // Who to ask for a repository's listing: the latest checkout and provider
  // that read it. Every checkout of the repository shares the one listing.
  const lookups = new Map<
    string,
    { readonly cwd: string; readonly provider: SourceControlProviderShape }
  >();

  const listIndex = (key: string) =>
    Effect.suspend(() => {
      const separator = key.indexOf("\u0000");
      const scope = key.slice(0, separator) as PullRequestIndexScope;
      const lookup = lookups.get(key.slice(separator + 1));
      if (!lookup) return Effect.die(new Error("Change request index read without a checkout."));
      return lookup.provider
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
    });

  const cache = yield* Cache.makeWith(listIndex, {
    capacity: PULL_REQUEST_INDEX_CAPACITY,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) ? PULL_REQUEST_INDEX_TTL : PULL_REQUEST_INDEX_FAILURE_TTL,
  });

  return {
    read: (input) =>
      Effect.suspend(() => {
        lookups.delete(input.repository);
        lookups.set(input.repository, { cwd: input.cwd, provider: input.provider });
        for (const oldest of lookups.keys()) {
          if (lookups.size <= PULL_REQUEST_INDEX_CAPACITY) break;
          lookups.delete(oldest);
        }
        return Cache.get(cache, indexKey(input.repository, input.scope));
      }),
    peek: (repository) =>
      Effect.forEach(["all", "open"] as const, (scope) =>
        Cache.getSuccess(cache, indexKey(repository, scope)),
      ).pipe(
        Effect.map((listings) =>
          listings.flatMap((listing) => (listing._tag === "Some" ? [listing.value] : [])),
        ),
      ),
    invalidate: (repository) =>
      Effect.all(
        [
          Cache.invalidate(cache, indexKey(repository, "all")),
          Cache.invalidate(cache, indexKey(repository, "open")),
        ],
        { discard: true },
      ),
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
 * change requests matter (`openOnly`, the default branch).
 */
export const lookupIndexedChangeRequest = Effect.fn("lookupIndexedChangeRequest")(function* <
  T extends { readonly state: string },
>(input: {
  readonly readListing: (
    scope: PullRequestIndexScope,
  ) => Effect.Effect<PullRequestIndexListing | null>;
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
  if (recent === null) return { resolved: false } as IndexedChangeRequestLookup<T>;
  const recentMatch = select(recent);
  if (recentMatch?.state === "open" || recent.complete) {
    return { resolved: true, match: recentMatch } as IndexedChangeRequestLookup<T>;
  }

  const open = yield* input.readListing("open");
  if (open === null) return { resolved: false } as IndexedChangeRequestLookup<T>;
  const openMatch = select(open);
  if (openMatch !== null) {
    return { resolved: true, match: openMatch } as IndexedChangeRequestLookup<T>;
  }
  if (open.complete && (recentMatch !== null || input.openOnly)) {
    return { resolved: true, match: recentMatch } as IndexedChangeRequestLookup<T>;
  }
  return { resolved: false } as IndexedChangeRequestLookup<T>;
});
