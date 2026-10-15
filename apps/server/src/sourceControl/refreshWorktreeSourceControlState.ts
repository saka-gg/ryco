import { stat } from "node:fs/promises";
import path from "node:path";

import { DateTime, Duration, Effect, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CommandId,
  type GitManagerServiceError,
  type IssueState,
  type PullRequestState,
  type WorktreeId,
  type WorktreePullRequestLinkUpsert,
} from "@ryco/contracts";
import {
  readWorktreePullRequestLinks,
  selectCurrentPullRequestLink,
} from "@ryco/shared/worktreePullRequests";

import { logOnceEvery } from "../logOnceEvery.ts";
import { resolvePullRequestTerminalAt } from "../orchestration/pullRequestTerminalAt.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionWorktreeRepository } from "../persistence/Services/ProjectionWorktrees.ts";
import {
  canonicalStoragePath,
  checkoutLifecycleOwner,
  storageLifecycleLock,
} from "../storage/lifecycle.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";

/** The pull request git status reports for a checkout's branch (newest open, else newest). */
export interface DiscoveredPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PullRequestState;
  readonly headRef: string;
  readonly baseRef: string;
}

export interface RefreshWorktreeSourceControlStateInput {
  readonly worktreeId: WorktreeId;
  /**
   * Finds the pull request the checkout's branch has now. Absent: only the
   * links the workspace already has are refreshed.
   */
  readonly discoverPullRequest?:
    | ((cwd: string) => Effect.Effect<DiscoveredPullRequest | null, GitManagerServiceError>)
    | undefined;
  /** How often discovery may run for this workspace (default once a minute; 0 = now). */
  readonly discoveryIntervalMs?: number | undefined;
  /**
   * A pull request the user just merged, closed or reopened from Ryco: if the
   * checkout's branch reports it, it belongs here even when the forge gives no
   * close time.
   */
  readonly actedOnPullRequestNumber?: number | undefined;
  /**
   * How often links and the linked issue may be re-read from the forge for
   * this workspace (default 0: every call). Project-wide sweeps pass their
   * discovery interval so list polls do not re-read every link each time.
   */
  readonly linkRefreshIntervalMs?: number | undefined;
  /**
   * Pull request states the caller already holds for this repository (the
   * list it just fetched, the repository's index). An open link they still
   * report open with the same draft flag needs no forge call; anything else
   * is re-read.
   */
  readonly knownPullRequestStates?:
    | ((cwd: string) => Effect.Effect<ReadonlyMap<number, KnownPullRequestState>>)
    | undefined;
  /**
   * Issue states the caller already holds for this repository (the issue list it just
   * fetched, a batched read). A linked issue found there is not re-read from the forge.
   * Only asked for when the link refresh is due.
   */
  readonly knownIssueStates?:
    | ((cwd: string) => Effect.Effect<ReadonlyMap<number, IssueState>>)
    | undefined;
}

export interface KnownPullRequestState {
  readonly state: PullRequestState;
  readonly isDraft: boolean | null;
  /**
   * Present when the forge was just asked for this pull request (a batched state read): its
   * close time (null while open) is then authoritative too, and the link is not re-read.
   */
  readonly reported?: { readonly terminalAt: string | null };
}

/**
 * Discovery reads git status (cached server-side for the checkouts someone
 * looks at): once a minute for the workspace on screen is plenty, and a sweep
 * over a project's other workspaces can wait longer.
 */
export const WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS = 60_000;
export const WORKTREE_PULL_REQUEST_SWEEP_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const lastDiscoveryAtByWorktree = new Map<string, number>();
const lastLinkRefreshAtByWorktree = new Map<string, number>();
/** Workspaces already recorded as missing on disk by this process. */
const recordedMissingCheckouts = new Set<string>();
/** Workspaces whose missing-checkout record is being dispatched right now. */
const recordingMissingCheckouts = new Set<string>();
/**
 * An unavailable checkout (it and its parent are gone: an unmounted volume, a removed root)
 * is not re-resolved before this; only a cheap stat checks whether it came back.
 */
