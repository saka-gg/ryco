# Composer Hint Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-turn "quick reference" pill row above the composer, with `#i` / `#pr` / `#jira` / `/` prefix routing in the inline picker so clicks and keystrokes share one code path.

**Architecture:** A pure helper (`scopeSourceControlQuery`) decides whether a `#`-trigger query is scoped to issues, PRs, Jira, or mixed. A second pure helper (`buildScopedSourceControlComposerItems`) wraps it and produces `ComposerCommandItem`s, replacing the inline filter currently in `ChatComposer.tsx`. The composer exposes a new imperative `insertTriggerAtCursor(text)` on its handle. A new `ComposerHintRow` component is mounted in `ChatView.tsx` between `ComposerBannerStack` and `ChatComposer`; it only renders on a fresh thread and calls `insertTriggerAtCursor` when a pill is clicked.

**Tech Stack:** React, TypeScript, Vitest, Tailwind, Lucide icons, Bun.

**Design spec:** `docs/superpowers/specs/2026-05-16-composer-hint-row-design.md`

---

## File Structure

| File                                                                      | Op     | Purpose                                                                                                                       |
| ------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/chat/composerSourceControlContextSearch.ts`      | modify | Add `scopeSourceControlQuery` pure helper.                                                                                    |
| `apps/web/src/components/chat/composerSourceControlContextSearch.test.ts` | modify | Add table-driven tests for `scopeSourceControlQuery`.                                                                         |
| `apps/web/src/components/chat/composerSourceControlItems.ts`              | create | New: `buildScopedSourceControlComposerItems` — turns query + lists into `ComposerCommandItem[]`, applying scope.              |
| `apps/web/src/components/chat/composerSourceControlItems.test.ts`         | create | New: tests covering each scope path.                                                                                          |
| `apps/web/src/components/chat/ChatComposer.tsx`                           | modify | Replace inline source-control filter with `buildScopedSourceControlComposerItems`. Add `insertTriggerAtCursor` to the handle. |
| `apps/web/src/components/chat/ComposerHintRow.tsx`                        | create | New: the pill row component.                                                                                                  |
| `apps/web/src/components/chat/ComposerHintRow.test.tsx`                   | create | New: markup tests for conditional pill rendering.                                                                             |
| `apps/web/src/components/chat/ComposerHintRow.logic.ts`                   | create | New: pure `resolveHintRowPills` returning which pills should render given the flags. Easy to unit-test.                       |
| `apps/web/src/components/chat/ComposerHintRow.logic.test.ts`              | create | New: tests for `resolveHintRowPills`.                                                                                         |
| `apps/web/src/components/ChatView.tsx`                                    | modify | Mount `ComposerHintRow` between `ComposerBannerStack` and `ChatComposer`.                                                     |

---

## Task 1: `scopeSourceControlQuery` pure helper

**Files:**

- Modify: `apps/web/src/components/chat/composerSourceControlContextSearch.ts`
- Modify: `apps/web/src/components/chat/composerSourceControlContextSearch.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `composerSourceControlContextSearch.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test, see it fail**

```bash
bun run test composerSourceControlContextSearch
```

Expected: failure — `scopeSourceControlQuery is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `composerSourceControlContextSearch.ts`:

```ts
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
```

