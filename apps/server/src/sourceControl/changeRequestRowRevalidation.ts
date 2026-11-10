/**
 * How a change request row read (`view: "row"`, the glyph every visible sidebar row polls every
 * 30 s) stands on the host's fingerprint instead of a full detail read: the detail is read again
 * only when the fingerprint moved, the conditional request of these reads, as an ETag is for
 * HTTP. On GitHub a full row read is the pull request, its stack, its required checks (three
 * GraphQL points) and the repository's merge settings, where the batched fingerprint costs one
 * point for up to 25 pull requests, shared by every row and watch of the host
 * (`gitHubPullRequestFingerprintBoard`). Hosts without a fingerprint read in full as before.
 *
 * Read in full, with the fingerprint taken first so the detail is at least as new as it: a
 * row's first read (no fingerprint yet), a detail older than the re-read age (what the
 * fingerprint cannot see), a fingerprint that moved or that the host could not give, and every
 * row of a repository Ryco changed since (a comment, a merge, an edit). A push or an agent turn
 * asks for a fingerprint given after it (`RepositoryChanges.changedAtMs`).
 *
 * Loaded through `import()` with the first row read, off the boot path. Process memory, bounded.
 *
 * @module changeRequestRowRevalidation
 */
import type { SourceControlChangeRequestDetail, SourceControlProviderError } from "@ryco/contracts";
import { Clock, DateTime, Effect } from "effect";

import type { GitManagerShape } from "../git/GitManager.ts";

