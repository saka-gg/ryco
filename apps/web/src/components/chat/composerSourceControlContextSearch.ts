export type SourceControlScope = "issues" | "prs" | "jira" | "mixed";

export interface ScopedSourceControlQuery {
  readonly scope: SourceControlScope;
  readonly search: string;
}

const SOURCE_CONTROL_SCOPE_PREFIXES: ReadonlyArray<{
  readonly prefix: string;
  readonly scope: Exclude<SourceControlScope, "mixed">;
}> = [
  { prefix: "jira", scope: "jira" },
  { prefix: "pr", scope: "prs" },
  { prefix: "i", scope: "issues" },
];

export function scopeSourceControlQuery(query: string): ScopedSourceControlQuery {
  for (const { prefix, scope } of SOURCE_CONTROL_SCOPE_PREFIXES) {
    if (query === prefix) {
      return { scope, search: "" };
    }
    if (query.length > prefix.length && query.startsWith(prefix)) {
      const next = query.charAt(prefix.length);
      if (next === " " || next === "\t") {
        return { scope, search: query.slice(prefix.length).replace(/^\s+/, "") };
      }
    }
  }
  return { scope: "mixed", search: query };
}
