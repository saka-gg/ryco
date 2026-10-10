import type { Project } from "~/types";

/** Rows each overview list reads; a full page reads as "20+". */
export const PROJECT_OVERVIEW_LIST_LIMIT = 20;

/** What the overview shows for a checkout no hosting provider serves. */
export const NO_HOSTING_PROVIDER_LABEL = "No hosting provider";

export function formatProjectOverviewCount(
  count: number,
  limit: number = PROJECT_OVERVIEW_LIST_LIMIT,
): string {
  return count >= limit ? `${limit}+` : String(count);
}

/**
 * Whether the checkout has a git remote a hosting provider could serve. The
 * project's repository identity is resolved from its git remotes and is null
 * without one (the same signal the project page's repository section uses).
 */
export function projectHasGitRemote(project: Pick<Project, "repositoryIdentity"> | null): boolean {
  return (project?.repositoryIdentity ?? null) !== null;
}

/**
 * Whether an overview list for hosted items (issues, pull requests, workflow
 * runs) has no hosting provider behind it. The server answers those lists
 * empty for a checkout without a recognized host instead of failing, so an
 * empty list there means "nothing to ask", not "none open". Rows that did
 * arrive still win: the project's remote snapshot can lag the checkout.
 */
export function isProjectOverviewUnhosted(input: {
  readonly hasGitRemote: boolean;
  readonly count: number;
}): boolean {
  return !input.hasGitRemote && input.count === 0;
}

/** An overview metric's value for hosted items: their count, or that no host serves them. */
export function formatProjectOverviewHostedCount(input: {
  readonly hasGitRemote: boolean;
  readonly count: number;
}): string {
  return isProjectOverviewUnhosted(input)
    ? NO_HOSTING_PROVIDER_LABEL
    : formatProjectOverviewCount(input.count);
}