export const UNAVAILABLE_CHECKOUT_RETRY_MS = 15 * 60_000;
/**
 * A deleted checkout Ryco's own lifecycle owns is left to it and not re-resolved before this
 * (a stat checks whether it came back). A `removed` cleanup tombstone that still owns a live
 * workspace this long after it was first seen means the lifecycle's record never landed (a
 * partial cleanup): the checkout is then recorded as missing here after all.
 */
export const LIFECYCLE_OWNED_CHECKOUT_RETRY_MS = 5 * 60_000;
const unavailableCheckoutRetryAt = new Map<string, number>();
/** When a deleted checkout was first seen owned by a `removed` cleanup tombstone. */
const removedTombstoneSeenAt = new Map<string, number>();

export function resetWorktreePullRequestDiscoveryForTests(): void {
  lastDiscoveryAtByWorktree.clear();
  lastLinkRefreshAtByWorktree.clear();
  recordedMissingCheckouts.clear();
  recordingMissingCheckouts.clear();
  unavailableCheckoutRetryAt.clear();
  removedTombstoneSeenAt.clear();
}

function intervalDue(
  lastAtByWorktree: Map<string, number>,
  worktreeId: string,
  nowMs: number,
  intervalMs: number,
): boolean {
  const lastMs = lastAtByWorktree.get(worktreeId);
  return lastMs === undefined || nowMs - lastMs >= intervalMs;
}

/**
 * Whether a refresh with this link-refresh interval would re-read the workspace's links and
 * issue now. Read-only: the refresh itself claims the slot.
 */
export function isWorktreeLinkRefreshDue(
  worktreeId: string,
  intervalMs: number,
  nowMs: number = Date.now(),
): boolean {
  return intervalDue(lastLinkRefreshAtByWorktree, worktreeId, nowMs, intervalMs);
}

/**
 * Whether a link refresh asks the forge for this link: never for a dismissed one or an
 * earlier finished one (history), never for an open one the caller's known states still
 * report open with the same draft flag; otherwise yes (the current link is always re-read:
 * it can reopen, and the forge's close time corrects ours).
 */
export function linkNeedsForgeRead(
  link: ReturnType<typeof readWorktreePullRequestLinks>[number],
  current: ReturnType<typeof selectCurrentPullRequestLink>,
  known: KnownPullRequestState | undefined,
): boolean {
  if (link.dismissedAt) return false;
  const finished = link.state === "merged" || link.state === "closed";
  if (finished && link.number !== current?.number) return false;
  return !(
    link.state === "open" &&
    known?.state === "open" &&
    known.isDraft !== null &&
    known.isDraft === link.isDraft
  );
}

/** Link states one batched forge read returned (see `makeSweepLinkStates`). */
export interface BatchedLinkStates {
  readonly pullRequests: ReadonlyMap<number, KnownPullRequestState>;
  readonly issues: ReadonlyMap<number, IssueState>;
}

const NO_BATCHED_LINK_STATES: BatchedLinkStates = { pullRequests: new Map(), issues: new Map() };

export interface SweepLinkStates {
  readonly knownPullRequestStates: (
    cwd: string,
  ) => Effect.Effect<ReadonlyMap<number, KnownPullRequestState>>;
  readonly knownIssueStates: (cwd: string) => Effect.Effect<ReadonlyMap<number, IssueState>>;
}

/**
 * Known link states for a project-wide sweep's refreshes: what the caller holds (list rows,
 * the repository's index), plus one batched forge read for the pull requests and issues
 * those cannot answer. The batch covers only workspaces whose link refresh is due and runs
 * when the first of their refreshes asks, at most once; a sweep between refresh windows
 * makes no forge call. Fewer than two numbers read one by one as before.
 */
