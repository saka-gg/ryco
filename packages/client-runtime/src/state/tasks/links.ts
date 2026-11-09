import type {
  ChangeRequest,
  LocalTaskLink,
  SourceControlIssueSummary,
  WorkItemSummary,
} from "@ryco/contracts";
import { LOCAL_TASK_LINK_TITLE_MAX_LENGTH } from "@ryco/contracts/local-tasks";
import { parsePullRequestReferenceNumber } from "@ryco/shared/pullRequestReference";

/**
 * How a task's links are made and named, on every client: from a pasted URL
 * or key, from a pick in a source picker, and the words a link shows as.
 */

/** A pick a source picker hands over: a branch, a pull request, an issue or a Jira item. */
export type TaskLinkSource =
  | { readonly kind: "branch"; readonly branchName: string }
  | { readonly kind: "pr"; readonly changeRequest: Pick<ChangeRequest, "number" | "url" | "title"> }
  | {
      readonly kind: "issue";
      readonly issue: Pick<SourceControlIssueSummary, "number" | "url" | "title">;
    }
  | {
      readonly kind: "workItem";
      readonly workItem: Pick<WorkItemSummary, "provider" | "key" | "url" | "title">;
    };

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

/** A URL a link can keep: an http(s) address within the contract's length. */
function linkUrl(url: string | undefined): { readonly url: string } | Record<never, never> {
  const trimmed = url?.trim();
  return trimmed && trimmed.length <= MAX_URL_LENGTH && HTTP_URL.test(trimmed)
    ? { url: trimmed }
    : {};
}

/** A title a link can keep: one line, within the contract's length; nothing when blank. */
function linkTitle(title: string | undefined): { readonly title: string } | Record<never, never> {
  const line = title?.replace(/\s+/g, " ").trim().slice(0, LOCAL_TASK_LINK_TITLE_MAX_LENGTH).trim();
  return line ? { title: line } : {};
}

/**
 * The link a pick from the source picker makes: a branch by name; a pull
 * request, issue or Jira item with its URL and its title as it reads now.
 * `null` for a pick the task can't hold (a name git would refuse).
 */
export function taskLinkFromSource(source: TaskLinkSource): LocalTaskLink | null {
  switch (source.kind) {
    case "branch":
      return isTaskBranchName(source.branchName)
        ? { kind: "branch", name: source.branchName }
        : null;
    case "pr":
      return {
        kind: "pr",
        number: source.changeRequest.number,
        ...linkUrl(source.changeRequest.url),
        ...linkTitle(source.changeRequest.title),
      };
    case "issue":
      return {
        kind: "issue",
        number: source.issue.number,
        ...linkUrl(source.issue.url),
        ...linkTitle(source.issue.title),
      };
    case "workItem": {
      const key = workItemKey(source.workItem.key);
      return key !== null && JIRA_KEY.test(key)
        ? {
            kind: "workItem",
            provider: source.workItem.provider,
            key,
            ...linkUrl(source.workItem.url),
            ...linkTitle(source.workItem.title),
          }
        : null;
    }
  }
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

/**
 * The link pasted text names: a URL (a pull request, issue or Jira URL is
 * read as one) or a Jira key; `null` for anything else.
 */
export function parseTaskLinkPaste(raw: string): LocalTaskLink | null {
  const text = raw.trim();
  if (HTTP_URL.test(text)) return parseTaskLinkUrl(text);
  const key = JIRA_KEY.test(text) ? workItemKey(text) : null;
  return key === null ? null : { kind: "workItem", provider: "jira", key };
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
  chats: ReadonlyArray<{ readonly threadId: string; readonly title: string | null }>,
): string {
  const title =
    link.kind === "thread"
      ? (chats.find((chat) => chat.threadId === link.threadId)?.title ?? null)
      : null;
  return taskLinkLabel(link, title);
}