Note the prefix array order: `jira` is checked before `pr` before `i` because shorter prefixes would otherwise shadow longer ones (`i` would match the leading `i` of `issue` — but we want `issue` to fall through to mixed since it isn't `i ` or just `i`). The boundary check (next char must be whitespace or end-of-string) is what keeps `issue`, `ipad`, `price`, and `jiraflow` in the `mixed` bucket.

- [ ] **Step 4: Run tests, see them pass**

```bash
bun run test composerSourceControlContextSearch
```

Expected: PASS (all old `searchSourceControlSummaries` cases + new `scopeSourceControlQuery` cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/composerSourceControlContextSearch.ts \
        apps/web/src/components/chat/composerSourceControlContextSearch.test.ts
git commit -m "Add scopeSourceControlQuery for composer prefix routing"
```

---

## Task 2: `buildScopedSourceControlComposerItems` helper

This extracts the existing inline filter logic from `ChatComposer.tsx` lines 1078-1107 into a pure, unit-testable function.

**Files:**

- Create: `apps/web/src/components/chat/composerSourceControlItems.ts`
- Create: `apps/web/src/components/chat/composerSourceControlItems.test.ts`

- [ ] **Step 1: Write the failing test**

Create `composerSourceControlItems.test.ts`:

```ts
import { Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ChangeRequest, SourceControlIssueSummary } from "@ryco/contracts";
import { buildScopedSourceControlComposerItems } from "./composerSourceControlItems";

const ISSUES: SourceControlIssueSummary[] = [
  {
    provider: "github",
    number: 42 as any,
    title: "Auth redirect race" as any,
    url: "u" as any,
    state: "open",
    updatedAt: Option.none(),
  },
  {
    provider: "github",
    number: 41 as any,
    title: "Worktree cleanup fails" as any,
    url: "u" as any,
    state: "open",
    updatedAt: Option.none(),
  },
];

const PRS: ChangeRequest[] = [
  {
    provider: "github",
    number: 88 as any,
    title: "Add hints above composer" as any,
    url: "u" as any,
    state: "open" as const,
    updatedAt: Option.none(),
  } as unknown as ChangeRequest,
  {
    provider: "github",
    number: 87 as any,
    title: "Refactor auth middleware" as any,
    url: "u" as any,
    state: "open" as const,
    updatedAt: Option.none(),
  } as unknown as ChangeRequest,
];

describe("buildScopedSourceControlComposerItems", () => {
  it("returns all issues + PRs for empty query (mixed)", () => {
    const items = buildScopedSourceControlComposerItems("", { issues: ISSUES, prs: PRS });
    const types = items.map((i) => i.type);
    expect(types).toEqual([
      "source-control-issue",
      "source-control-issue",
      "source-control-pr",
      "source-control-pr",
    ]);
  });

  it("scopes to issues only when prefix is 'i'", () => {
    const items = buildScopedSourceControlComposerItems("i", { issues: ISSUES, prs: PRS });
    expect(items.every((i) => i.type === "source-control-issue")).toBe(true);
    expect(items).toHaveLength(2);
  });

  it("scopes to issues and applies the stripped search term", () => {
    const items = buildScopedSourceControlComposerItems("i worktree", {
      issues: ISSUES,
      prs: PRS,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("#41");
  });

  it("scopes to PRs only when prefix is 'pr'", () => {
    const items = buildScopedSourceControlComposerItems("pr", { issues: ISSUES, prs: PRS });
    expect(items.every((i) => i.type === "source-control-pr")).toBe(true);
    expect(items).toHaveLength(2);
  });

  it("filters PRs by number when prefix is 'pr 88'", () => {
    const items = buildScopedSourceControlComposerItems("pr 88", { issues: ISSUES, prs: PRS });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("#88");
  });

  it("returns no items for 'jira' until the Jira provider lands", () => {
    const items = buildScopedSourceControlComposerItems("jira", { issues: ISSUES, prs: PRS });
    expect(items).toEqual([]);
  });

  it("falls back to mixed on unknown prefixes like 'ipad'", () => {
    const items = buildScopedSourceControlComposerItems("ipad", { issues: ISSUES, prs: PRS });
    // No item matches "ipad" so the result is empty, but both types were considered
    expect(items).toEqual([]);
  });

  it("ranks issue number match for bare numeric mixed query", () => {
    const items = buildScopedSourceControlComposerItems("42", { issues: ISSUES, prs: PRS });
    expect(items[0]?.label).toBe("#42");
    expect(items[0]?.type).toBe("source-control-issue");
  });
});
```

- [ ] **Step 2: Run test, see it fail**

```bash
bun run test composerSourceControlItems
```

Expected: failure — module not found.

- [ ] **Step 3: Implement the helper**

Create `composerSourceControlItems.ts`:

```ts
import type { ChangeRequest, SourceControlIssueSummary } from "@ryco/contracts";
import {
  scopeSourceControlQuery,
  searchSourceControlSummaries,
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
```

- [ ] **Step 4: Run tests, see them pass**

```bash
bun run test composerSourceControlItems
```

Expected: PASS (8 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/composerSourceControlItems.ts \
        apps/web/src/components/chat/composerSourceControlItems.test.ts
git commit -m "Add buildScopedSourceControlComposerItems helper"
```

---

## Task 3: Replace inline source-control filter in `ChatComposer.tsx`

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx`

- [ ] **Step 1: Locate the existing inline filter**

```bash
grep -n "composerTrigger.kind === \"source-control\"" \
  apps/web/src/components/chat/ChatComposer.tsx
```

Expected: one match around line 1078.

- [ ] **Step 2: Add the import**

Open `apps/web/src/components/chat/ChatComposer.tsx` and add this import alongside the existing `composerSourceControlContextSearch` import (currently around line 64):

```ts
import { buildScopedSourceControlComposerItems } from "./composerSourceControlItems";
```

Then remove `searchSourceControlSummaries` from the existing import line if it is no longer referenced anywhere else in the file. To check:

```bash
grep -n "searchSourceControlSummaries" apps/web/src/components/chat/ChatComposer.tsx
```

If the only remaining reference is on the import line, drop it.

- [ ] **Step 3: Replace the inline filter**

Replace the entire `if (composerTrigger.kind === "source-control")` block (the body from `const query = composerTrigger.query;` through `return [...issueItems, ...prItems];`) with:

```ts
if (composerTrigger.kind === "source-control") {
  return buildScopedSourceControlComposerItems(composerTrigger.query, {
    issues: issueListQuery.data ?? [],
    prs: changeRequestListQuery.data ?? [],
  });
}
```

- [ ] **Step 4: Run typecheck + tests**

```bash
bun run typecheck && bun run test
```

Expected: PASS. If the import cleanup in Step 2 missed something, the typecheck will name it — fix and rerun.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx
git commit -m "Route composer #-trigger items through scoped builder"
```

---

## Task 4: Add `insertTriggerAtCursor` to `ChatComposerHandle`

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx`

- [ ] **Step 1: Extend the handle interface**

In `ChatComposer.tsx` find `export interface ChatComposerHandle` (around line 450). Add after `addTerminalContext`:

```ts
  /**
   * Inserts trigger text (e.g. "#i ", "#pr ", "#jira ", "/") at the current
   * cursor position, focuses the editor, and lets detectComposerTrigger pick
   * up the new trigger so the inline picker opens as if the user had typed
   * the same keys.
   */
  insertTriggerAtCursor: (text: string) => void;
```

- [ ] **Step 2: Implement in `useImperativeHandle`**

Find the `addTerminalContext` implementation inside the `useImperativeHandle` block (around line 2192). Add `insertTriggerAtCursor` right after it:

```ts
        insertTriggerAtCursor: (text: string) => {
          const snapshot = composerEditorRef.current?.readSnapshot() ?? {
            value: promptRef.current,
            cursor: composerCursor,
            expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
            terminalContextIds: composerTerminalContexts.map((context) => context.id),
          };
          const { text: nextPrompt, cursor: nextExpandedCursor } = replaceTextRange(
            snapshot.value,
            snapshot.expandedCursor,
            snapshot.expandedCursor,
            text,
          );
          const nextCollapsedCursor = collapseExpandedComposerCursor(
            nextPrompt,
            nextExpandedCursor,
          );
          promptRef.current = nextPrompt;
          setComposerDraftPrompt(composerDraftTarget, nextPrompt);
          setComposerCursor(nextCollapsedCursor);
          setComposerTrigger(detectComposerTrigger(nextPrompt, nextExpandedCursor));
          window.requestAnimationFrame(() => {
            composerEditorRef.current?.focusAt(nextCollapsedCursor);
          });
        },
```

- [ ] **Step 3: Verify the dependency array**

The `useImperativeHandle` deps array (around line 2240) already includes all the names used here (`composerDraftTarget`, `composerCursor`, `composerTerminalContexts`, `promptRef`). Confirm with:

```bash
grep -n "useImperativeHandle" apps/web/src/components/chat/ChatComposer.tsx
```

If `setComposerDraftPrompt` is not in the dep array yet, add it. (It's almost certainly already there from the existing `addTerminalContext` flow.)

- [ ] **Step 4: Verify typecheck and tests pass**

```bash
bun run typecheck && bun run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ChatComposer.tsx
git commit -m "Add insertTriggerAtCursor imperative method to ChatComposer"
```

---

## Task 5: `ComposerHintRow.logic` pure pill resolver

Encapsulate the conditional-pill logic in a pure function so it can be unit-tested without rendering.

**Files:**

- Create: `apps/web/src/components/chat/ComposerHintRow.logic.ts`
- Create: `apps/web/src/components/chat/ComposerHintRow.logic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ComposerHintRow.logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveHintRowPills, type HintRowFlags } from "./ComposerHintRow.logic";

const all: HintRowFlags = { hasSourceControlRemote: true, hasJiraProvider: true };

describe("resolveHintRowPills", () => {
  it("returns all four pills when every flag is true", () => {
    const pills = resolveHintRowPills(all);
    expect(pills.map((p) => p.id)).toEqual([
      "reference-issue",
      "reference-pr",
      "reference-jira",
      "browse-commands",
    ]);
  });

  it("hides issue/PR when source-control remote is missing", () => {
    const pills = resolveHintRowPills({ hasSourceControlRemote: false, hasJiraProvider: true });
    expect(pills.map((p) => p.id)).toEqual(["reference-jira", "browse-commands"]);
  });

  it("hides Jira when no Jira provider is configured", () => {
    const pills = resolveHintRowPills({ hasSourceControlRemote: true, hasJiraProvider: false });
    expect(pills.map((p) => p.id)).toEqual(["reference-issue", "reference-pr", "browse-commands"]);
  });

  it("returns only browse-commands when both providers are absent", () => {
    const pills = resolveHintRowPills({ hasSourceControlRemote: false, hasJiraProvider: false });
    expect(pills.map((p) => p.id)).toEqual(["browse-commands"]);
  });

  it("each pill exposes the trigger text it inserts", () => {
    const pills = resolveHintRowPills(all);
    expect(Object.fromEntries(pills.map((p) => [p.id, p.trigger]))).toEqual({
      "reference-issue": "#i ",
      "reference-pr": "#pr ",
      "reference-jira": "#jira ",
      "browse-commands": "/",
    });
  });
});
```

- [ ] **Step 2: Run test, see it fail**

```bash
bun run test ComposerHintRow.logic
```

Expected: failure — module not found.

- [ ] **Step 3: Implement the helper**

Create `ComposerHintRow.logic.ts`:

```ts
export interface HintRowFlags {
  readonly hasSourceControlRemote: boolean;
  readonly hasJiraProvider: boolean;
}

export type HintRowPillId =
  | "reference-issue"
  | "reference-pr"
  | "reference-jira"
  | "browse-commands";

export type HintRowTrigger = "#i " | "#pr " | "#jira " | "/";

export interface HintRowPill {
  readonly id: HintRowPillId;
  readonly label: string;
  readonly trigger: HintRowTrigger;
  readonly ariaLabel: string;
}

const ISSUE_PILL: HintRowPill = {
  id: "reference-issue",
  label: "Reference issue",
  trigger: "#i ",
  ariaLabel: "Reference an issue (inserts #i)",
};
const PR_PILL: HintRowPill = {
  id: "reference-pr",
  label: "Reference PR",
  trigger: "#pr ",
  ariaLabel: "Reference a pull request (inserts #pr)",
};
const JIRA_PILL: HintRowPill = {
  id: "reference-jira",
  label: "Reference Jira",
  trigger: "#jira ",
  ariaLabel: "Reference a Jira ticket (inserts #jira)",
};
const COMMANDS_PILL: HintRowPill = {
  id: "browse-commands",
  label: "Browse commands",
  trigger: "/",
  ariaLabel: "Browse slash commands (inserts /)",
};

export function resolveHintRowPills(flags: HintRowFlags): ReadonlyArray<HintRowPill> {
  const pills: HintRowPill[] = [];
  if (flags.hasSourceControlRemote) {
    pills.push(ISSUE_PILL, PR_PILL);
  }
  if (flags.hasJiraProvider) {
    pills.push(JIRA_PILL);
  }
  pills.push(COMMANDS_PILL);
  return pills;
}
```

- [ ] **Step 4: Run tests, see them pass**

```bash
bun run test ComposerHintRow.logic
```

Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ComposerHintRow.logic.ts \
        apps/web/src/components/chat/ComposerHintRow.logic.test.ts
git commit -m "Add ComposerHintRow.logic for conditional pill resolution"
```

---

## Task 6: `ComposerHintRow` component

**Files:**

- Create: `apps/web/src/components/chat/ComposerHintRow.tsx`
- Create: `apps/web/src/components/chat/ComposerHintRow.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `ComposerHintRow.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerHintRow } from "./ComposerHintRow";

describe("ComposerHintRow", () => {
  it("renders nothing when visible is false", () => {
    const markup = renderToStaticMarkup(
      <ComposerHintRow
        visible={false}
        hasSourceControlRemote
        hasJiraProvider
        onInsertTrigger={() => undefined}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders four pills when both providers are configured", () => {
    const markup = renderToStaticMarkup(
      <ComposerHintRow
        visible
        hasSourceControlRemote
        hasJiraProvider
        onInsertTrigger={() => undefined}
      />,
    );
    expect(markup).toContain("Reference issue");
    expect(markup).toContain("Reference PR");
    expect(markup).toContain("Reference Jira");
    expect(markup).toContain("Browse commands");
  });

  it("hides issue and PR pills when no source-control remote", () => {
    const markup = renderToStaticMarkup(
      <ComposerHintRow
        visible
        hasSourceControlRemote={false}
        hasJiraProvider
        onInsertTrigger={() => undefined}
      />,
    );
    expect(markup).not.toContain("Reference issue");
    expect(markup).not.toContain("Reference PR");
    expect(markup).toContain("Reference Jira");
    expect(markup).toContain("Browse commands");
  });

  it("hides Jira pill when no Jira provider", () => {
    const markup = renderToStaticMarkup(
      <ComposerHintRow
        visible
        hasSourceControlRemote
        hasJiraProvider={false}
        onInsertTrigger={() => undefined}
      />,
    );
    expect(markup).toContain("Reference issue");
    expect(markup).toContain("Reference PR");
    expect(markup).not.toContain("Reference Jira");
    expect(markup).toContain("Browse commands");
  });

  it("attaches the correct aria-label per pill", () => {
    const markup = renderToStaticMarkup(
      <ComposerHintRow
        visible
        hasSourceControlRemote
        hasJiraProvider
        onInsertTrigger={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Reference an issue (inserts #i)"');
    expect(markup).toContain('aria-label="Reference a pull request (inserts #pr)"');
    expect(markup).toContain('aria-label="Reference a Jira ticket (inserts #jira)"');
    expect(markup).toContain('aria-label="Browse slash commands (inserts /)"');
  });
});
```

- [ ] **Step 2: Run test, see it fail**

```bash
bun run test ComposerHintRow
```

Expected: failure — module `./ComposerHintRow` not found.

- [ ] **Step 3: Implement the component**

Create `ComposerHintRow.tsx`:

```tsx
import { memo } from "react";
import { BugIcon, GitPullRequestIcon, SlashIcon, TicketIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  resolveHintRowPills,
  type HintRowPill,
  type HintRowTrigger,
} from "./ComposerHintRow.logic";

const PILL_ICON: Record<HintRowPill["id"], LucideIcon> = {
  "reference-issue": BugIcon,
  "reference-pr": GitPullRequestIcon,
  "reference-jira": TicketIcon,
  "browse-commands": SlashIcon,
};

export interface ComposerHintRowProps {
  readonly visible: boolean;
  readonly hasSourceControlRemote: boolean;
  readonly hasJiraProvider: boolean;
  readonly onInsertTrigger: (trigger: HintRowTrigger) => void;
  readonly className?: string;
}

export const ComposerHintRow = memo(function ComposerHintRow(props: ComposerHintRowProps) {
  if (!props.visible) {
    return null;
  }
  const pills = resolveHintRowPills({
    hasSourceControlRemote: props.hasSourceControlRemote,
    hasJiraProvider: props.hasJiraProvider,
  });
  if (pills.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("mx-auto mb-2 flex max-w-208 flex-wrap items-center gap-1.5", props.className)}
      data-testid="composer-hint-row"
    >
      {pills.map((pill) => {
        const Icon = PILL_ICON[pill.id];
        return (
          <Button
            key={pill.id}
            variant="outline"
            size="xs"
            aria-label={pill.ariaLabel}
            onClick={() => props.onInsertTrigger(pill.trigger)}
          >
            <Icon className="size-3.5 opacity-80" aria-hidden />
            <span>{pill.label}</span>
          </Button>
        );
      })}
    </div>
  );
});
```

- [ ] **Step 4: Run tests, see them pass**

```bash
bun run test ComposerHintRow
```

Expected: PASS (5 cases).

- [ ] **Step 5: Run formatting, lint, typecheck**

```bash
bun fmt && bun lint && bun run typecheck
```

Expected: clean across all three.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/chat/ComposerHintRow.tsx \
        apps/web/src/components/chat/ComposerHintRow.test.tsx
git commit -m "Add ComposerHintRow component"
```

---

## Task 7: Mount `ComposerHintRow` in `ChatView.tsx`

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`

- [ ] **Step 1: Add the imports**

Near the existing `ComposerBannerStack` import (around line 179):

```ts
import { ComposerHintRow } from "./chat/ComposerHintRow";
import type { HintRowTrigger } from "./chat/ComposerHintRow.logic";
```

- [ ] **Step 2: Derive `hasSourceControlRemote` and `hasJiraProvider` near the composer block**

The discovery hook `useSourceControlDiscovery` is already used elsewhere; reuse the same pattern. Find a stable place to add this (near where `composerBannerItems` is built, around line 1381). Add:

```ts
const sourceControlDiscoveryForHints = useSourceControlDiscovery();
const hasSourceControlRemote = useMemo(
  () =>
    (sourceControlDiscoveryForHints.data?.sourceControlProviders ?? []).some(
      (provider) =>
        provider.status === "available" &&
        (provider.auth.status === "authenticated" || provider.auth.status === "unknown"),
    ),
  [sourceControlDiscoveryForHints.data],
);
// The Atlassian/Jira source-control provider isn't shipped yet, so today we
// always treat the workspace as "no Jira" and hide the pill. When the
// Atlassian integration plan
// (docs/superpowers/plans/2026-05-12-atlassian-bitbucket-jira-integration.md)
// adds a new kind to SourceControlProviderKind, replace this constant with
// a `useMemo` over `sourceControlDiscoveryForHints.data?.sourceControlProviders`
// that checks `provider.kind` for the new value.
const hasJiraProvider = false;
```

If `useSourceControlDiscovery` is not yet imported in `ChatView.tsx`, add it:

```ts
import { useSourceControlDiscovery } from "~/lib/sourceControlDiscoveryState";
```

- [ ] **Step 3: Derive visibility**

Near the same block, add:

```ts
const hintRowVisible = !isServerThread || activeThread.messages.length === 0;
```

This mirrors the existing `isFirstMessage` expression around line 2960 of `ChatComposer.tsx`. `activeThread` is in scope inside this render path (it's already read on neighbouring lines).

- [ ] **Step 4: Wire the trigger handler**

Just below the visibility derivation:

```ts
const handleInsertHintTrigger = useCallback(
  (trigger: HintRowTrigger) => {
    composerRef.current?.insertTriggerAtCursor(trigger);
  },
  [composerRef],
);
```

- [ ] **Step 5: Render the hint row**

Find this block (around line 3938-3940):

```tsx
            <div className="relative isolate">
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
              <div className="relative z-10">
                <ChatComposer
```

Insert `ComposerHintRow` between `ComposerBannerStack` and the inner `<div>`:

```tsx
            <div className="relative isolate">
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
              <ComposerHintRow
                visible={hintRowVisible}
                hasSourceControlRemote={hasSourceControlRemote}
                hasJiraProvider={hasJiraProvider}
                onInsertTrigger={handleInsertHintTrigger}
              />
              <div className="relative z-10">
                <ChatComposer
```

- [ ] **Step 6: Verify it builds**

```bash
bun run typecheck
```

Expected: clean. If TypeScript flags missing `activeThread` access (e.g., possibly-undefined), narrow with the existing pattern in that scope, or guard with `activeThread ? ... : false`.

- [ ] **Step 7: Run lint, format, tests**

```bash
bun fmt && bun lint && bun run test
```

Expected: clean. The existing test suite should keep passing because the new component is purely additive.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "Mount ComposerHintRow above the composer on fresh threads"
```

---

## Task 8: Smoke test in dev mode

**Files:** none modified.

- [ ] **Step 1: Start the web dev server**

```bash
bun run dev:web
```

Wait for the URL to print.

- [ ] **Step 2: Open a fresh thread in a workspace that has a configured source-control remote**

Verify:

1. Three pills appear above the composer: **Reference issue**, **Reference PR**, **Browse commands**. (Jira is absent because no Atlassian provider exists.)
2. Click **Reference PR** → composer focuses, `#pr ` appears in the input, and the inline picker opens showing only PRs.
3. Type more text after `#pr ` and confirm the list filters to PRs matching the search.
4. Backspace until the `#pr ` prefix is gone, then type `#` alone → mixed picker (issues + PRs) appears, confirming bare `#` is backward-compatible.
5. Send a message in the thread → hint row disappears immediately and does not return when the next message is being typed.
6. Open a different fresh thread → hint row reappears.

- [ ] **Step 3: Open a thread in a workspace with no source-control remote**

Expected: only the **Browse commands** pill is shown. Clicking it inserts `/` and opens the slash-command picker.

- [ ] **Step 4: Final check — run the full quality gate**

```bash
bun fmt && bun lint && bun run typecheck && bun run test
```

Expected: all clean.

- [ ] **Step 5: Final commit if any cleanup was needed**

If you made no changes during smoke testing, skip this step. Otherwise:

```bash
git add -p apps/web/src/components/
git commit -m "Polish composer hint row after smoke test"
```

---

## Acceptance Criteria Recap

Mapped to the spec:

1. **Up to four pills above the composer on a fresh thread** — Task 7 mounts `ComposerHintRow` with `hintRowVisible`; Task 5 resolves the pill set; Task 6 renders them.
2. **Click → trigger inserted → scoped picker opens** — Task 4's `insertTriggerAtCursor` inserts; Task 3 routes the trigger through Task 2's scoped builder.
3. **Manual typing of `#i `/`#pr `/`#jira ` matches the click flow** — Task 1 + Task 2 + Task 3 share the same scope logic; Task 8 verifies the parity.
4. **Bare `#` keeps today's mixed behavior** — Task 1's `scopeSourceControlQuery` returns `mixed` on the empty input; Task 2's builder returns combined list when scope is `mixed`.
5. **Row never reappears after first send in a thread** — Task 7's `hintRowVisible` only evaluates true while `messages.length === 0`.
6. **`bun fmt`, `bun lint`, `bun run typecheck`, `bun run test` all pass** — Task 8 step 4.
