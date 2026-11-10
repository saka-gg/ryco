// Pull request reads for the phone: the same source-control RPCs the web's pull
// requests page reads (list, detail, activity, diff), cached per environment in
// one bounded mobile query cache. Requests resolve the live RPC client inside
// `run` (never at module load); the typed environment facade leaves these
// methods out, as it does for the checks the thread header reads.
//
// Environment teardown imports this module, so it stays light on the launch
// graph: no pull request rules or patch parsing here (the screens own those).
//
// Reads only: the changes a reader makes (reviews, merges, branch updates) are
// sent by the pull request screen and refresh these reads afterwards. Node-owned
// pull request content lives in the atom state, is never logged, and is dropped
// from memory when the environment is torn down or the retained-key budget is
// exceeded. Lists, details and activity are also kept on the device (the saved
// query cache, `persist`), under the same rules as the cached threads: only
// while "Keep recent conversations on this device" is on, removed with the
// environment's snapshot (forgetting the node, Hub sign-out, "Clear device
// cache"). A saved copy is shown at once when a screen opens, and the live
// read replaces it; an error the node returns stays visible over it. Diffs
// and a repository's people and labels are never stored.
import type {
  ChangeRequestInvolvement,
  EnvironmentId,
  SourceControlAssigneeCandidate,
  SourceControlLabel,
} from "@ryco/contracts";
import { ChangeRequestActivity } from "@ryco/contracts/change-request-review";
import { ChangeRequest, SourceControlChangeRequestDetail } from "@ryco/contracts/source-control";
import * as Schema from "effect/Schema";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import type {
  ChangeRequestRefreshScope,
  PullRequestsStateFilter,
} from "@ryco/client-runtime/state/pull-request-review";

import { readRpcClient } from "../connection/environmentApi";
import { cachedPayloadBytes } from "../persistence/cacheSize";
import { createMobileQueryCache, runWithRetry } from "./mobileQueryCache";
import { schemaSavedQueryCodec } from "./savedQueryCodec";

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
/** People and labels of a repository, for the pickers and `@` completion. */
export const PULL_REQUEST_REPOSITORY_RETAINED_KEY_LIMIT = 4;
// A repository's people and labels change rarely; a reconnect reads them again.
const REPOSITORY_STALE_TIME_MS = 10 * 60_000;

const pullRequestCache = createMobileQueryCache("pull-requests");

/** The node is not connected: the screens say so instead of spinning. */
export class PullRequestNodeOfflineError extends Error {
  constructor() {
    super("This node is not connected. Reconnect to it and pull to refresh.");
    this.name = "PullRequestNodeOfflineError";
  }
}

/** Saved on the device: bump a version when its contract shape changes. */
const SAVED_LIST = schemaSavedQueryCodec(Schema.Array(ChangeRequest), 1);
const SAVED_DETAIL = schemaSavedQueryCodec(SourceControlChangeRequestDetail, 1);
const SAVED_ACTIVITY = schemaSavedQueryCodec(ChangeRequestActivity, 1);

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

function listKey(input: PullRequestListInput): string {
  return `${input.environmentId}${KEY_SEP}${input.cwd}${KEY_SEP}${input.state}${KEY_SEP}${
    input.involvement ?? "all"
  }${KEY_SEP}${input.limit}`;
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
  buildKey: listKey,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  persist: SAVED_LIST,
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
  persist: SAVED_DETAIL,
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
  persist: SAVED_ACTIVITY,
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

/** The raw patch; each screen that reads it splits it (`splitPullRequestPatch`). */
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
// A repository's people and labels (pickers, `@` completion)
// ---------------------------------------------------------------------------

// In this cache like every other read of the node's pull requests: bounded,
// dropped with the node, counted and cleared in Storage. Never saved on the
// device.

export interface PullRequestRepositoryInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled?: boolean;
}

function repositoryEnabled(input: PullRequestRepositoryInput): boolean {
  return (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null;
}

function repositoryKey(input: PullRequestRepositoryInput): string {
  return `${input.environmentId}${KEY_SEP}${input.cwd}`;
}

export const pullRequestRepositoryPeopleQuery = pullRequestCache.defineQuery<
  PullRequestRepositoryInput,
  ReadonlyArray<SourceControlAssigneeCandidate>
>({
  label: "people",
  staleTime: REPOSITORY_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_REPOSITORY_RETAINED_KEY_LIMIT,
  isEnabled: repositoryEnabled,
  buildKey: repositoryKey,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      sourceControlClient(input.environmentId as EnvironmentId).listIssueAssignees({
        cwd: input.cwd as string,
      }),
    ),
});

export const pullRequestRepositoryLabelsQuery = pullRequestCache.defineQuery<
  PullRequestRepositoryInput,
  ReadonlyArray<SourceControlLabel>
>({
  label: "labels",
  staleTime: REPOSITORY_STALE_TIME_MS,
  retainedKeyLimit: PULL_REQUEST_REPOSITORY_RETAINED_KEY_LIMIT,
  isEnabled: repositoryEnabled,
  buildKey: repositoryKey,
  resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
  run: (input) =>
    runWithRetry(() =>
      sourceControlClient(input.environmentId as EnvironmentId).listIssueLabels({
        cwd: input.cwd as string,
      }),
    ),
});

// ---------------------------------------------------------------------------
// Refresh after a change
// ---------------------------------------------------------------------------

/**
 * Reads again what a change to one pull request made stale, by the shared
 * `resolveChangeRequestRefreshScope`: `checkout` is every pull request read of
 * the checkout (lists, details, activity, diffs); otherwise this pull request's
 * detail and activity and the checkout's lists, as the scope says.
 */
export function refreshPullRequestReads(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly number: number;
  readonly scope: ChangeRequestRefreshScope;
}): void {
  const { environmentId, cwd, scope } = input;
  const number = String(input.number);
  pullRequestCache.refreshMatching(([label, environment, checkout, reference]) => {
    if (environment !== environmentId || checkout !== cwd) return false;
    if (scope.checkout) return true;
    switch (label) {
      case "list":
        return scope.lists;
      case "detail":
        return scope.detail && reference === number;
      case "activity":
        return scope.activity && reference === number;
      default:
        return false;
    }
  });
}

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