export const makeSweepLinkStates = (input: {
  readonly worktrees: ReadonlyArray<
    Parameters<typeof readWorktreePullRequestLinks>[0] & {
      readonly worktreeId: string;
      readonly issueNumber: number | null;
    }
  >;
  readonly linkRefreshIntervalMs: number;
  readonly knownPullRequestStates: (
    cwd: string,
  ) => Effect.Effect<ReadonlyMap<number, KnownPullRequestState>>;
  readonly knownIssues: ReadonlyMap<number, IssueState>;
  /** The batched forge read; null when the host cannot batch or the read failed. */
  readonly readLinkStates: (numbers: {
    readonly pullRequestNumbers: ReadonlyArray<number>;
    readonly issueNumbers: ReadonlyArray<number>;
  }) => Effect.Effect<BatchedLinkStates | null>;
  /** The checkout the batch asks from (the sweep's `cwd`). */
  readonly cwd: string;
}): Effect.Effect<SweepLinkStates> =>
  Effect.gen(function* () {
    const nowMs = Date.now();
    const due = input.worktrees.filter((worktree) =>
      isWorktreeLinkRefreshDue(worktree.worktreeId, input.linkRefreshIntervalMs, nowMs),
    );
    const batched =
      due.length === 0
        ? Effect.succeed(NO_BATCHED_LINK_STATES)
        : yield* Effect.cached(
            Effect.gen(function* () {
              const known = yield* input.knownPullRequestStates(input.cwd);
              const pullRequestNumbers = new Set<number>();
              const issueNumbers = new Set<number>();
              for (const worktree of due) {
                const links = readWorktreePullRequestLinks(worktree);
                const current = selectCurrentPullRequestLink(links);
                for (const link of links) {
                  if (linkNeedsForgeRead(link, current, known.get(link.number))) {
                    pullRequestNumbers.add(link.number);
                  }
                }
                if (worktree.issueNumber !== null && !input.knownIssues.has(worktree.issueNumber)) {
                  issueNumbers.add(worktree.issueNumber);
                }
              }
              if (pullRequestNumbers.size + issueNumbers.size < 2) return NO_BATCHED_LINK_STATES;
              return (
                (yield* input.readLinkStates({
                  pullRequestNumbers: [...pullRequestNumbers],
                  issueNumbers: [...issueNumbers],
                })) ?? NO_BATCHED_LINK_STATES
              );
            }),
          );
    return {
      knownPullRequestStates: (cwd) =>
        Effect.all([input.knownPullRequestStates(cwd), batched]).pipe(
          Effect.map(([known, states]) =>
            states.pullRequests.size === 0 ? known : new Map([...known, ...states.pullRequests]),
          ),
        ),
      knownIssueStates: () =>
        batched.pipe(
          Effect.map((states) =>
            states.issues.size === 0
              ? input.knownIssues
              : new Map([...input.knownIssues, ...states.issues]),
          ),
        ),
    } satisfies SweepLinkStates;
  });

function discoveryDue(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  return intervalDue(lastDiscoveryAtByWorktree, worktreeId, nowMs, intervalMs);
}

function claimDiscovery(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  if (!discoveryDue(worktreeId, nowMs, intervalMs)) return false;
  lastDiscoveryAtByWorktree.set(worktreeId, nowMs);
  return true;
}

/**
 * Whether a checkout directory is there. `deleted`: gone while its parent is
 * there. `unavailable`: its parent is missing too (an unmounted volume, a
 * removed root), an availability condition, not evidence it was deleted.
 */
type CheckoutPresence = "present" | "deleted" | "unavailable";

const checkoutPresence = (checkoutPath: string) =>
  Effect.promise(async (): Promise<CheckoutPresence> => {
    const missing = await stat(checkoutPath).then(
      () => false,
      (cause: NodeJS.ErrnoException) => cause.code === "ENOENT",
    );
    if (!missing) return "present";
    return stat(path.dirname(checkoutPath)).then(
      (parent) => (parent.isDirectory() ? "deleted" : "unavailable"),
      () => "unavailable",
    );
  });

/**
 * Records a checkout deleted outside Ryco, once, so it is no longer shown as
 * live or refreshed (and re-failing) on every source-control read. `deferred`
 * when Ryco's own lifecycle owns the path (a removal or relocation between
 * its git step and its record, a creation in flight), unless a `removed`
 * tombstone has owned it for `LIFECYCLE_OWNED_CHECKOUT_RETRY_MS`; `skipped`
 * when the workspace moved or is being recorded meanwhile. A failed record is
 * retried by the next refresh.
 */
