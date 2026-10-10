import type {
  ChangeRequest,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestStack,
} from "@ryco/contracts";
import type { WorktreePullRequestLink } from "@ryco/shared/worktreePullRequests";

import { assessStack, stackPositionLabel } from "../pullRequests/rail/stackFacts.logic";
import type { StackFacts } from "../pullRequests/rail/useStackFacts";

/**
 * How a workspace's pull requests read in its one shared popover: the stack
 * the shown pull request belongs to (when the host has stacks), the other
 * open ones, then the finished ones. Every number appears once.
 */

export interface WorkspacePullRequestGroups {
  readonly stack: SourceControlChangeRequestStack | null;
  /** Open (or not yet known) links outside the stack, newest first. */
  readonly open: ReadonlyArray<WorktreePullRequestLink>;
  /** Merged or closed links outside the stack, most recently finished first. */
  readonly earlier: ReadonlyArray<WorktreePullRequestLink>;
}

function isFinished(link: WorktreePullRequestLink): boolean {
  return link.state === "merged" || link.state === "closed";
}

/**
 * Whether a workspace's chip opens its pull requests: only with more than one
 * to choose from. A single pull request keeps its chip's one click.
 */
export function hasSeveralPullRequests(links: ReadonlyArray<WorktreePullRequestLink>): boolean {
  return links.filter((link) => !link.dismissedAt).length >= 2;
}

/** A stack worth drawing: the host's own stack of at least two layers. */
export function resolveDisplayStack(
  detail: Pick<SourceControlChangeRequestDetail, "provider" | "stack"> | null | undefined,
): SourceControlChangeRequestStack | null {
  const stack = detail?.stack;
  return detail?.provider === "github" && stack && stack.entries.length >= 2 ? stack : null;
}

/** `links` are visible links in display order (`visiblePullRequestLinks`). */
export function groupWorkspacePullRequests(input: {
  readonly links: ReadonlyArray<WorktreePullRequestLink>;
  readonly stack: SourceControlChangeRequestStack | null;
}): WorkspacePullRequestGroups {
  const inStack = new Set(input.stack?.entries.map((entry) => entry.number) ?? []);
  const outside = input.links.filter((link) => !inStack.has(link.number));
  return {
    stack: input.stack,
    open: outside.filter((link) => !isFinished(link)),
    earlier: outside.filter(isFinished),
  };
}

/**
 * What a workspace carries besides the pull request on screen, in a few words
 * ("Stack 2/3 · 1 more open · 1 earlier"), or null when there is nothing else.
 */
export function describeOtherPullRequests(input: {
  readonly groups: WorkspacePullRequestGroups;
  readonly shownNumber: number | null;
}): string | null {
  const { groups, shownNumber } = input;
  const parts: string[] = [];
  const stackEntry = groups.stack?.entries.find((entry) => entry.number === shownNumber);
  if (groups.stack && stackEntry) {
    parts.push(`Stack ${stackEntry.position}/${groups.stack.entries.length}`);
  } else if (groups.stack) {
    parts.push(`Stack of ${groups.stack.entries.length}`);
  }
  const moreOpen = groups.open.filter((link) => link.number !== shownNumber).length;
  if (moreOpen > 0) parts.push(`${moreOpen} more open`);
  const earlier = groups.earlier.filter((link) => link.number !== shownNumber).length;
  if (earlier > 0) parts.push(`${earlier} earlier`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Open pull requests a workspace could link, best first: those on the
 * workspace's branch, then those stacked on it (based on the workspace branch
 * or on a linked pull request's branch), then newest. Already-linked (visible)
 * ones are left out; a dismissed one can be linked again.
 */
export function rankLinkCandidates(
  candidates: ReadonlyArray<ChangeRequest>,
  input: {
    readonly linkedNumbers: ReadonlySet<number>;
    readonly workspaceBranch: string | null;
    /** Head branches of the workspace's links. */
    readonly linkHeads: ReadonlySet<string>;
    readonly query: string;
  },
): ChangeRequest[] {
  const query = input.query.trim().replace(/^#/u, "").toLocaleLowerCase();
  const rank = (candidate: ChangeRequest) => {
    if (candidate.headRefName === input.workspaceBranch) return 0;
    if (
      candidate.baseRefName === input.workspaceBranch ||
      input.linkHeads.has(candidate.baseRefName)
    ) {
      return 1;
    }
    return 2;
  };
  return candidates
    .filter((candidate) => !input.linkedNumbers.has(candidate.number))
    .filter(
      (candidate) =>
        query.length === 0 ||
        String(candidate.number).startsWith(query) ||
        candidate.title.toLocaleLowerCase().includes(query) ||
        candidate.headRefName.toLocaleLowerCase().includes(query),
    )
    .toSorted((left, right) => rank(left) - rank(right) || right.number - left.number);
}

/**
 * What `StackSummary` needs about a stack seen from a workspace popover:
 * read-only (no merge-through), positioned at the pull request the detail is for.
 */
export function stackFactsFromDetail(input: {
  readonly stack: SourceControlChangeRequestStack;
  readonly incomplete: boolean;
  readonly currentNumber: number;
}): StackFacts {
  return {
    stack: input.stack,
    assessment: assessStack(input.stack),
    position: stackPositionLabel(input.stack),
    incomplete: input.incomplete,
    canMergeThrough: false,
    currentNumber: input.currentNumber,
    selectLayer: () => undefined,
  };
}
