import type {
  AtlassianProjectLink,
  ChangeRequestState,
  WorkItemDetail,
  WorkItemState,
  WorkItemStateFilter,
  WorkItemSummary,
  WorkItemTransition,
} from "@ryco/contracts";
import { epochMillis } from "@ryco/shared/changeRequestChecks";
import { workItemStateLabel } from "@ryco/shared/workItemState";

import { splitVisible } from "./projectExplorerModel";

/**
 * A project's Jira work items on the phone, as the web's Jira tab reads them:
 * only for a project linked to Jira projects, one list per state, narrowed on
 * the device as the reader types and searched on the host when nothing read
 * matches. React-free.
 */

export const WORK_ITEM_STATE_OPTIONS: ReadonlyArray<{
  readonly value: WorkItemStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

/** The web's Jira tab reads the same amounts. */
export const WORK_ITEM_LIST_LIMIT = 100;
export const WORK_ITEM_SEARCH_LIMIT = 50;
export const WORK_ITEM_SEARCH_MIN_LENGTH = 2;
const WORK_ITEM_ROW_LABELS = 3;

/** Work items are read only for a project linked to a Jira connection and at least one Jira project. */
export function isJiraConfigured(link: AtlassianProjectLink | null): boolean {
  return link !== null && link.jiraConnectionId !== null && link.jiraProjectKeys.length > 0;
}

/** The rows already read whose key, title or type contains the query. */
export function filterWorkItems(
  items: ReadonlyArray<WorkItemSummary>,
  query: string,
): ReadonlyArray<WorkItemSummary> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter(
    (item) =>
      item.key.toLowerCase().includes(needle) ||
      item.title.toLowerCase().includes(needle) ||
      (item.issueType?.toLowerCase().includes(needle) ?? false),
  );
}

export interface WorkItemSearchPlan {
  readonly local: ReadonlyArray<WorkItemSummary>;
  readonly searchHost: boolean;
}

export function planWorkItemSearch(input: {
  readonly items: ReadonlyArray<WorkItemSummary>;
  readonly query: string;
  readonly settledQuery: string;
}): WorkItemSearchPlan {
  const local = filterWorkItems(input.items, input.query);
  return {
    local,
    searchHost:
      local.length === 0 && input.settledQuery.trim().length >= WORK_ITEM_SEARCH_MIN_LENGTH,
  };
}

export type WorkItemTone = "open" | "progress" | "done" | "closed" | "unknown";

export function workItemTone(state: WorkItemState): WorkItemTone {
  switch (state) {
    case "open":
      return "open";
    case "in_progress":
      return "progress";
    case "done":
      return "done";
    case "closed":
      return "closed";
    case "unknown":
      return "unknown";
  }
}

export interface WorkItemRow {
  readonly key: string;
  readonly title: string;
  readonly stateLabel: string;
  readonly tone: WorkItemTone;
  readonly issueType: string | null;
  readonly priority: string | null;
  readonly assignee: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly moreLabels: number;
  readonly updatedAtMs: number | null;
}

export function workItemRow(item: WorkItemSummary): WorkItemRow {
  const { shown, more } = splitVisible(item.labels ?? [], WORK_ITEM_ROW_LABELS);
  return {
    key: item.key,
    title: item.title,
    stateLabel: workItemStateLabel(item),
    tone: workItemTone(item.state),
    issueType: item.issueType ?? null,
    priority: item.priorityDetail?.name ?? item.priority ?? null,
    assignee: item.assignee,
    labels: shown,
    moreLabels: more,
    updatedAtMs: epochMillis(item.updatedAt),
  };
}

// ── One work item ────────────────────────────────────────────────────

export interface WorkItemField {
  readonly label: string;
  readonly value: string;
}

export interface WorkItemCommentRow {
  readonly key: string;
  readonly author: string;
  readonly body: string;
  readonly atMs: number | null;
}

export interface WorkItemLinkedChange {
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly state: ChangeRequestState;
  readonly url: string;
}

export interface WorkItemDetailView {
  readonly key: string;
  readonly title: string;
  readonly stateLabel: string;
  readonly tone: WorkItemTone;
  readonly url: string;
  readonly fields: ReadonlyArray<WorkItemField>;
  readonly labels: ReadonlyArray<string>;
  /** Null when the item has no description. */
  readonly description: string | null;
  readonly comments: ReadonlyArray<WorkItemCommentRow>;
  readonly transitions: ReadonlyArray<WorkItemTransition>;
  readonly linkedChanges: ReadonlyArray<WorkItemLinkedChange>;
  readonly truncated: boolean;
}

function field(label: string, value: string | null | undefined): ReadonlyArray<WorkItemField> {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? [{ label, value: trimmed }] : [];
}

export function deriveWorkItemDetail(detail: WorkItemDetail): WorkItemDetailView {
  const description = detail.description.trim();
  return {
    key: detail.key,
    title: detail.title,
    stateLabel: workItemStateLabel(detail),
    tone: workItemTone(detail.state),
    url: detail.url,
    fields: [
      ...field("Type", detail.issueType),
      ...field("Priority", detail.priorityDetail?.name ?? detail.priority),
      ...field("Assignee", detail.assignee ?? "Unassigned"),
      ...field("Reporter", detail.reporter),
      ...field("Parent", detail.parentKey ?? detail.epicKey),
      ...field("Start", detail.startDate),
      ...field("Due", detail.dueDate),
    ],
    labels: detail.labels ?? [],
    description: description.length > 0 ? detail.description : null,
    comments: detail.comments.map((comment, index) => ({
      key: comment.id ?? `comment-${index}`,
      author: comment.author,
      body: comment.body,
      atMs: epochMillis(comment.createdAt),
    })),
    transitions: detail.transitions,
    linkedChanges: detail.linkedChangeRequests.map((change) => ({
      key: `${change.provider}:${change.number}`,
      number: change.number,
      title: change.title,
      state: change.state,
      url: change.url,
    })),
    truncated: detail.truncated,
  };
}

/** "Move to Done": a transition named after its target says so once. */
export function transitionLabel(transition: WorkItemTransition): string {
  const target = transition.toStateName?.trim();
  if (!target || target.toLowerCase() === transition.name.trim().toLowerCase()) {
    return transition.name;
  }
  return `${transition.name} → ${target}`;
}

export type WorkItemDetailItem =
  | { readonly kind: "description"; readonly key: string; readonly body: string }
  | {
      readonly kind: "section";
      readonly key: string;
      readonly title: string;
      readonly detail: string;
    }
  | { readonly kind: "linked"; readonly key: string; readonly change: WorkItemLinkedChange }
  | { readonly kind: "comment"; readonly key: string; readonly row: WorkItemCommentRow }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

/** The work item screen's rows under its header: description, linked changes, comments. */
export function deriveWorkItemDetailItems(
  view: WorkItemDetailView | null,
): ReadonlyArray<WorkItemDetailItem> {
  if (view === null) return [];
  const items: Array<WorkItemDetailItem> = [];
  if (view.description !== null) {
    items.push({ kind: "description", key: "description", body: view.description });
  }
  if (view.linkedChanges.length > 0) {
    items.push({
      kind: "section",
      key: "linked",
      title: "Pull requests",
      detail: String(view.linkedChanges.length),
    });
    for (const change of view.linkedChanges) {
      items.push({ kind: "linked", key: `l:${change.key}`, change });
    }
  }
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
      text: "Only part of this work item was sent. Open it in Jira for the rest.",
    });
  }
  return items;
}
