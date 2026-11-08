import type { AppSymbolName } from "../../components/AppSymbol";

// Global search: one field across chats, message text, pull requests and
// tasks. Each kind of thing is a scope, served by a search source
// (`searchSources.ts`). Pure, so scopes, grouping and limits are testable.

/** Everything a source can find, in the order Search lists them. */
export const SEARCH_SCOPES = ["chats", "messages", "pullRequests", "tasks"] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The chip that searches every scope at once. */
export type SearchScopeFilter = "everything" | SearchScope;

export const SEARCH_SCOPE_CHIP_LABELS: Readonly<Record<SearchScopeFilter, string>> = {
  everything: "Everything",
  chats: "Chats",
  messages: "Messages",
  pullRequests: "PRs",
  tasks: "Tasks",
};

/** The heading over a scope's results. */
export const SEARCH_SCOPE_TITLES: Readonly<Record<SearchScope, string>> = {
  chats: "Chats",
  messages: "In messages",
  pullRequests: "Pull requests",
  tasks: "Tasks",
};

/** Under Everything each scope shows its first few results and offers the rest. */
export const SEARCH_EVERYTHING_RESULTS_PER_SCOPE = 3;

/** One thing a search found. Opening it is the source's business. */
export interface SearchResult {
  /** Unique within its scope. */
  readonly key: string;
  readonly scope: SearchScope;
  readonly icon: AppSymbolName;
  /** The query's words are highlighted in the title and the snippet. */
  readonly title: string;
  /** Where it lives: "web · needs approval", "saka-gg/ryco · merged". */
  readonly detail?: string;
  /** Matched text from inside it, such as a message. */
  readonly snippet?: string;
  /** A short trailing note: an age, a due day. */
  readonly trailing?: string;
  readonly accessibilityLabel: string;
  readonly open: () => void;
}

/** What one scope found for the current query. */
export interface SearchGroup {
  readonly scope: SearchScope;
  readonly results: ReadonlyArray<SearchResult>;
  /** The source is still asking (a node search in flight). */
  readonly loading: boolean;
}

export interface SearchSection {
  readonly scope: SearchScope;
  readonly title: string;
  readonly results: ReadonlyArray<SearchResult>;
  /** Results left out under Everything; the section offers to show them. */
  readonly hiddenCount: number;
  readonly loading: boolean;
}

/** The scope chips: Everything, then every scope a source serves, in scope order. */
export function searchScopeChips(
  available: ReadonlySet<SearchScope>,
): ReadonlyArray<SearchScopeFilter> {
  return ["everything", ...SEARCH_SCOPES.filter((scope) => available.has(scope))];
}

/** The scopes a chip searches. */
export function scopesForFilter(
  filter: SearchScopeFilter,
  available: ReadonlySet<SearchScope>,
): ReadonlySet<SearchScope> {
  if (filter === "everything") return available;
  return available.has(filter) ? new Set([filter]) : new Set();
}

/** The query a source should run for what the person typed, or null for none yet. */
export function searchQueryOf(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The sections Search lists: scope order, empty scopes left out unless they
 * are still loading. Everything trims each scope to its first few results.
 */
export function buildSearchSections(
  groups: ReadonlyArray<SearchGroup>,
  filter: SearchScopeFilter,
): ReadonlyArray<SearchSection> {
  const byScope = new Map(groups.map((group) => [group.scope, group] as const));
  const sections: SearchSection[] = [];
  for (const scope of SEARCH_SCOPES) {
    const group = byScope.get(scope);
    if (group === undefined) continue;
    if (filter !== "everything" && filter !== scope) continue;
    if (group.results.length === 0 && !group.loading) continue;
    const limit =
      filter === "everything" ? SEARCH_EVERYTHING_RESULTS_PER_SCOPE : group.results.length;
    sections.push({
      scope,
      title: SEARCH_SCOPE_TITLES[scope],
      results: group.results.slice(0, limit),
      hiddenCount: Math.max(0, group.results.length - limit),
      loading: group.loading,
    });
  }
  return sections;
}

export type SearchEmptyState = "prompt" | "searching" | "no-results" | null;

/** What Search shows when it has no results to list. */
export function searchEmptyState(input: {
  readonly query: string | null;
  readonly sections: ReadonlyArray<SearchSection>;
}): SearchEmptyState {
  if (input.query === null) return "prompt";
  if (input.sections.some((section) => section.results.length > 0)) return null;
  return input.sections.some((section) => section.loading) ? "searching" : "no-results";
}
