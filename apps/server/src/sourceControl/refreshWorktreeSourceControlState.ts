import { stat } from "node:fs/promises";
import path from "node:path";

import { DateTime, Effect, Option } from "effect";
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
}

export interface KnownPullRequestState {
  readonly state: PullRequestState;
  readonly isDraft: boolean | null;
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

export function resetWorktreePullRequestDiscoveryForTests(): void {
  lastDiscoveryAtByWorktree.clear();
  lastLinkRefreshAtByWorktree.clear();
  recordedMissingCheckouts.clear();
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

function discoveryDue(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  return intervalDue(lastDiscoveryAtByWorktree, worktreeId, nowMs, intervalMs);
}

function claimDiscovery(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  if (!discoveryDue(worktreeId, nowMs, intervalMs)) return false;
  lastDiscoveryAtByWorktree.set(worktreeId, nowMs);
  return true;
}

/**
 * Whether a checkout directory is gone while its parent is there. A missing
 * parent (an unmounted volume, a removed root) is left alone: that is an
 * availability condition, not evidence the checkout was deleted.
 */
const checkoutMissingOnDisk = (checkoutPath: string) =>
  Effect.promise(async () => {
    const missing = await stat(checkoutPath).then(
      () => false,
      (cause: NodeJS.ErrnoException) => cause.code === "ENOENT",
    );
    if (!missing) return false;
    return stat(path.dirname(checkoutPath)).then(
      (parent) => parent.isDirectory(),
      () => false,
    );
  });

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
    const provider = yield* registry.resolve({ cwd }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (existing.origin === "main" || !(yield* checkoutMissingOnDisk(cwd))) {
            return yield* Effect.fail(error);
          }
          // Deleted outside Ryco: record it once, so it is no longer shown as
          // live or refreshed (and re-failing) on every source-control read.
          if (!recordedMissingCheckouts.has(existing.worktreeId)) {
            recordedMissingCheckouts.add(existing.worktreeId);
            yield* engine
              .dispatch({
                type: "worktree.checkout.remove",
                commandId: CommandId.make(`server:missing-checkout:${crypto.randomUUID()}`),
                worktreeId: existing.worktreeId,
                reason: "missing",
                removedAt: new Date().toISOString(),
              })
              .pipe(
                Effect.tap(() =>
                  Effect.logInfo("Recorded a workspace checkout missing on disk", {
                    worktreeId: existing.worktreeId,
                    path: cwd,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logDebug("Could not record a missing workspace checkout", { cause }),
                ),
              );
          }
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

    const readPullRequestState = (number: number) =>
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
      if (link.dismissedAt) continue;
      // Earlier finished pull requests are history; the current one is always
      // re-read (it can reopen, and the forge's close time corrects ours).
      const finished = link.state === "merged" || link.state === "closed";
      if (finished && link.number !== current?.number) continue;
      // Still open and unchanged in what the caller knows: nothing to re-read.
      const known = knownStates.get(link.number);
      if (
        link.state === "open" &&
        known?.state === "open" &&
        known.isDraft !== null &&
        known.isDraft === link.isDraft
      ) {
        continue;
      }
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
      const issue = yield* provider.getIssueState({ number: existing.issueNumber, cwd }).pipe(
        Effect.catch((cause) =>
          logOnceEvery({
            key: `sourceControl.issueState:${cwd}#${existing.issueNumber}`,
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
