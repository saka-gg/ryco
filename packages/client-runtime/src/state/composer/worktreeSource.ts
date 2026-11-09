import type { CreateWorktreeIntent } from "@ryco/contracts";

import type { DraftWorktreeSource } from "./draftStore.ts";

/**
 * A new worktree's source (a pull request, an issue or a work item such as a Jira item): what a
 * picked one records on a draft, and the `git.createWorktreeForProject` intent it becomes on the
 * first send. Web's New thread picker and the phone's New Task share these, so both name the
 * worktree, branch and sidebar badge the same way.
 */

/** The source a picked pull request records, labelled `#N title` (`#N` without a title). */
export function pullRequestWorktreeSource(
  number: number,
  title: string | null,
): Extract<DraftWorktreeSource, { kind: "pr" }> {
  const trimmed = title?.trim();
  return { kind: "pr", number, label: trimmed ? `#${number} ${trimmed}` : `#${number}` };
}

export function issueWorktreeSource(issue: {
  readonly number: number;
  readonly title: string;
}): Extract<DraftWorktreeSource, { kind: "issue" }> {
  return {
    kind: "issue",
    number: issue.number,
    title: issue.title,
    label: `#${issue.number} ${issue.title}`,
  };
}

export function workItemWorktreeSource(workItem: {
  readonly provider: "jira";
  readonly key: string;
  readonly title: string;
  readonly state?: Extract<DraftWorktreeSource, { kind: "workItem" }>["state"];
  readonly stateName?: string | undefined;
  readonly url?: string | undefined;
}): Extract<DraftWorktreeSource, { kind: "workItem" }> {
  return {
    kind: "workItem",
    provider: workItem.provider,
    key: workItem.key,
    title: workItem.title,
    ...(workItem.state ? { state: workItem.state } : {}),
    ...(workItem.stateName ? { stateName: workItem.stateName } : {}),
    ...(workItem.url ? { url: workItem.url } : {}),
    label: `${workItem.key} ${workItem.title}`,
  };
}

/** What `git.createWorktreeForProject` is asked to make for a recorded source. */
export function worktreeSourceIntent(source: DraftWorktreeSource): CreateWorktreeIntent {
  switch (source.kind) {
    case "pr":
      return { kind: "pr", number: source.number };
    case "issue":
      return { kind: "issue", number: source.number, title: source.title };
    case "workItem":
      return {
        kind: "workItem",
        provider: source.provider,
        key: source.key,
        title: source.title,
        ...(source.state ? { state: source.state } : {}),
        ...(source.stateName ? { stateName: source.stateName } : {}),
        ...(source.url ? { url: source.url } : {}),
      };
  }
}
