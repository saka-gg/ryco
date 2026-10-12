import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

/** Static value imports of `specifier` (type-only imports are erased). */
function staticValueImports(source: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pattern = new RegExp(`^import\\s+(?!type\\s)[^;]*?from\\s+"${escaped}";`, "gms");
  return source.match(pattern) ?? [];
}

describe("chat route first-frame graph", () => {
  it("keeps conditional ChatView surfaces behind on-demand imports", async () => {
    const chatView = await readSource("../components/ChatView.tsx");
    const branchToolbar = await readSource("../components/BranchToolbar.tsx");
    const lazySurfaces = await readSource("../components/chat/chatViewLazySurfaces.ts");

    for (const specifier of [
      "./chat/ChatOverviewPanel",
      "./SideChatPanel",
      "./chat/ContextHandoffInspectionPanel",
      "./chat/ComputerBetaPreview",
      "./PullRequestThreadDialog",
      // The linked-item dialog statically reaches the work item detail views
      // and the raw-HTML markdown stack (parse5), about 330 KiB raw.
      "./worktrees/LinkedWorktreeItemDialog",
      "./worktrees/NewWorktreeDialog",
    ]) {
      expect(staticValueImports(chatView, specifier)).toEqual([]);
      expect(staticValueImports(branchToolbar, specifier)).toEqual([]);
    }
    expect(lazySurfaces).toContain('import("./ChatOverviewPanel")');
    expect(lazySurfaces).toContain('import("../SideChatPanel")');
    expect(lazySurfaces).toContain('import("./ContextHandoffInspectionPanel")');
    expect(lazySurfaces).toContain('import("./ComputerBetaPreview")');
    expect(lazySurfaces).toContain('import("../PullRequestThreadDialog")');
    // The worktree dialogs are split once for the chat and the sidebar.
    const worktreeDialogs = await readSource("../components/worktrees/lazyWorktreeDialogs.ts");
    expect(worktreeDialogs).toContain('import("./LinkedWorktreeItemDialog")');
    expect(worktreeDialogs).toContain('import("./NewWorktreeDialog")');
    // The new-thread source picker sits in the hero; its PR, issue and Jira
    // lists load with the picker's first open.
    const sourcePicker = await readSource("../components/chat/NewThreadSourcePicker.tsx");
    for (const specifier of [
      "../projectExplorer/PullRequestsTab",
      "../projectExplorer/IssuesTab",
      "../projectExplorer/WorkItemsTab",
    ]) {
      expect(staticValueImports(sourcePicker, specifier)).toEqual([]);
      expect(sourcePicker).toContain(`import("${specifier}")`);
    }
    // One lazy helper for the whole app: the Suspense-free mount path lives in
    // `preloadableLazy` (`useLazyComponentReady`).
    expect(lazySurfaces).toContain("preloadableLazy(");
    expect(chatView).toContain("useLazyComponentReady(");
  });

  it("loads the Shiki highlighter on the first code block, not with the route", async () => {
    const chatMarkdown = await readSource("../components/ChatMarkdown.tsx");
    const highlightQueue = await readSource("../components/chat/codeHighlightQueue.ts");

    expect(staticValueImports(chatMarkdown, "@pierre/diffs")).toEqual([]);
    expect(staticValueImports(highlightQueue, "@pierre/diffs")).toEqual([]);
    expect(highlightQueue).toContain('import("@pierre/diffs")');
  });
});
