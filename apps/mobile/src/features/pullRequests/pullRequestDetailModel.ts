import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestReviewThread,
  SourceControlChangeRequestDetail,
  SourceControlLabel,
} from "@ryco/contracts";
import {
  buildConversationTimeline,
  CHECK_STATE_LABEL,
  checkStateOverall,
  commitChecksOverall,
  FILE_STATUS_LETTER,
  formatWorkflowDuration,
  groupChangeRequestTimeline,
  orderChangeRequestFiles,
  type ChangeRequestCheckGroup,
  type ChangeRequestChecksOverall,
  type ChangeRequestChecksSummary,
  type ChangeRequestNextAction,
  type ChangeRequestNextActionTone,
  type ChangeRequestTimelineGroup,
  type ChangeRequestTimelineOtherItem,
  type PullRequestFileStatus,
} from "@ryco/client-runtime/state/pull-request-review";
import { epochMillis } from "@ryco/shared/changeRequestChecks";

import { formatPullRequestDiffStat, type PullRequestPatchFile } from "./pullRequestDiffModel";

/**
 * What the phone's pull request screen shows: the header, the checks grouped
 * like the web's Checks tab, the conversation in the web's display order
 * (`groupChangeRequestTimeline` + `buildConversationTimeline`) as plain rows,
 * and the files in reading order. React-free; the screen only lays these out.
 */

export type PullRequestDetailTab = "conversation" | "checks" | "files";

export const PULL_REQUEST_DETAIL_TABS: ReadonlyArray<{
  readonly value: PullRequestDetailTab;
  readonly label: string;
}> = [
  { value: "conversation", label: "Conversation" },
  { value: "checks", label: "Checks" },
  { value: "files", label: "Files" },
];

// ── Header ────────────────────────────────────────────────────────────

export type PullRequestStateTone = "open" | "draft" | "merged" | "closed";

export interface PullRequestHeader {
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly stateLabel: string;
  readonly stateTone: PullRequestStateTone;
  readonly author: string | null;
  readonly headRefName: string;
  readonly baseRefName: string;
  /** "+12 −3 · 4 files", or null when nothing is known yet. */
  readonly changeSummary: string | null;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  /** The description; null when it is empty (or the detail has not loaded). */
  readonly body: string | null;
  readonly headSha: string | null;
}

type HeaderSource = Pick<
  ChangeRequest,
  | "number"
  | "title"
  | "url"
  | "state"
  | "isDraft"
  | "author"
  | "headRefName"
  | "baseRefName"
  | "additions"
  | "deletions"
  | "changedFiles"
  | "labels"
  | "headSha"
>;

function stateOf(entry: Pick<ChangeRequest, "state" | "isDraft">): {
  readonly label: string;
  readonly tone: PullRequestStateTone;
} {
  if (entry.state === "merged") return { label: "Merged", tone: "merged" };
  if (entry.state === "closed") return { label: "Closed", tone: "closed" };
  return entry.isDraft === true
    ? { label: "Draft", tone: "draft" }
    : { label: "Open", tone: "open" };
}

