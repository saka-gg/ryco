import type {
  SourceControlAssigneeCandidate,
  SourceControlCreateIssueInput,
  SourceControlIssueDetail,
  SourceControlIssueState,
  SourceControlIssueSummary,
  SourceControlLabel,
  TextGenerationIssueContentInput,
  TextGenerationIssueContentResult,
} from "@ryco/contracts";
import { epochMillis } from "@ryco/shared/changeRequestChecks";
import { labelChipColors, type LabelChipColors } from "@ryco/shared/sourceControlLabelColors";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import { searchSourceControlSummaries } from "@ryco/shared/sourceControlSearch";

import {
  describeExplorerProblem,
  splitVisible,
  type ExplorerProblem,
} from "./projectExplorerModel";

/**
 * A project's issues on the phone, as the web's Issues tab reads them: one
 * list per state, narrowed on the device as the reader types, and a host
 * search only when nothing already read matches. React-free.
 */

export type IssueStateFilter = "open" | "closed" | "all";

export const ISSUE_STATE_OPTIONS: ReadonlyArray<{
  readonly value: IssueStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** The web's Issues tab reads the same amounts. */
export const ISSUE_LIST_LIMIT = 100;
export const ISSUE_SEARCH_LIMIT = 50;
/** The host is searched only for a query this long that nothing already read matches. */
export const ISSUE_SEARCH_MIN_LENGTH = 2;
export const ISSUE_ROW_LABELS = 3;

export interface IssueRead<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly isLoading: boolean;
}

export interface IssueLabelChip {
  readonly name: string;
  /** The chip's tint; null for a label the host gave no usable color (drawn neutral). */
  readonly colors: LabelChipColors | null;
}

export interface IssueListRow {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly state: SourceControlIssueState;
  readonly author: string | null;
  readonly labels: ReadonlyArray<IssueLabelChip>;
  readonly moreLabels: number;
  readonly comments: number;
  readonly updatedAtMs: number | null;
}

export function issueLabelChips(
  labels: ReadonlyArray<SourceControlLabel> | undefined,
): ReadonlyArray<IssueLabelChip> {
  return (labels ?? []).map((label) => ({
    name: label.name,
    colors: labelChipColors(label.color),
  }));
}

export function issueListRow(issue: SourceControlIssueSummary): IssueListRow {
  const { shown, more } = splitVisible(issueLabelChips(issue.labels), ISSUE_ROW_LABELS);
  return {
    key: `${issue.provider}:${issue.number}`,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.author ?? null,
    labels: shown,
    moreLabels: more,
    comments: issue.commentsCount ?? 0,
    updatedAtMs: epochMillis(issue.updatedAt),
  };
}

export interface IssueSearchPlan {
  /** The rows already read that match the query, best first. */
  readonly local: ReadonlyArray<SourceControlIssueSummary>;
  /** Nothing already read matches a long enough (settled) query: ask the host. */
  readonly searchHost: boolean;
}

export function planIssueSearch(input: {
  readonly items: ReadonlyArray<SourceControlIssueSummary>;
  readonly query: string;
  /** The query once typing settled; the host is asked only for this one. */
  readonly settledQuery: string;
}): IssueSearchPlan {
  const local = searchSourceControlSummaries(input.items, input.query);
  return {
    local,
    searchHost: local.length === 0 && input.settledQuery.trim().length >= ISSUE_SEARCH_MIN_LENGTH,
  };
}

export interface IssueListScreen {
  readonly status: "loading" | "ready" | "empty" | "problem";
  readonly rows: ReadonlyArray<IssueListRow>;
  /** Set when a read failed; rows already read stay on screen. */
  readonly problem: ExplorerProblem | null;
  readonly emptyTitle: string;
  readonly emptyDetail: string;
}

export function deriveIssueListScreen(input: {
  readonly list: IssueRead<ReadonlyArray<SourceControlIssueSummary>>;
  readonly search: IssueRead<ReadonlyArray<SourceControlIssueSummary>>;
  readonly plan: IssueSearchPlan;
  readonly query: string;
  readonly state: IssueStateFilter;
}): IssueListScreen {
  const { list, search, plan } = input;
  const items = plan.searchHost ? (search.data ?? []) : plan.local;
  const rows = items.map(issueListRow);
  const error = list.error ?? (plan.searchHost ? search.error : null);
  const problem = error ? describeExplorerProblem(error, "issues") : null;
  const loading = list.isLoading || (plan.searchHost && search.isLoading);
  const searching = input.query.trim().length > 0;
  const status: IssueListScreen["status"] =
    rows.length > 0
      ? "ready"
      : problem !== null
        ? "problem"
        : loading || list.data === null
          ? "loading"
          : "empty";
  return {
    status,
    rows,
    problem,
    emptyTitle: searching ? "No matching issues" : emptyTitleForState(input.state),
    emptyDetail: searching
      ? "No issue's number or title matches this search."
      : "Pull to refresh after creating one on the host.",
  };
}

function emptyTitleForState(state: IssueStateFilter): string {
  switch (state) {
    case "open":
      return "No open issues";
    case "closed":
      return "No closed issues";
    case "all":
      return "No issues yet";
  }
}

// ── One issue ────────────────────────────────────────────────────────

export interface IssueHeader {
  readonly number: number;
  readonly title: string;
  readonly state: SourceControlIssueState;
  readonly stateLabel: string;
  readonly author: string | null;
  readonly updatedAtMs: number | null;
  readonly labels: ReadonlyArray<IssueLabelChip>;
  readonly assignees: ReadonlyArray<string>;
  readonly url: string;
  /** "GitHub", "GitLab": where "Open on …" goes. */
  readonly hostName: string;
  readonly linkedPullRequests: ReadonlyArray<number>;
}

