// Pull request reads for the phone: the same source-control RPCs the web's pull
// requests page reads (list, detail, activity, diff), cached per environment in
// one bounded mobile query cache. Requests resolve the live RPC client inside
// `run` (never at module load); the typed environment facade leaves these
// methods out, as it does for the checks the thread header reads.
//
// Environment teardown imports this module, so it stays light on the launch
// graph: no pull request rules or patch parsing here (the screens own those).
//
// Read-only by construction: nothing here merges, reviews or edits. Node-owned
// pull request content lives only in the atom state — never persisted, never
// logged — and is dropped when the environment is torn down or the
// retained-key budget is exceeded.
import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestInvolvement,
  EnvironmentId,
  SourceControlChangeRequestDetail,
} from "@ryco/contracts";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import type { PullRequestsStateFilter } from "@ryco/client-runtime/state/pull-request-review";

import { readRpcClient } from "../connection/environmentApi";
import { cachedPayloadBytes } from "../persistence/cacheSize";
import { createMobileQueryCache, runWithRetry } from "./mobileQueryCache";

// A list or a pull request reopened within this window answers from cache; pull
// to refresh and a reconnect always read again.
const LIST_STALE_TIME_MS = 30_000;
const DETAIL_STALE_TIME_MS = 15_000;
const DIFF_STALE_TIME_MS = 60_000;

// Boundedness: list rows and one pull request's detail are small, a diff is
// not. Once a key has no observers it becomes evictable; each family keeps only
// its most recently released keys — enough to make back-navigation instant.
export const PULL_REQUEST_LIST_RETAINED_KEY_LIMIT = 6;
export const PULL_REQUEST_DETAIL_RETAINED_KEY_LIMIT = 8;
export const PULL_REQUEST_DIFF_RETAINED_KEY_LIMIT = 2;

const pullRequestCache = createMobileQueryCache("pull-requests");

/** The node is not connected: the screens say so instead of spinning. */
export class PullRequestNodeOfflineError extends Error {
  constructor() {
    super("This node is not connected. Reconnect to it and pull to refresh.");
    this.name = "PullRequestNodeOfflineError";
  }
}

function sourceControlClient(environmentId: EnvironmentId) {
  const client = readRpcClient(environmentId);
  if (client === null) throw new PullRequestNodeOfflineError();
  return client.sourceControl;
}

// ---------------------------------------------------------------------------
// List (one state, optionally narrowed to the viewer's involvement)
// ---------------------------------------------------------------------------

export interface PullRequestListInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly state: PullRequestsStateFilter;
  readonly involvement?: ChangeRequestInvolvement | undefined;
  /** Rows per read (the web's `PULL_REQUESTS_LIST_LIMIT`). */
  readonly limit: number;
  readonly enabled?: boolean;
}

export const pullRequestListQuery = pullRequestCache.defineQuery<
  PullRequestListInput,
  ReadonlyArray<ChangeRequest>
>({
  label: "list",
  staleTime: LIST_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_LIST_RETAINED_KEY_LIMIT,
  isEnabled: (input) =>
    (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
  buildKey: (input) =>
    `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.state}${KEY_SEP}${
      input.involvement ?? "all"
    }${KEY_SEP}${input.limit}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      sourceControlClient(input.environmentId as EnvironmentId).listChangeRequests({
        cwd: input.cwd as string,
        state: input.state,
        limit: input.limit,
        ...(input.involvement ? { involvement: input.involvement } : {}),
      }),
    ),
});

// ---------------------------------------------------------------------------
// One pull request: detail, activity, diff
// ---------------------------------------------------------------------------

export interface PullRequestInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
  readonly enabled?: boolean;
}

function pullRequestEnabled(input: PullRequestInput): boolean {
  return (
    (input.enabled ?? true) &&
    input.environmentId !== null &&
    input.cwd !== null &&
    input.number !== null
  );
}

function pullRequestKey(input: PullRequestInput): string {
  return `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.number}`;
}

export const pullRequestDetailQuery = pullRequestCache.defineQuery<
  PullRequestInput,
  SourceControlChangeRequestDetail
>({
  label: "detail",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: pullRequestEnabled,
  buildKey: pullRequestKey,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      sourceControlClient(input.environmentId as EnvironmentId).getChangeRequestDetail({
        cwd: input.cwd as string,
        reference: String(input.number),
        fullContent: true,
      }),
    ),
});

export const pullRequestActivityQuery = pullRequestCache.defineQuery<
  PullRequestInput,
  ChangeRequestActivity
>({
  label: "activity",
  staleTime: DETAIL_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_DETAIL_RETAINED_KEY_LIMIT,
  isEnabled: pullRequestEnabled,
  buildKey: pullRequestKey,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      sourceControlClient(input.environmentId as EnvironmentId).getChangeRequestActivity({
        cwd: input.cwd as string,
        reference: String(input.number),
      }),
    ),
});

export interface PullRequestDiffInput extends PullRequestInput {
  /** The head the diff is read at; a new head is a new read. */
  readonly headSha: string | null;
}

/** The raw patch; the screens split it (`readPullRequestPatchFiles`, memoized per patch). */
export const pullRequestDiffQuery = pullRequestCache.defineQuery<PullRequestDiffInput, string>({
  label: "diff",
  staleTime: DIFF_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_DIFF_RETAINED_KEY_LIMIT,
  isEnabled: pullRequestEnabled,
  buildKey: (input) => `${pullRequestKey(input)}${KEY_SEP}${input.headSha ?? "head"}`,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  // A refused (too large) diff is not retried: the host will refuse it again.
  run: (input) =>
    sourceControlClient(input.environmentId as EnvironmentId).getChangeRequestDiff({
      cwd: input.cwd as string,
      reference: String(input.number),
      ...(input.headSha ? { expectedHeadSha: input.headSha } : {}),
    }),
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

/** Environment teardown: forget every pull request this cache holds for one node. */
export function clearPullRequestStateForEnvironment(environmentId: EnvironmentId): void {
  pullRequestCache.clearEnvironment(environmentId);
}

/** Estimated bytes of one node's cached pull requests that are not on screen (Storage settings). */
export function pullRequestCacheBytes(environmentId: EnvironmentId): number {
  let bytes = 0;
  for (const [, data] of pullRequestCache.unobservedEntries(environmentId)) {
    bytes += cachedPayloadBytes(data);
  }
  return bytes;
}

/** Cache-only eviction of one node's pull requests that are not on screen. */
export function clearPullRequestCache(environmentId: EnvironmentId): void {
  pullRequestCache.clearUnobserved(environmentId);
}

export function resetPullRequestAtomsForTests(): void {
  pullRequestCache.resetForTests();
}
