import type { VcsStatusResult } from "@ryco/contracts";

// The state behind `useRepositoryStatus`, kept pure so its rules are testable without a renderer.

/** What this device knows about a checkout's VCS status: a status, or why the last read failed. */
export interface RepositoryStatusRead {
  readonly data: VcsStatusResult | null;
  /** The last refresh failed and no status has arrived for this scope since. */
  readonly error: unknown;
}

/** Nothing known yet: still loading. */
export const UNKNOWN_REPOSITORY_STATUS: RepositoryStatusRead = { data: null, error: null };

/** The connection and checkout a read belongs to; compared field by field. */
export type RepositoryStatusScope = Readonly<Record<string, unknown>>;

export interface RepositoryStatusSnapshot<Scope extends RepositoryStatusScope> {
  readonly scope: Scope;
  readonly read: RepositoryStatusRead;
}

export function sameRepositoryStatusScope(
  left: RepositoryStatusScope,
  right: RepositoryStatusScope,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}

/** A status arrived for `scope`; it answers, and clears an earlier failure. */
export function recordRepositoryStatus<Scope extends RepositoryStatusScope>(
  scope: Scope,
  status: VcsStatusResult,
): RepositoryStatusSnapshot<Scope> {
  return { scope, read: { data: status, error: null } };
}

/**
 * A refresh failed for `scope`. A status this scope already has still answers (the stream may
 * have delivered one); otherwise the failure is recorded so callers stop waiting for an answer
 * that is not coming, instead of reporting "still checking" for as long as they are open.
 */
export function recordRepositoryFailure<Scope extends RepositoryStatusScope>(
  previous: RepositoryStatusSnapshot<Scope> | null,
  scope: Scope,
  error: unknown,
): RepositoryStatusSnapshot<Scope> {
  const kept =
    previous !== null && sameRepositoryStatusScope(previous.scope, scope)
      ? previous.read.data
      : null;
  return { scope, read: { data: kept, error: error ?? new Error("Status read failed") } };
}

/** What a snapshot says about `scope`; unknown when it belongs to another connection or cwd. */
export function readRepositoryStatus<Scope extends RepositoryStatusScope>(
  snapshot: RepositoryStatusSnapshot<Scope> | null,
  scope: Scope,
): RepositoryStatusRead {
  return snapshot !== null && sameRepositoryStatusScope(snapshot.scope, scope)
    ? snapshot.read
    : UNKNOWN_REPOSITORY_STATUS;
}