import type { RepositoryChanges } from "./repositoryListCache.ts";
import type {
  ChangeRequestWatchFingerprint,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";

/**
 * A row read on a fingerprint is read in full again after this long anyway, for what the
 * fingerprint cannot see (required-check settings, merge settings; T3 `FINGERPRINT_REREAD_MS`).
 */
export const CHANGE_REQUEST_ROW_REREAD_MS = 30 * 60_000;
/** The same for a stacked change request: its row shows the other entries' states. */
export const STACKED_CHANGE_REQUEST_ROW_REREAD_MS = 5 * 60_000;
const ROW_CAPACITY = 512;

/**
 * How long focused reads (the thread's overview, the active row, the pull request page) of
 * one change request share a detail across surfaces, checkouts and clients. Short: past it a
 * read stands on the host's fingerprint, or reads again.
 */
export const CHANGE_REQUEST_FOCUSED_DETAIL_CACHE_TTL_MS = 5_000;

/**
 * A focused read standing on an unmoved fingerprint is read in full again after this long
 * anyway, for what the fingerprint cannot see (a re-run check that ends as before, an edited
 * review, merge settings). An explicit refresh (`fresh`) always reads in full.
 */
export const CHANGE_REQUEST_FOCUSED_REREAD_MS = 5 * 60_000;

/** The state a detail read just got from the host, as linked workspaces record it. */
export function reportedChangeRequestState(detail: SourceControlChangeRequestDetail) {
  if (detail.isDraft === undefined) return undefined;
  const terminal =
    detail.state === "merged"
      ? (detail.mergedAt ?? detail.closedAt)
      : detail.state === "closed"
        ? detail.closedAt
        : undefined;
  return {
    state: detail.state,
    isDraft: detail.isDraft,
    terminalAt: terminal === undefined ? null : DateTime.formatIso(terminal),
  };
}

export type ReportedChangeRequestState = NonNullable<ReturnType<typeof reportedChangeRequestState>>;

/** What a row compares: every fingerprint part, or null when the host gave no revision. */
export function changeRequestRowToken(
  fingerprint: ChangeRequestWatchFingerprint | null,
): string | null {
  if (fingerprint === null || fingerprint.revision === undefined) return null;
  return [fingerprint.status, fingerprint.remarks, fingerprint.revision].join("\n");
}

const rereadAfterMs = (detail: SourceControlChangeRequestDetail, overrideMs?: number) =>
  Math.min(
    overrideMs ?? Infinity,
    (detail.stack?.entries.length ?? 0) > 1
      ? STACKED_CHANGE_REQUEST_ROW_REREAD_MS
      : CHANGE_REQUEST_ROW_REREAD_MS,
  );

interface RowRead {
  readonly detail: SourceControlChangeRequestDetail;
  readonly token: string | null;
  /** When the full read started. */
  readonly readAtMs: number;
  readonly mutations: number;
}

export type ChangeRequestRowRevalidation = ReturnType<typeof makeChangeRequestRowRevalidation>;

export function makeChangeRequestRowRevalidation() {
  const rows = new Map<string, RowRead>();
  const remember = (key: string, read: RowRead) => {
    rows.delete(key);
    rows.set(key, read);
    for (const oldest of rows.keys()) {
      if (rows.size <= ROW_CAPACITY) break;
      rows.delete(oldest);
    }
  };

  const read = <E, R>(input: {
    readonly cwd: string;
    /** One row of `cwd`: reference and content mode. */
    readonly key: string;
    readonly changes: RepositoryChanges;
    readonly load: Effect.Effect<SourceControlChangeRequestDetail, E, R>;
    /**
     * Read in full at least this often (the default: 30 min, 5 min for a stack). Focused
     * surfaces, which show more than a row, ask for less.
     */
    readonly rereadAfterMs?: number;
    /**
     * Read in full now (an explicit refresh), remembering it with the fingerprint taken
     * first, so later reads stand on this read instead of on the one before it.
     */
    readonly force?: boolean;
    /** The checkout's provider; one without a fingerprint reads in full. */
    readonly provider: Effect.Effect<
      Pick<SourceControlProviderShape, "getChangeRequestWatchFingerprint">,
      SourceControlProviderError
    >;
  }) =>
    Effect.gen(function* () {
      const readAtMs = yield* Clock.currentTimeMillis;
      const { mutations, changedAtMs } = input.changes;
      const key = `${input.cwd}\u0000${input.key}`;
      const previous = rows.get(key);
      const token =
        previous === undefined
          ? null
          : yield* input.provider
              .pipe(
                Effect.flatMap((provider) =>
                  provider.getChangeRequestWatchFingerprint === undefined
                    ? Effect.succeed(null)
                    : provider.getChangeRequestWatchFingerprint({
                        cwd: input.cwd,
                        number: previous.detail.number,
                        url: previous.detail.url,
                        reuseSinceMs: changedAtMs,
                      }),
                ),
              )
              .pipe(
                Effect.map(changeRequestRowToken),
                // Any failure (a rate limit included) reads in full, which keeps the cache's
                // last good value and pause rules.
                Effect.orElseSucceed(() => null),
              );
      if (
        input.force !== true &&
        previous !== undefined &&
        token !== null &&
        token === previous.token &&
        previous.mutations === mutations &&
        readAtMs - previous.readAtMs < rereadAfterMs(previous.detail, input.rereadAfterMs)
      ) {
        return previous.detail;
      }
      const detail = yield* input.load;
      remember(key, { detail, token, readAtMs, mutations });
      return detail;
    });

  return {
    read,
    /**
     * A change request detail read for `sourceControl.getChangeRequestDetail`. Rows share a
     * read for `rowTtlMs` and keep their last good detail while the forge rate limits; focused
     * surfaces share one for a few seconds. Past that both stand on the host's fingerprint
     * (focused ones re-read in full every 5 min); `fresh` reads in full now and becomes what
     * later reads stand on. A full read hands its state to the linked workspaces.
     */
    readDetail: <E, R>(input: {
      readonly cwd: string;
      readonly reference: string;
      readonly fullContent: boolean | undefined;
      readonly row: boolean;
      readonly fresh: boolean;
      readonly rowTtlMs: number;
      readonly cachedRepositoryList: GitManagerShape["cachedRepositoryList"];
      readonly load: Effect.Effect<SourceControlChangeRequestDetail, E, R>;
      readonly refreshLinked: (
        reported: ReportedChangeRequestState | undefined,
      ) => Effect.Effect<void, never, R>;
      readonly provider: Effect.Effect<
        Pick<SourceControlProviderShape, "getChangeRequestWatchFingerprint">,
        SourceControlProviderError
      >;
    }) => {
      // The detail carries the state its links need: no forge read of their own.
      const load = input.load.pipe(
        Effect.tap((detail) => input.refreshLinked(reportedChangeRequestState(detail))),
      );
      const key = JSON.stringify([
        "changeRequestDetail",
        ...(input.row ? [] : ["focused"]),
        input.reference,
        input.fullContent ?? false,
      ]);
      const fresh = !input.row && input.fresh;
      return input.cachedRepositoryList({
        cwd: input.cwd,
        key,
        load,
        ttlMs: input.row ? input.rowTtlMs : CHANGE_REQUEST_FOCUSED_DETAIL_CACHE_TTL_MS,
        ...(input.row ? { lastGood: input.fullContent !== true } : {}),
        ...(fresh ? { maxAgeMs: 0 } : {}),
        revalidate: (changes) =>
          read({
            cwd: input.cwd,
            key,
            changes,
            load,
            provider: input.provider,
            ...(input.row ? {} : { rereadAfterMs: CHANGE_REQUEST_FOCUSED_REREAD_MS }),
            ...(fresh ? { force: true } : {}),
          }),
      });
    },
  };
}
