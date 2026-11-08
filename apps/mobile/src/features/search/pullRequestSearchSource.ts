import type { SearchGroup, SearchResult } from "./searchModel";

// The PRs scope's adapter. The PRs feature's `usePullRequestSearch(query)`
// (features/pullRequests, PRs round 2) answers in its own shape; this turns
// that answer into Search's group, so plugging it in is the two lines in
// `searchSources.ts`. Typed structurally, so it does not import the feature.

export interface PullRequestSearchAnswer {
  readonly results: ReadonlyArray<{
    readonly key: string;
    readonly number: number;
    readonly title: string;
    readonly subtitle: string;
    readonly route: { readonly name: string; readonly params: object };
  }>;
  readonly loading: boolean;
  readonly unavailable: string | null;
}

export function pullRequestSearchGroup(
  answer: PullRequestSearchAnswer,
  open: (route: PullRequestSearchAnswer["results"][number]["route"]) => void,
): SearchGroup {
  const results = answer.results.map((result): SearchResult => ({
    key: `pr:${result.key}`,
    scope: "pullRequests",
    icon: "arrow.triangle.pull",
    title: result.title,
    detail: result.subtitle,
    trailing: `#${result.number}`,
    accessibilityLabel: `Pull request ${result.number}, ${result.title}, ${result.subtitle}`,
    open: () => open(result.route),
  }));
  return { scope: "pullRequests", results, loading: answer.loading };
}
