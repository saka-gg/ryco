/**
 * A workspace's pull request links: every pull request it has carried (a
 * merged one and its follow-up, stack layers, manual links), and which one is
 * current. The server derives the list in the decider and stores it; clients
 * read it, and derive a single link from the flat `pr*` fields when a server
 * predates links. One module so the server, the web app and the phone app
 * can never disagree on which pull request is current.
 */
import type {
  PullRequestState,
  WorktreePullRequestLink,
  WorktreePullRequestLinkSource,
} from "@ryco/contracts";

export type { WorktreePullRequestLink };

/** A link change as the decider receives it (missing fields keep what is stored). */
export interface WorktreePullRequestLinkUpsert {
  readonly number: number;
  readonly title?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly state: PullRequestState | null;
  readonly isDraft: boolean | null;
  /** Omitted: kept while the terminal state holds, else the change time. */
  readonly terminalAt?: string | null | undefined;
  readonly headRefName?: string | null | undefined;
  readonly baseRefName?: string | null | undefined;
  readonly source: WorktreePullRequestLinkSource;
  /** Linked by hand: brings a dismissed link back (refreshes never do). */
  readonly restore?: boolean | undefined;
}

/** The flat fields older readers (and the settlement rule) use: the current link. */
export interface WorktreeCurrentPullRequestFields {
  readonly prNumber: number | null;
  readonly prTitle: string | null;
  readonly prState: PullRequestState | null;
  readonly prIsDraft: boolean | null;
  readonly prTerminalAt: string | null;
}

/** What a worktree looks like to the helpers here, from any snapshot generation. */
export interface WorktreePullRequestSource {
  readonly prNumber: number | null;
  readonly prTitle: string | null;
  readonly prState?: PullRequestState | null | undefined;
  readonly prIsDraft?: boolean | null | undefined;
  readonly prTerminalAt?: string | null | undefined;
  readonly origin?: string | undefined;
  readonly pullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
}

function isTerminal(state: PullRequestState | null): boolean {
  return state === "merged" || state === "closed";
}

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Stored order: oldest link first (links without a time first), then by number. */
function compareStored(left: WorktreePullRequestLink, right: WorktreePullRequestLink): number {
  const leftMs = timeMs(left.linkedAt) ?? Number.NEGATIVE_INFINITY;
  const rightMs = timeMs(right.linkedAt) ?? Number.NEGATIVE_INFINITY;
  if (leftMs !== rightMs) return leftMs < rightMs ? -1 : 1;
  return left.number - right.number;
}

/**
 * Display and selection order: open (or not yet known) first, newest number
 * first; then merged/closed, most recently finished first.
 */
export function comparePullRequestLinks(
  left: WorktreePullRequestLink,
  right: WorktreePullRequestLink,
): number {
  const leftDone = isTerminal(left.state);
  const rightDone = isTerminal(right.state);
  if (leftDone !== rightDone) return leftDone ? 1 : -1;
  if (leftDone) {
    const leftMs = timeMs(left.terminalAt) ?? Number.NEGATIVE_INFINITY;
    const rightMs = timeMs(right.terminalAt) ?? Number.NEGATIVE_INFINITY;
    if (leftMs !== rightMs) return leftMs > rightMs ? -1 : 1;
  }
  return right.number - left.number;
}

/** Links the user has not dismissed, current first. */
export function visiblePullRequestLinks(
  links: ReadonlyArray<WorktreePullRequestLink>,
): WorktreePullRequestLink[] {
  return links.filter((link) => !link.dismissedAt).toSorted(comparePullRequestLinks);
}

/** The pull request a workspace is about now: the newest open one, else the last finished. */
export function selectCurrentPullRequestLink(
  links: ReadonlyArray<WorktreePullRequestLink>,
): WorktreePullRequestLink | null {
  return visiblePullRequestLinks(links)[0] ?? null;
}

export function currentPullRequestFields(
  links: ReadonlyArray<WorktreePullRequestLink>,
): WorktreeCurrentPullRequestFields {
  const current = selectCurrentPullRequestLink(links);
  return {
    prNumber: current?.number ?? null,
    prTitle: current?.title ?? null,
    prState: current?.state ?? null,
    prIsDraft: current?.isDraft ?? null,
    prTerminalAt: current?.terminalAt ?? null,
  };
}