const recordMissingCheckout = (
  worktree: { readonly worktreeId: WorktreeId },
  cwd: string,
  nowMs: number,
) =>
  Effect.gen(function* () {
    if (
      recordedMissingCheckouts.has(worktree.worktreeId) ||
      recordingMissingCheckouts.has(worktree.worktreeId)
    ) {
      return "skipped" as const;
    }
    recordingMissingCheckouts.add(worktree.worktreeId);
    const repo = yield* ProjectionWorktreeRepository;
    const engine = yield* OrchestrationEngineService;
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));
    const settled = yield* storageLifecycleLock.withPermit(
      Effect.gen(function* () {
        if ((yield* checkoutPresence(cwd)) !== "deleted") return "skipped" as const;
        const current = yield* repo.getById({ worktreeId: worktree.worktreeId });
        if (
          Option.isNone(current) ||
          current.value.worktreePath !== cwd ||
          current.value.archivedAt !== null ||
          current.value.checkoutRemovedAt
        ) {
          return "skipped" as const;
        }
        const canonical = yield* Effect.promise(() =>
          canonicalStoragePath(cwd).catch(() => path.resolve(cwd)),
        );
        const owner = yield* checkoutLifecycleOwner(sql, canonical);
        if (owner !== "removed") removedTombstoneSeenAt.delete(worktree.worktreeId);
        if (owner === null) return "record" as const;
        if (owner === "removed") {
          const seenAt = removedTombstoneSeenAt.get(worktree.worktreeId);
          if (seenAt !== undefined && nowMs - seenAt >= LIFECYCLE_OWNED_CHECKOUT_RETRY_MS) {
            return "record" as const;
          }
          if (seenAt === undefined) removedTombstoneSeenAt.set(worktree.worktreeId, nowMs);
        }
        return "deferred" as const;
      }),
    );
    if (settled !== "record") return settled;
    // Outside the admission lock: command processing takes it too.
    yield* engine.dispatch({
      type: "worktree.checkout.remove",
      commandId: CommandId.make(`server:missing-checkout:${crypto.randomUUID()}`),
      worktreeId: worktree.worktreeId,
      reason: "missing",
      removedAt: new Date().toISOString(),
    });
    recordedMissingCheckouts.add(worktree.worktreeId);
    removedTombstoneSeenAt.delete(worktree.worktreeId);
    yield* Effect.logInfo("Recorded a workspace checkout missing on disk", {
      worktreeId: worktree.worktreeId,
      path: cwd,
    });
    return "recorded" as const;
  }).pipe(
    Effect.catchCause((cause) =>
      logOnceEvery({
        key: `sourceControl.recordMissingCheckout:${worktree.worktreeId}`,
        message: "Could not record a workspace checkout missing on disk",
        level: "Warn",
        fields: { worktreeId: worktree.worktreeId, path: cwd },
        cause,
      }).pipe(Effect.as("failed" as const)),
    ),
    Effect.ensuring(Effect.sync(() => recordingMissingCheckouts.delete(worktree.worktreeId))),
  );

/**
 * Brings a workspace's pull request links and linked issue up to date: every
 * link that can still change is refreshed (open or unknown ones, and always
 * the current one), and a pull request the
 * checkout's branch has gained since — a follow-up opened anywhere — is linked.
 * Records the result as one `worktree.pull-requests.update`, only on change.
 */
