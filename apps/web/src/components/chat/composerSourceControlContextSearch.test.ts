import { describe, expect, it } from "vite-plus/test";
import { scopeSourceControlQuery } from "./composerSourceControlContextSearch";

describe("scopeSourceControlQuery", () => {
  it.each([
    { input: "", scope: "mixed", search: "" },
    { input: "auth", scope: "mixed", search: "auth" },
    { input: "i", scope: "issues", search: "" },
    { input: "i ", scope: "issues", search: "" },
    { input: "i auth", scope: "issues", search: "auth" },
    { input: "i   bug fix", scope: "issues", search: "bug fix" },
    { input: "pr", scope: "prs", search: "" },
    { input: "pr ", scope: "prs", search: "" },
    { input: "pr 42", scope: "prs", search: "42" },
    { input: "jira", scope: "jira", search: "" },
    { input: "jira RYCO-123", scope: "jira", search: "RYCO-123" },
    { input: "ipad", scope: "mixed", search: "ipad" },
    { input: "price", scope: "mixed", search: "price" },
    { input: "jiraflow", scope: "mixed", search: "jiraflow" },
    { input: "issue", scope: "mixed", search: "issue" },
  ])('"$input" → scope=$scope search="$search"', ({ input, scope, search }) => {
    const result = scopeSourceControlQuery(input);
    expect(result.scope).toBe(scope);
    expect(result.search).toBe(search);
  });

  it("trims only the prefix separator, not the user's tail content", () => {
    // multi-space tail content is preserved verbatim after the prefix collapse
    const result = scopeSourceControlQuery("pr  foo  bar");
    expect(result).toEqual({ scope: "prs", search: "foo  bar" });
  });
});
