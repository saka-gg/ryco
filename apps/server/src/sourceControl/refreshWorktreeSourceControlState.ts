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
}

/**
 * Discovery reads git status (cached server-side for the checkouts someone
 * looks at): once a minute for the workspace on screen is plenty, and a sweep
 * over a project's other workspaces can wait longer.
 */
export const WORKTREE_PULL_REQUEST_DISCOVERY_INTERVAL_MS = 60_000;
export const WORKTREE_PULL_REQUEST_SWEEP_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const lastDiscoveryAtByWorktree = new Map<string, number>();

export function resetWorktreePullRequestDiscoveryForTests(): void {
  lastDiscoveryAtByWorktree.clear();
}

function discoveryDue(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  const lastMs = lastDiscoveryAtByWorktree.get(worktreeId);
  return lastMs === undefined || nowMs - lastMs >= intervalMs;
}

function claimDiscovery(worktreeId: string, nowMs: number, intervalMs: number): boolean {
  if (!discoveryDue(worktreeId, nowMs, intervalMs)) return false;
  lastDiscoveryAtByWorktree.set(worktreeId, nowMs);
  return true;
}

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
    // Nothing linked and no discovery due: no forge call at all.
    if (
      links.length === 0 &&
      existing.issueNumber === null &&
      !(canDiscover && discoveryDue(existing.worktreeId, Date.now(), discoveryIntervalMs))
    ) {
      return;
    }

    const registry = yield* SourceControlProviderRegistry;
    const cwd = existing.worktreePath;
    const provider = yield* registry.resolve({ cwd });
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
          Effect.logWarning("Failed to refresh PR state", { cause, number }).pipe(Effect.as(null)),
        ),
      );

    const upserts: WorktreePullRequestLinkUpsert[] = [];
    const current = selectCurrentPullRequestLink(links);
    for (const link of links) {
      if (link.dismissedAt) continue;
      // Earlier finished pull requests are history; the current one is always
      // re-read (it can reopen, and the forge's close time corrects ours).
      const finished = link.state === "merged" || link.state === "closed";
      if (finished && link.number !== current?.number) continue;
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
      const found = yield* input
        .discoverPullRequest(cwd)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to discover the checkout's pull request", { cause }).pipe(
              Effect.as(null),
            ),
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
    if (existing.issueNumber !== null) {
      const issue = yield* provider
        .getIssueState({ number: existing.issueNumber, cwd })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to refresh issue state", { cause }).pipe(Effect.as(null)),
          ),
        );
      if (issue !== null) {
        nextIssueState = issue.state;
      }
    }
    const issueChanged = nextIssueState !== (existing.issueState ?? null);
    if (upserts.length === 0 && !issueChanged) return;

    const engine = yield* OrchestrationEngineService;
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
