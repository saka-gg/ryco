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
import { Clock, Effect } from "effect";

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

/** What a row compares: every fingerprint part, or null when the host gave no revision. */
export function changeRequestRowToken(
  fingerprint: ChangeRequestWatchFingerprint | null,
): string | null {
  if (fingerprint === null || fingerprint.revision === undefined) return null;
  return [fingerprint.status, fingerprint.remarks, fingerprint.revision].join("\n");
}

const rereadAfterMs = (detail: SourceControlChangeRequestDetail) =>
  (detail.stack?.entries.length ?? 0) > 1
    ? STACKED_CHANGE_REQUEST_ROW_REREAD_MS
    : CHANGE_REQUEST_ROW_REREAD_MS;

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

  return {
    read: <E, R>(input: {
      readonly cwd: string;
      /** One row of `cwd`: reference and content mode. */
      readonly key: string;
      readonly changes: RepositoryChanges;
      readonly load: Effect.Effect<SourceControlChangeRequestDetail, E, R>;
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
          previous !== undefined &&
          token !== null &&
          token === previous.token &&
          previous.mutations === mutations &&
          readAtMs - previous.readAtMs < rereadAfterMs(previous.detail)
        ) {
          return previous.detail;
        }
        const detail = yield* input.load;
        remember(key, { detail, token, readAtMs, mutations });
        return detail;
      }),
  };
}