function resolveTerminalAt(
  existing: WorktreePullRequestLink | undefined,
  upsert: WorktreePullRequestLinkUpsert,
  at: string,
): string | null {
  if (!isTerminal(upsert.state)) return null;
  // A stated value wins, even null ("finished, time unknown").
  if (upsert.terminalAt !== undefined) return upsert.terminalAt;
  // Same finished state as before: keep the first observation.
  if (existing && existing.state === upsert.state && existing.terminalAt) {
    return existing.terminalAt;
  }
  return at;
}

function mergeLink(
  existing: WorktreePullRequestLink | undefined,
  upsert: WorktreePullRequestLinkUpsert,
  at: string,
): WorktreePullRequestLink {
  const keep = <T>(next: T | undefined, previous: T): T => (next === undefined ? previous : next);
  return {
    number: upsert.number,
    title: keep(upsert.title, existing?.title ?? null),
    url: keep(upsert.url, existing?.url ?? null),
    state: upsert.state,
    isDraft: upsert.isDraft,
    terminalAt: resolveTerminalAt(existing, upsert, at),
    headRefName: keep(upsert.headRefName, existing?.headRefName ?? null),
    baseRefName: keep(upsert.baseRefName, existing?.baseRefName ?? null),
    // The first way a pull request arrived stays its provenance.
    source: existing?.source ?? upsert.source,
    linkedAt: existing ? existing.linkedAt : at,
    // Linking by hand brings a dismissed pull request back; nothing else does
    // (a refresh of a manual link racing its dismissal must not undo it).
    dismissedAt: upsert.restore === true ? null : (existing?.dismissedAt ?? null),
  };
}

export function applyPullRequestLinkChanges(
  links: ReadonlyArray<WorktreePullRequestLink>,
  changes: {
    readonly upserts?: ReadonlyArray<WorktreePullRequestLinkUpsert> | undefined;
    readonly dismissals?: ReadonlyArray<number> | undefined;
  },
  at: string,
): WorktreePullRequestLink[] {
  const byNumber = new Map(links.map((link) => [link.number, link] as const));
  for (const upsert of changes.upserts ?? []) {
    if (!Number.isSafeInteger(upsert.number) || upsert.number <= 0) continue;
    byNumber.set(upsert.number, mergeLink(byNumber.get(upsert.number), upsert, at));
  }
  for (const number of changes.dismissals ?? []) {
    const existing = byNumber.get(number);
    if (existing && !existing.dismissedAt) byNumber.set(number, { ...existing, dismissedAt: at });
  }
  return [...byNumber.values()].toSorted(compareStored);
}

/** The links a workspace starts with. */
export function initialPullRequestLinks(input: {
  readonly origin: string;
  readonly prNumber: number | null;
  readonly prTitle: string | null;
  readonly createdAt: string;
}): WorktreePullRequestLink[] {
  if (input.prNumber === null) return [];
  return applyPullRequestLinkChanges(
    [],
    {
      upserts: [
        {
          number: input.prNumber,
          title: input.prTitle,
          state: null,
          isDraft: null,
          source: input.origin === "pr" ? "origin" : "created",
        },
      ],
    },
    input.createdAt,
  );
}

/**
 * A workspace's links from any snapshot generation: the stored list, or one
 * link derived from the flat fields of a server that predates links.
 */
export function readWorktreePullRequestLinks(
  worktree: WorktreePullRequestSource,
): ReadonlyArray<WorktreePullRequestLink> {
  if (worktree.pullRequests !== undefined) return worktree.pullRequests;
  if (worktree.prNumber === null) return [];
  return [
    {
      number: worktree.prNumber,
      title: worktree.prTitle,
      url: null,
      state: worktree.prState ?? null,
      isDraft: worktree.prIsDraft ?? null,
      terminalAt: worktree.prTerminalAt ?? null,
      headRefName: null,
      baseRefName: null,
      source: worktree.origin === "pr" ? "origin" : "created",
      linkedAt: null,
      dismissedAt: null,
    },
  ];
}