export const refreshWorktreeSourceControlState = Effect.fn("refreshWorktreeSourceControlState")(
  function* (input: RefreshWorktreeSourceControlStateInput) {
    const repo = yield* ProjectionWorktreeRepository;
    const row = yield* repo.getById({ worktreeId: input.worktreeId });
    if (Option.isNone(row)) return;
    const existing = row.value;
    if (existing.worktreePath === null || existing.archivedAt !== null) return;
    if (existing.checkoutRemovedAt) return;

    const links = readWorktreePullRequestLinks(existing);
    const discoveryIntervalMs =
      input.discoveryIntervalMs ?? WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS;
    const canDiscover = input.discoverPullRequest !== undefined && existing.origin !== "main";
    const nowMs = Date.now();
    const linkRefreshDue = intervalDue(
      lastLinkRefreshAtByWorktree,
      existing.worktreeId,
      nowMs,
      input.linkRefreshIntervalMs ?? 0,
    );
    const hasLinkedState = links.length > 0 || existing.issueNumber !== null;
    // Nothing linked (or not due) and no discovery due: no forge call at all.
    if (
      !(hasLinkedState && linkRefreshDue) &&
      !(canDiscover && discoveryDue(existing.worktreeId, nowMs, discoveryIntervalMs))
    ) {
      return;
    }

    const registry = yield* SourceControlProviderRegistry;
    const cwd = existing.worktreePath;
    const engine = yield* OrchestrationEngineService;
    // An unavailable checkout is not re-resolved (a failing git spawn) until
    // its retry time, unless a stat shows it is back.
    const retryAtMs = unavailableCheckoutRetryAt.get(existing.worktreeId);
    if (retryAtMs !== undefined) {
      if (nowMs < retryAtMs && (yield* checkoutPresence(cwd)) !== "present") return;
      unavailableCheckoutRetryAt.delete(existing.worktreeId);
    }
    const provider = yield* registry.resolve({ cwd }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const presence = yield* checkoutPresence(cwd);
          if (presence === "present") return yield* Effect.fail(error);
          if (presence === "deleted" && existing.origin !== "main") {
            // Deleted outside Ryco: recorded once (which also stops these refreshes).
            // Left to Ryco's own lifecycle: not re-resolved for a while either.
            if ((yield* recordMissingCheckout(existing, cwd, nowMs)) === "deferred") {
              unavailableCheckoutRetryAt.set(
                existing.worktreeId,
                nowMs + LIFECYCLE_OWNED_CHECKOUT_RETRY_MS,
              );
            }
            return null;
          }
          // Unavailable (or the project's own checkout, never recorded as
          // removed): one short line, no stack, and no re-probe for a while.
          unavailableCheckoutRetryAt.set(
            existing.worktreeId,
            nowMs + UNAVAILABLE_CHECKOUT_RETRY_MS,
          );
          yield* logOnceEvery({
            key: `sourceControl.checkoutUnavailable:${existing.worktreeId}`,
            message: "Workspace checkout is unavailable; source control refreshes pause for it",
            level: "Info",
            window: Duration.hours(1),
            fields: { worktreeId: existing.worktreeId, path: cwd },
          });
          return null;
        }),
      ),
    );
    if (provider === null) return;
    if (linkRefreshDue) lastLinkRefreshAtByWorktree.set(existing.worktreeId, nowMs);
    const knownStates =
      linkRefreshDue && input.knownPullRequestStates
        ? yield* input.knownPullRequestStates(cwd)
        : new Map<number, KnownPullRequestState>();
    // One timestamp for both the event time and the first-observation fallback.
    const observedAt = new Date().toISOString();

    const readPullRequestState = (number: number) => {
      const known = knownStates.get(number);
      if (known?.reported !== undefined && known.isDraft !== null) {
        return Effect.succeed({
          state: known.state,
          isDraft: known.isDraft,
          reportedTerminalAt: known.reported.terminalAt,
        });
      }
      return readPullRequestStateFromForge(number);
    };
    const readPullRequestStateFromForge = (number: number) =>
      provider.getPullRequestState({ number, cwd }).pipe(
        Effect.map((pr) => ({
          state: pr.state,
          isDraft: pr.isDraft,
          reportedTerminalAt: pr.terminalAt ? DateTime.formatIso(pr.terminalAt) : null,
        })),
        Effect.catch((cause) =>
          logOnceEvery({
            key: `sourceControl.pullRequestState:${cwd}#${number}`,
            message: "Failed to refresh PR state",
            fields: { number },
            cause,
          }).pipe(Effect.as(null)),
        ),
      );

    const upserts: WorktreePullRequestLinkUpsert[] = [];
    const current = selectCurrentPullRequestLink(links);
    for (const link of linkRefreshDue ? links : []) {
      if (!linkNeedsForgeRead(link, current, knownStates.get(link.number))) continue;
      const pr = yield* readPullRequestState(link.number);
      if (pr === null) continue;
      const terminalAt = resolvePullRequestTerminalAt({
        previousState: link.state,
        previousTerminalAt: link.terminalAt,
        nextState: pr.state,
        reportedTerminalAt: pr.reportedTerminalAt,
        observedAt,
      });
      if (
        pr.state === link.state &&
        pr.isDraft === link.isDraft &&
        terminalAt === link.terminalAt
      ) {
        continue;
      }
      upserts.push({
        number: link.number,
        state: pr.state,
        isDraft: pr.isDraft,
        terminalAt,
        source: link.source,
      });
    }

    if (
      canDiscover &&
      input.discoverPullRequest &&
      claimDiscovery(existing.worktreeId, Date.now(), discoveryIntervalMs)
    ) {
      const found = yield* input.discoverPullRequest(cwd).pipe(
        Effect.catch((cause) =>
          logOnceEvery({
            key: `sourceControl.discoverPullRequest:${cwd}`,
            message: "Failed to discover the checkout's pull request",
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      // Known numbers (dismissed ones included) are never re-linked here.
      if (found && !links.some((link) => link.number === found.number)) {
        const pr = yield* readPullRequestState(found.number);
        const terminalAt = pr
          ? resolvePullRequestTerminalAt({
              previousState: null,
              previousTerminalAt: null,
              nextState: pr.state,
              reportedTerminalAt: pr.reportedTerminalAt,
              observedAt,
            })
          : null;
        // A finished pull request only belongs here when the forge says it
        // finished after the workspace existed (a reused branch name can carry
        // someone's long-merged one), or the user just acted on it from Ryco.
        // Without a forge close time it is left to a manual link: our own
        // observation time would always look recent.
        const reportedTerminalAt = pr?.reportedTerminalAt ?? null;
        const belongs =
          (pr?.state ?? found.state) === "open" ||
          found.number === input.actedOnPullRequestNumber ||
          (reportedTerminalAt !== null &&
            Date.parse(reportedTerminalAt) >= Date.parse(existing.createdAt));
        if (belongs) {
          upserts.push({
            number: found.number,
            title: found.title,
            url: found.url,
            state: pr?.state ?? found.state,
            isDraft: pr?.isDraft ?? null,
            terminalAt,
            headRefName: found.headRef,
            baseRefName: found.baseRef,
            source: "discovered",
          });
        }
      }
    }

    let nextIssueState: IssueState | null = existing.issueState ?? null;
    if (existing.issueNumber !== null && linkRefreshDue) {
      const issueNumber = existing.issueNumber;
      const knownIssueState = input.knownIssueStates
        ? (yield* input.knownIssueStates(cwd)).get(issueNumber)
        : undefined;
      const issue =
        knownIssueState !== undefined
          ? { state: knownIssueState }
          : yield* provider.getIssueState({ number: issueNumber, cwd }).pipe(
              Effect.catch((cause) =>
                logOnceEvery({
                  key: `sourceControl.issueState:${cwd}#${issueNumber}`,
                  message: "Failed to refresh issue state",
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
      if (issue !== null) {
        nextIssueState = issue.state;
      }
    }
    const issueChanged = nextIssueState !== (existing.issueState ?? null);
    if (upserts.length === 0 && !issueChanged) return;

    yield* engine.dispatch({
      type: "worktree.pull-requests.update",
      commandId: CommandId.make(`server:refresh-sc-state:${crypto.randomUUID()}`),
      worktreeId: input.worktreeId,
      ...(upserts.length > 0 ? { upserts } : {}),
      ...(issueChanged ? { issueState: nextIssueState } : {}),
      updatedAt: observedAt,
    });
  },
);
