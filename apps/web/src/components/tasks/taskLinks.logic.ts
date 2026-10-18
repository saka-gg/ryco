import type { LocalTaskLink } from "@ryco/contracts";

import { parsePullRequestReferenceNumber } from "../../pullRequestReference";
import type { TaskChatView } from "./tasksViewModel";

/**
 * What the Link popover's text field accepts. The kind picked first decides
 * how a bare `#42` or name reads; a pasted URL says what it is itself, so a
 * GitHub issue URL typed under "Pull request" still becomes an issue.
 */
export type TaskLinkInputKind = "pr" | "issue" | "branch";

// Mirrors the contract's URL and work item key checks, so a parsed link always encodes.
const MAX_URL_LENGTH = 2048;
const MAX_WORK_ITEM_KEY_LENGTH = 64;
const MAX_BRANCH_NAME_LENGTH = 255;
const HTTP_URL = /^https?:\/\/\S+$/i;
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)(?:[/?#].*)?$/i;
const JIRA_BROWSE_URL =
  /^https?:\/\/[^/\s]+\/(?:\S*\/)?browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#].*)?$/;
const JIRA_SELECTED_ISSUE = /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)(?:[&#]|$)/;
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ISSUE_NUMBER = /^#?(\d+)$/;
// `git check-ref-format --branch`, minus the rules no one types by accident.
const INVALID_BRANCH =
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what git rejects
  /[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|@\{|\/\/|\/\.|^[-./]|[./]$|\.lock$|^@$/;

function positiveNumber(digits: string | undefined): number | null {
  const number = digits === undefined ? Number.NaN : Number(digits);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function workItemKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const key = raw.toUpperCase();
  return key.length <= MAX_WORK_ITEM_KEY_LENGTH ? key : null;
}

/** A link from a pasted URL: a pull request, a GitHub issue, a Jira issue, else the URL itself. */
function parseTaskLinkUrl(url: string): LocalTaskLink | null {
  if (url.length > MAX_URL_LENGTH) return null;
  const pr = parsePullRequestReferenceNumber(url);
  if (pr !== null) return { kind: "pr", number: pr, url };
  const issue = positiveNumber(GITHUB_ISSUE_URL.exec(url)?.[1]);
  if (issue !== null) return { kind: "issue", number: issue, url };
  const key = workItemKey(JIRA_BROWSE_URL.exec(url)?.[1] ?? JIRA_SELECTED_ISSUE.exec(url)?.[1]);
  if (key !== null) return { kind: "workItem", provider: "jira", key, url };
  return { kind: "url", url };
}

/** Whether `name` can be a branch name (the subset of git's rules a typed name trips over). */
export function isTaskBranchName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_BRANCH_NAME_LENGTH && !INVALID_BRANCH.test(name);
}

/** The link the popover's text field describes, or `null` while it describes none. */
export function parseTaskLinkInput(kind: TaskLinkInputKind, raw: string): LocalTaskLink | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (HTTP_URL.test(text)) return parseTaskLinkUrl(text);
  switch (kind) {
    case "pr": {
      const number = parsePullRequestReferenceNumber(text);
      return number === null ? null : { kind: "pr", number };
    }
    case "issue": {
      const number = positiveNumber(ISSUE_NUMBER.exec(text)?.[1]);
      if (number !== null) return { kind: "issue", number };
      const key = JIRA_KEY.test(text) ? workItemKey(text) : null;
      return key === null ? null : { kind: "workItem", provider: "jira", key };
    }
    case "branch":
      return isTaskBranchName(text) ? { kind: "branch", name: text } : null;
  }
}

/** A URL without its scheme, `www.` or trailing slash: "github.com/acme/app/wiki". */
function shortUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

/** The words a link shows as: "#746", "ABC-123", the branch, the chat's title, a short URL. */
export function taskLinkLabel(link: LocalTaskLink, chatTitle?: string | null): string {
  switch (link.kind) {
    case "pr":
    case "issue":
      return `#${link.number}`;
    case "workItem":
      return link.key;
    case "branch":
      return link.name;
    case "thread":
      return chatTitle ?? "Linked chat";
    case "url":
      return link.label ?? shortUrl(link.url);
  }
}

/** What the popover says it will add: "Pull request #746", "Jira ABC-123", "Branch feature/x". */
export function describeTaskLink(link: LocalTaskLink): string {
  switch (link.kind) {
    case "pr":
      return `Pull request #${link.number}`;
    case "issue":
      return `Issue #${link.number}`;
    case "workItem":
      return `Jira ${link.key}`;
    case "branch":
      return `Branch ${link.name}`;
    case "thread":
      return "Chat";
    case "url":
      return `Link ${shortUrl(link.url)}`;
  }
}

/**
 * The words a link shows as on its task, a linked chat by its title when the
 * task's chats include it (`taskLinkLabel` otherwise).
 */
export function taskLinkLabelIn(
  link: LocalTaskLink,
  chats: ReadonlyArray<Pick<TaskChatView, "threadId" | "title">>,
): string {
  const title =
    link.kind === "thread"
      ? (chats.find((chat) => chat.threadId === link.threadId)?.title ?? null)
      : null;
  return taskLinkLabel(link, title);
}