function changeSummary(entry: HeaderSource): string | null {
  const parts: string[] = [];
  if (entry.additions !== undefined || entry.deletions !== undefined) {
    const stat = formatPullRequestDiffStat(entry.additions ?? 0, entry.deletions ?? 0);
    if (stat) parts.push(stat);
  }
  if (entry.changedFiles !== undefined) {
    parts.push(`${entry.changedFiles} ${entry.changedFiles === 1 ? "file" : "files"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The header from the detail, or from the list row while the detail loads. */
export function derivePullRequestHeader(
  detail: SourceControlChangeRequestDetail | null,
  summary: ChangeRequest | null,
): PullRequestHeader | null {
  const source: (HeaderSource & { readonly body?: string }) | null = detail ?? summary;
  if (source === null) return null;
  const state = stateOf(source);
  const body = detail?.body.trim() ? detail.body : null;
  return {
    number: source.number,
    title: source.title,
    url: source.url.trim() ? source.url : null,
    stateLabel: state.label,
    stateTone: state.tone,
    author: source.author ?? null,
    headRefName: source.headRefName,
    baseRefName: source.baseRefName,
    changeSummary: changeSummary(source),
    labels: source.labels ?? [],
    body,
    headSha: source.headSha ?? null,
  };
}

/** The merge box's next step, as one line under the header (null until the detail loads). */
export interface PullRequestNextStep {
  readonly label: string;
  readonly reason: string | null;
  readonly tone: ChangeRequestNextActionTone;
}

export function describePullRequestNextStep(
  action: ChangeRequestNextAction | null,
): PullRequestNextStep | null {
  if (action === null || action.kind === "merged" || action.kind === "closed") return null;
  return { label: action.label, reason: action.reason ?? null, tone: action.tone };
}

// ── Checks ────────────────────────────────────────────────────────────

const CHECK_GROUP_TITLE: Record<ChangeRequestCheckGroup, string> = {
  attention: "Needs attention",
  running: "Running",
  completed: "Completed",
  skipped: "Skipped",
};

export interface PullRequestCheckRow {
  readonly id: string;
  readonly label: string;
  readonly workflowName: string | null;
  readonly stateLabel: string;
  readonly overall: ChangeRequestChecksOverall;
  /** "2m 11s" for a finished check. */
  readonly duration: string | null;
  readonly url: string | null;
  readonly required: boolean;
}

export interface PullRequestCheckSection {
  readonly group: ChangeRequestCheckGroup;
  readonly title: string;
  readonly rows: ReadonlyArray<PullRequestCheckRow>;
}

/** The checks by display group (attention first), each group in the host's order. */
export function derivePullRequestCheckSections(
  summary: ChangeRequestChecksSummary,
): ReadonlyArray<PullRequestCheckSection> {
  return summary.segments.map((segment) => ({
    group: segment.group,
    title: CHECK_GROUP_TITLE[segment.group],
    rows: summary.groups[segment.group].map((check) => ({
      id: check.id,
      label: check.label,
      workflowName: check.workflowName,
      stateLabel: CHECK_STATE_LABEL[check.state],
      overall: checkStateOverall(check.state),
      duration: formatWorkflowDuration(check.durationMs),
      url: check.url,
      required: check.required === true,
    })),
  }));
}

// ── Conversation ──────────────────────────────────────────────────────

export interface PullRequestCommentModel {
  readonly id: string;
  readonly author: string | null;
  readonly atMs: number | null;
  readonly body: string;
}

export interface PullRequestThreadModel {
  readonly id: string;
  /** "src/a.ts:12", or the path for a file-level thread. */
  readonly location: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly comments: ReadonlyArray<PullRequestCommentModel>;
  /** Comments the host has beyond the ones read (paged threads). */
  readonly moreComments: number;
}

export interface PullRequestCommitModel {
  readonly oid: string;
  readonly shortOid: string;
  readonly headline: string;
  readonly checks: ChangeRequestChecksOverall | null;
}

export type PullRequestReviewVerdict = "approved" | "changes-requested" | "commented" | "dismissed";

export type PullRequestConversationRow =
  | {
      readonly kind: "comment";
      readonly id: string;
      readonly author: string | null;
      readonly atMs: number | null;
      readonly body: string;
    }
  | {
      readonly kind: "review";
      readonly id: string;
      readonly author: string | null;
      readonly atMs: number | null;
      readonly verdict: PullRequestReviewVerdict;
      /** "approved these changes", "requested changes", … */
      readonly text: string;
      readonly body: string | null;
      readonly threads: ReadonlyArray<PullRequestThreadModel>;
    }
  | {
      readonly kind: "commits";
      readonly id: string;
      readonly author: string | null;
      readonly atMs: number | null;
      readonly text: string;
      readonly commits: ReadonlyArray<PullRequestCommitModel>;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly author: string | null;
      readonly atMs: number | null;
      readonly text: string;
    }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly author: string | null;
      readonly atMs: number | null;
      readonly thread: PullRequestThreadModel;
    };

export interface PullRequestConversation {
  readonly rows: ReadonlyArray<PullRequestConversationRow>;
  /** Older activity was left out to stay within the host's page budget. */
  readonly truncated: boolean;
}

function andList(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function shortSha(oid: string | undefined): string {
  return oid ? oid.slice(0, 7) : "an earlier commit";
}

function people(logins: ReadonlyArray<string>, actor: string | undefined): string {
  return andList(logins.map((login) => (login === actor ? "themselves" : `@${login}`)));
}

function threadModel(thread: ChangeRequestReviewThread): PullRequestThreadModel {
  const line = thread.line ?? thread.originalLine ?? null;
  return {
    id: thread.id,
    location:
      thread.subjectType === "file" || line === null ? thread.path : `${thread.path}:${line}`,
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    comments: thread.comments
      .filter((comment) => comment.isMinimized !== true)
      .map((comment) => ({
        id: comment.id,
        author: comment.author.login,
        atMs: epochMillis(comment.createdAt),
        body: comment.body,
      })),
    moreComments: Math.max(0, thread.totalComments - thread.comments.length),
  };
}

const VERDICT: Record<
  string,
  { readonly verdict: PullRequestReviewVerdict; readonly text: string }
> = {
  approved: { verdict: "approved", text: "approved these changes" },
  changes_requested: { verdict: "changes-requested", text: "requested changes" },
  commented: { verdict: "commented", text: "reviewed" },
  dismissed: { verdict: "dismissed", text: "reviewed (dismissed)" },
  pending: { verdict: "commented", text: "started a review" },
};

/** One timeline event as the sentence after the actor's name ("closed this"). */
export function describeTimelineEvent(
  item: Exclude<ChangeRequestTimelineOtherItem, { readonly kind: "comment" }>,
): string {
  switch (item.kind) {
    case "force-pushed":
      return `force-pushed ${shortSha(item.beforeOid)} → ${shortSha(item.afterOid)}`;
    case "renamed":
      return `changed the title from “${item.previousTitle}” to “${item.currentTitle}”`;
    case "merged":
      return `merged ${item.commitOid ? shortSha(item.commitOid) : "this"}${
        item.baseRefName ? ` into ${item.baseRefName}` : ""
      }`;
    case "closed":
      return "closed this";
    case "reopened":
      return "reopened this";
    case "ready-for-review":
      return "marked this ready for review";
    case "converted-to-draft":
      return "converted this to a draft";
    case "head-ref-deleted":
      return "deleted the head branch";
    case "head-ref-restored":
      return "restored the head branch";
    case "base-ref-changed":
      return `changed the base${item.previousRefName ? ` from ${item.previousRefName}` : ""}${
        item.currentRefName ? ` to ${item.currentRefName}` : ""
      }`;
    case "cross-referenced":
      return `mentioned this in #${item.source.number} ${item.source.title}${
        item.willCloseTarget ? " (closes this)" : ""
      }`;
    case "auto-merge-enabled":
      return `enabled auto-merge${item.mergeMethod ? ` (${item.mergeMethod})` : ""}`;
    case "auto-merge-disabled":
      return "disabled auto-merge";
    case "review-dismissed":
      return `dismissed ${item.reviewAuthor ? `@${item.reviewAuthor}’s` : "a"} review${
        item.message ? `: ${item.message}` : ""
      }`;
  }
}

function eventsText(
  group: Extract<ChangeRequestTimelineGroup, { readonly kind: "events" }>,
): string {
  const { summary } = group;
  const actor = group.actor?.login;
  const labels = (list: ReadonlyArray<SourceControlLabel>) =>
    andList(list.map((label) => label.name));
  const parts: string[] = [];
  if (summary.labelsAdded.length > 0) parts.push(`added ${labels(summary.labelsAdded)}`);
  if (summary.labelsRemoved.length > 0) parts.push(`removed ${labels(summary.labelsRemoved)}`);
  if (summary.assigned.length > 0) parts.push(`assigned ${people(summary.assigned, actor)}`);
  if (summary.unassigned.length > 0) parts.push(`unassigned ${people(summary.unassigned, actor)}`);
  if (summary.reviewRequested.length > 0) {
    parts.push(
      `requested review from ${people(
        summary.reviewRequested.map((entry) => entry.reviewer),
        undefined,
      )}`,
    );
  }
  if (summary.reviewRequestRemoved.length > 0) {
    parts.push(
      `removed the review request for ${people(
        summary.reviewRequestRemoved.map((entry) => entry.reviewer),
        undefined,
      )}`,
    );
  }
  return parts.join(", ");
}

function groupRow(group: ChangeRequestTimelineGroup): PullRequestConversationRow {
  switch (group.kind) {
    case "commits":
      return {
        kind: "commits",
        id: group.id,
        author: group.actor?.login ?? null,
        atMs: epochMillis(group.lastAt),
        text:
          group.commits.length === 1 ? "pushed a commit" : `pushed ${group.commits.length} commits`,
        commits: group.commits.map((commit) => ({
          oid: commit.oid,
          shortOid: commit.shortOid,
          headline: commit.messageHeadline,
          checks: commitChecksOverall(commit.checkState),
        })),
      };
    case "events":
      return {
        kind: "event",
        id: group.id,
        author: group.actor?.login ?? null,
        atMs: epochMillis(group.lastAt),
        text: eventsText(group),
      };
    case "review": {
      const { review } = group;
      const verdict = VERDICT[review.state] ?? VERDICT["commented"]!;
      return {
        kind: "review",
        id: group.id,
        author: review.actor?.login ?? null,
        atMs: epochMillis(review.createdAt),
        verdict: verdict.verdict,
        text: verdict.text,
        body: review.body.trim() ? review.body : null,
        threads: group.threads.map(threadModel),
      };
    }
    case "item": {
      const { item } = group;
      if (item.kind === "comment") {
        return {
          kind: "comment",
          id: group.id,
          author: item.actor?.login ?? null,
          atMs: epochMillis(item.createdAt),
          body: item.body,
        };
      }
      return {
        kind: "event",
        id: group.id,
        author: item.actor?.login ?? null,
        atMs: epochMillis(item.createdAt),
        text: describeTimelineEvent(item),
      };
    }
  }
}

/** The conversation in the web's display order, minimized comments left out. */
export function derivePullRequestConversation(
  activity: Pick<ChangeRequestActivity, "timeline" | "reviewThreads" | "timelineTruncated">,
): PullRequestConversation {
  const timeline = activity.timeline.filter(
    (item) => item.kind !== "comment" || item.isMinimized !== true,
  );
  const display = groupChangeRequestTimeline(timeline, activity.reviewThreads);
  const rows = buildConversationTimeline(display).map((entry): PullRequestConversationRow => {
    if (entry.kind === "group") return groupRow(entry.group);
    const thread = threadModel(entry.thread);
    return {
      kind: "thread",
      id: entry.id,
      author: thread.comments[0]?.author ?? null,
      atMs: thread.comments[0]?.atMs ?? null,
      thread,
    };
  });
  return { rows, truncated: activity.timelineTruncated };
}

// ── Files ─────────────────────────────────────────────────────────────

export interface PullRequestFileRow {
  readonly path: string;
  readonly previousPath: string | null;
  /** `A`, `D`, `M`, `R`; null while only the detail's file list is known. */
  readonly statusLetter: string | null;
  readonly status: PullRequestFileStatus | null;
  readonly diffStat: string;
  readonly binary: boolean;
}

/**
 * The Files tab's rows: the parsed diff's files, or (while the diff loads, or
 * when the host refused it) the detail's own file list in reading order, so
 * the tab never claims there are no files.
 */
export function derivePullRequestFileRows(
  files: ReadonlyArray<PullRequestPatchFile> | null,
  detailFiles: SourceControlChangeRequestDetail["files"] | null | undefined,
): ReadonlyArray<PullRequestFileRow> {
  if (files !== null) {
    return files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      statusLetter: FILE_STATUS_LETTER[file.status],
      status: file.status,
      diffStat: formatPullRequestDiffStat(file.additions, file.deletions),
      binary: file.binary,
    }));
  }
  return orderChangeRequestFiles(detailFiles ?? []).map((file) => ({
    path: file.path,
    previousPath: null,
    statusLetter: null,
    status: null,
    diffStat: formatPullRequestDiffStat(file.additions, file.deletions),
    binary: false,
  }));
}

// ── Routes ────────────────────────────────────────────────────────────

/** The `:number` route param: a pull request number is a positive integer, nothing else. */
export function parsePullRequestNumberParam(
  value: string | number | readonly string[] | undefined,
): number | null {
  const raw =
    typeof value === "number" ? String(value) : typeof value === "string" ? value : value?.[0];
  if (raw === undefined || !/^\d+$/u.test(raw.trim())) return null;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// ── Screen items ──────────────────────────────────────────────────────

export type PullRequestDetailItem =
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      readonly detail: string | null;
    }
  | { readonly kind: "description"; readonly key: string; readonly body: string }
  | {
      readonly kind: "conversation";
      readonly key: string;
      readonly row: PullRequestConversationRow;
    }
  | { readonly kind: "check"; readonly key: string; readonly row: PullRequestCheckRow }
  | { readonly kind: "file"; readonly key: string; readonly row: PullRequestFileRow }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

export type PullRequestDiffReadStatus = "waiting" | "loading" | "ready" | "oversized" | "error";

/**
 * The rows under the header for the selected tab, as one virtualized list:
 * the description and conversation, the checks by group, or the files.
 */
export function derivePullRequestDetailItems(input: {
  readonly tab: PullRequestDetailTab;
  readonly header: Pick<PullRequestHeader, "body"> | null;
  /** The host's name ("GitHub"), for the notes that send the reader there. */
  readonly hostName: string;
  readonly detail: Pick<SourceControlChangeRequestDetail, "files"> | null;
  readonly activity: Pick<
    ChangeRequestActivity,
    "timeline" | "reviewThreads" | "timelineTruncated"
  > | null;
  /** The host serves activity reads; false while the host is still unknown. */
  readonly activitySupported: boolean;
  readonly hostKnown: boolean;
  readonly checks: ChangeRequestChecksSummary;
  readonly diff: {
    readonly status: PullRequestDiffReadStatus;
    readonly error: string | null;
    readonly files: ReadonlyArray<PullRequestPatchFile> | null;
  };
}): ReadonlyArray<PullRequestDetailItem> {
  const items: PullRequestDetailItem[] = [];
  switch (input.tab) {
    case "conversation": {
      if (input.header?.body) {
        items.push({ kind: "description", key: "description", body: input.header.body });
      }
      if (input.activity !== null) {
        const conversation = derivePullRequestConversation(input.activity);
        if (conversation.truncated) {
          items.push({
            kind: "note",
            key: "truncated",
            text: `Older activity is on ${input.hostName}.`,
          });
        }
        for (const row of conversation.rows) items.push({ kind: "conversation", key: row.id, row });
      } else if (input.hostKnown && !input.activitySupported) {
        items.push({
          kind: "note",
          key: "no-activity",
          text: `${input.hostName} does not share its conversation here.`,
        });
      }
      return items;
    }
    case "checks": {
      const sections = derivePullRequestCheckSections(input.checks);
      if (sections.length === 0 && input.detail !== null) {
        items.push({ kind: "note", key: "no-checks", text: input.checks.description });
      }
      for (const section of sections) {
        items.push({
          kind: "section",
          key: `section:${section.group}`,
          title: section.title,
          detail: String(section.rows.length),
        });
        for (const row of section.rows) items.push({ kind: "check", key: `check:${row.id}`, row });
      }
      return items;
    }
    case "files": {
      if (input.diff.status === "oversized") {
        items.push({
          kind: "note",
          key: "oversized",
          text: `This diff is too large for ${input.hostName} to send. Open it on ${input.hostName}.`,
        });
      } else if (input.diff.status === "error" && input.diff.error) {
        items.push({ kind: "note", key: "diff-error", text: input.diff.error });
      }
      for (const row of derivePullRequestFileRows(input.diff.files, input.detail?.files)) {
        items.push({ kind: "file", key: `file:${row.path}`, row });
      }
      return items;
    }
  }
}
