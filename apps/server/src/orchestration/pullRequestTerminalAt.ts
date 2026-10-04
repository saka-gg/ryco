import type { PullRequestState } from "@ryco/contracts";

function isValidIso(value: string | null): value is string {
  return value !== null && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * The single rule for `Worktree.prTerminalAt`: when the PR reached its
 * **current** merged/closed state. That is the forge-reported
 * `mergedAt`/`closedAt` when available, else the time Ryco first recorded that
 * terminal state (an upper bound on the true close time). `null` while the PR
 * is open, unknown, or absent.
 *
 * Used by the source-control refresh, the in-memory projector, and the SQL
 * projection pipeline (which also derives it for legacy events lacking it).
 */
export function resolvePullRequestTerminalAt(input: {
  readonly previousState: PullRequestState | null;
  readonly previousTerminalAt: string | null;
  readonly nextState: PullRequestState | null;
  /** Forge `mergedAt`/`closedAt` as ISO, when the forge reports one. */
  readonly reportedTerminalAt: string | null;
  /** When this state is being recorded. */
  readonly observedAt: string;
}): string | null {
  if (input.nextState !== "merged" && input.nextState !== "closed") return null;
  // Forge truth also corrects an earlier fallback or the upgrade backfill.
  if (isValidIso(input.reportedTerminalAt)) return input.reportedTerminalAt;
  if (input.previousState === input.nextState && isValidIso(input.previousTerminalAt)) {
    // Keep the first observation of this terminal state.
    return input.previousTerminalAt;
  }
  return input.observedAt;
}

/**
 * `prTerminalAt` for a `worktree.sourceControlStateUpdated` payload applied on
 * top of the stored worktree. Shared by the in-memory projector and the SQL
 * projection pipeline. Events written before the field existed carry no value,
 * so it is derived from the stored state and the event's `updatedAt`.
 */
export function resolveEventPullRequestTerminalAt(
  payload: {
    readonly prState: PullRequestState | null;
    readonly prTerminalAt?: string | null | undefined;
    readonly updatedAt: string;
  },
  existing:
    | {
        readonly prState?: PullRequestState | null | undefined;
        readonly prTerminalAt?: string | null | undefined;
      }
    | undefined,
): string | null {
  if (payload.prTerminalAt !== undefined) return payload.prTerminalAt;
  return resolvePullRequestTerminalAt({
    previousState: existing?.prState ?? null,
    previousTerminalAt: existing?.prTerminalAt ?? null,
    nextState: payload.prState,
    reportedTerminalAt: null,
    observedAt: payload.updatedAt,
  });
}