/**
 * Whether the server discovers this workspace's pull requests (it stores
 * links and is not the project's main checkout). Then a finished pull request
 * git status reports but the workspace does not carry is stale (a reused
 * branch name's old one); elsewhere git status is the only source there is.
 */
export function workspaceDiscoversPullRequests(
  worktree: Pick<WorktreePullRequestSource, "origin" | "pullRequests"> | null | undefined,
): boolean {
  return worktree != null && worktree.pullRequests !== undefined && worktree.origin !== "main";
}

/**
 * Applies a `worktree.sourceControlStateUpdated` payload to stored links.
 * Current events carry the resulting list. Older events either relinked the
 * workspace (`prNumber` set) or refreshed its one pull request (`prNumber`
 * absent); both become an upsert so replaying history keeps every link.
 */
export function applySourceControlStateToPullRequestLinks(
  links: ReadonlyArray<WorktreePullRequestLink>,
  payload: {
    readonly prNumber?: number | null | undefined;
    readonly prTitle?: string | null | undefined;
    readonly prState: PullRequestState | null;
    readonly prIsDraft: boolean | null;
    readonly prTerminalAt?: string | null | undefined;
    readonly pullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
    readonly updatedAt: string;
  },
  currentNumberBefore: number | null,
): ReadonlyArray<WorktreePullRequestLink> {
  if (payload.pullRequests !== undefined) return payload.pullRequests;
  const number = payload.prNumber === undefined ? currentNumberBefore : payload.prNumber;
  if (number === null) return links;
  return applyPullRequestLinkChanges(
    links,
    {
      upserts: [
        {
          number,
          ...(payload.prTitle !== undefined ? { title: payload.prTitle } : {}),
          state: payload.prState,
          isDraft: payload.prIsDraft,
          ...(payload.prTerminalAt !== undefined ? { terminalAt: payload.prTerminalAt } : {}),
          source: "created",
        },
      ],
    },
    payload.updatedAt,
  );
}

/**
 * The pull request a thread is judged by: the pull requests that existed
 * while it was active, plus the next one linked after its last activity when
 * every one it had was already finished by then (the next one is what its
 * work produced). So an old thread that shipped #675 stays settled when the
 * workspace later carries #677, a thread still iterating on open #675 when
 * it went quiet stays with #675, and the thread asked for a follow-up after
 * #675 merged waits for #677.
 */
export function resolveThreadPullRequestLink(
  links: ReadonlyArray<WorktreePullRequestLink>,
  threadAnchorAt: string | null,
): WorktreePullRequestLink | null {
  const visible = links.filter((link) => !link.dismissedAt);
  const anchorMs = timeMs(threadAnchorAt);
  if (anchorMs === null) return selectCurrentPullRequestLink(visible);
  const before = visible.filter((link) => {
    const linkedMs = timeMs(link.linkedAt);
    return linkedMs === null || linkedMs <= anchorMs;
  });
  // Finished before the thread's last activity, by a known time. An unknown
  // finish time keeps the thread with what it had (it may still be its PR).
  const finishedByAnchor = (link: WorktreePullRequestLink) => {
    if (!isTerminal(link.state)) return false;
    const terminalMs = timeMs(link.terminalAt);
    return terminalMs !== null && terminalMs <= anchorMs;
  };
  const firstAfter = before.every(finishedByAnchor)
    ? visible
        .filter((link) => {
          const linkedMs = timeMs(link.linkedAt);
          return linkedMs !== null && linkedMs > anchorMs;
        })
        .toSorted(compareStored)[0]
    : undefined;
  return selectCurrentPullRequestLink(firstAfter ? [...before, firstAfter] : before);
}

/** Whether two link lists say the same thing (store change detection). */
export function pullRequestLinksEqual(
  left: ReadonlyArray<WorktreePullRequestLink> | undefined,
  right: ReadonlyArray<WorktreePullRequestLink> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((link, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      link.number === other.number &&
      link.title === other.title &&
      link.url === other.url &&
      link.state === other.state &&
      link.isDraft === other.isDraft &&
      link.terminalAt === other.terminalAt &&
      link.headRefName === other.headRefName &&
      link.baseRefName === other.baseRefName &&
      link.source === other.source &&
      link.linkedAt === other.linkedAt &&
      link.dismissedAt === other.dismissedAt
    );
  });
}
