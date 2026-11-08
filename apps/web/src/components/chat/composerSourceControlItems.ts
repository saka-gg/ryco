import type { ChangeRequest, SourceControlIssueSummary } from "@ryco/contracts";
import { searchSourceControlSummaries } from "@ryco/shared/sourceControlSearch";
import {
  scopeSourceControlQuery,
  type SourceControlScope,
} from "./composerSourceControlContextSearch";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export interface ScopedSourceControlInputs {
  readonly issues: ReadonlyArray<SourceControlIssueSummary>;
  readonly prs: ReadonlyArray<ChangeRequest>;
}

export function buildScopedSourceControlComposerItems(
  query: string,
  inputs: ScopedSourceControlInputs,
): ReadonlyArray<ComposerCommandItem> {
  const { scope, search } = scopeSourceControlQuery(query);
  const wantIssues = scope === "mixed" || scope === "issues";
  const wantPrs = scope === "mixed" || scope === "prs";

  if (scope === "jira") {
    return [];
  }

  const issueItems: ReadonlyArray<ComposerCommandItem> = wantIssues
    ? searchSourceControlSummaries(inputs.issues, search).map((issue) => ({
        id: `source-control-issue:${issue.provider}:${issue.number}`,
        type: "source-control-issue" as const,
        summary: issue,
        label: `#${issue.number}`,
        description: issue.title,
      }))
    : [];

  const prItems: ReadonlyArray<ComposerCommandItem> = wantPrs
    ? filterPrs(inputs.prs, search).map((pr) => ({
        id: `source-control-pr:${pr.provider}:${pr.number}`,
        type: "source-control-pr" as const,
        summary: pr,
        label: `#${pr.number}`,
        description: pr.title,
      }))
    : [];

  return [...issueItems, ...prItems];
}

function filterPrs(
  prs: ReadonlyArray<ChangeRequest>,
  search: string,
): ReadonlyArray<ChangeRequest> {
  const q = search.trim().toLowerCase();
  if (q.length === 0) return prs;
  return prs.filter((pr) => {
    const num = String(pr.number);
    const title = pr.title.toLowerCase();
    return num === q || num.startsWith(q) || title.includes(q);
  });
}

export type { SourceControlScope };