export interface IssueCommentRow {
  readonly key: string;
  readonly author: string;
  readonly body: string;
  readonly atMs: number | null;
}

export interface IssueDetailView {
  readonly header: IssueHeader;
  /** Null when the issue has no description. */
  readonly body: string | null;
  readonly comments: ReadonlyArray<IssueCommentRow>;
  /** The host sent a shortened body or only the latest comments. */
  readonly truncated: boolean;
}

export function issueStateLabel(state: SourceControlIssueState): string {
  return state === "open" ? "Open" : "Closed";
}

export function deriveIssueDetail(detail: SourceControlIssueDetail): IssueDetailView {
  const body = detail.body.trim();
  return {
    header: {
      number: detail.number,
      title: detail.title,
      state: detail.state,
      stateLabel: issueStateLabel(detail.state),
      author: detail.author ?? null,
      updatedAtMs: epochMillis(detail.updatedAt),
      labels: issueLabelChips(detail.labels),
      assignees: detail.assignees ?? [],
      url: detail.url,
      hostName: resolveChangeRequestPresentationForKind(detail.provider).providerName,
      linkedPullRequests: detail.linkedChangeRequestNumbers ?? [],
    },
    body: body.length > 0 ? detail.body : null,
    comments: detail.comments.map((comment, index) => ({
      key: comment.id ?? `comment-${index}`,
      author: comment.author,
      body: comment.body,
      atMs: epochMillis(comment.createdAt),
    })),
    truncated: detail.truncated,
  };
}

export type IssueDetailItem =
  | { readonly kind: "body"; readonly key: string; readonly body: string }
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      readonly detail: string;
    }
  | { readonly kind: "comment"; readonly key: string; readonly row: IssueCommentRow }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

/** The issue screen's rows under its header: description, then the comments. */
export function deriveIssueDetailItems(
  view: IssueDetailView | null,
): ReadonlyArray<IssueDetailItem> {
  if (view === null) return [];
  const items: Array<IssueDetailItem> = [];
  if (view.body !== null) items.push({ kind: "body", key: "body", body: view.body });
  items.push({
    kind: "section",
    key: "comments",
    title: "Comments",
    detail: String(view.comments.length),
  });
  for (const row of view.comments) items.push({ kind: "comment", key: `c:${row.key}`, row });
  if (view.comments.length === 0) {
    items.push({ kind: "note", key: "no-comments", text: "No comments yet." });
  }
  if (view.truncated) {
    items.push({
      kind: "note",
      key: "truncated",
      text: "Only part of this issue was sent. Open it on the host for the rest.",
    });
  }
  return items;
}

/** A comment worth sending: something other than whitespace, trailing blank lines dropped. */
export function commentBodyToSend(draft: string): string | null {
  const body = draft.trimEnd();
  return body.trim().length > 0 ? body : null;
}

// ── New issue ────────────────────────────────────────────────────────

export interface NewIssueDraft {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
}

export const EMPTY_NEW_ISSUE_DRAFT: NewIssueDraft = {
  title: "",
  body: "",
  labels: [],
  assignees: [],
};

export type NewIssueBuild =
  | { readonly ok: true; readonly input: SourceControlCreateIssueInput }
  | { readonly ok: false; readonly message: string };

/** The createIssue request for a draft, or why it cannot be sent yet. */
export function buildCreateIssueInput(cwd: string, draft: NewIssueDraft): NewIssueBuild {
  const title = draft.title.trim();
  if (title.length === 0) return { ok: false, message: "Give the issue a title." };
  const labels = uniqueTrimmed(draft.labels);
  const assignees = uniqueTrimmed(draft.assignees);
  return {
    ok: true,
    input: {
      cwd,
      title,
      body: draft.body.trimEnd(),
      ...(labels.length > 0 ? { labels } : {}),
      ...(assignees.length > 0 ? { assignees } : {}),
    },
  };
}

function uniqueTrimmed(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** Adds the value when absent, removes it when present. */
export function toggleValue(values: ReadonlyArray<string>, value: string): ReadonlyArray<string> {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export interface AssigneeOption {
  readonly login: string;
  readonly label: string;
}

export function assigneeOptions(
  candidates: ReadonlyArray<SourceControlAssigneeCandidate> | null,
): ReadonlyArray<AssigneeOption> {
  return (candidates ?? []).map((candidate) => ({
    login: candidate.login,
    label: candidate.displayName
      ? `${candidate.displayName} (@${candidate.login})`
      : `@${candidate.login}`,
  }));
}

/** The polish request for a draft (the web's "Polish with AI"); null without a body to polish. */
export function buildPolishIssueInput(
  cwd: string,
  draft: NewIssueDraft,
): TextGenerationIssueContentInput | null {
  if (draft.body.trim().length === 0) return null;
  const title = draft.title.trim();
  return { cwd, mode: "polish", rough: draft.body, ...(title ? { currentTitle: title } : {}) };
}

/**
 * A polished draft merged in as the web's dialog does: the body is replaced,
 * the title filled only while the reader has not written one.
 */
export function applyPolishedIssueContent(
  draft: NewIssueDraft,
  polished: TextGenerationIssueContentResult,
): NewIssueDraft {
  const title = polished.title?.trim();
  return {
    ...draft,
    title: draft.title.trim() === "" && title ? title : draft.title,
    body: polished.body ?? draft.body,
  };
}
