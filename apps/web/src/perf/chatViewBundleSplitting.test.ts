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
      "./chat/ExpandedImageDialog",
      "./agent-control/AgentControlApprovals",
      "./shell/phone/PhoneWorkSurface",
    ]) {
      expect(staticValueImports(chatView, specifier)).toEqual([]);
      expect(staticValueImports(branchToolbar, specifier)).toEqual([]);
    }
    expect(lazySurfaces).toContain('import("./ChatOverviewPanel")');
    expect(lazySurfaces).toContain('import("../SideChatPanel")');
    expect(lazySurfaces).toContain('import("./ContextHandoffInspectionPanel")');
    expect(lazySurfaces).toContain('import("./ComputerBetaPreview")');
    expect(lazySurfaces).toContain('import("../PullRequestThreadDialog")');
    expect(lazySurfaces).toContain('import("./ExpandedImageDialog")');
    expect(lazySurfaces).toContain('import("../agent-control/AgentControlApprovals")');
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

  it("keeps the frozen phone tier's thread surfaces out of the chat route graph", async () => {
    // Specifier of each phone surface, relative to the components directory.
    const phoneSurfaces = [
      "shell/phone/PhoneThreadAppBar",
      "shell/phone/PhoneThreadDock",
      "shell/phone/PhoneWorkSurface",
      "chat/PhoneSessionPolicySheet",
      "chat/PhoneModelSheet",
      "chat/MessageActionsSheet",
      "mobile/MobileSelectSheet",
    ];
    const importers = [
      "ChatView.tsx",
      "chat/ChatComposer.tsx",
      "chat/ComposerFooter.tsx",
      "chat/ProviderModelPicker.tsx",
      "chat/MessagesTimeline.tsx",
      "routeViews/ChatThreadRouteView.tsx",
      "routeViews/DraftChatThreadRouteView.tsx",
    ];
    for (const importer of importers) {
      const source = await readSource(`../components/${importer}`);
      const depth = importer.split("/").length - 1;
      const prefix = depth === 0 ? "./" : "../".repeat(depth);
      for (const surface of phoneSurfaces) {
        expect(staticValueImports(source, `${prefix}${surface}`), importer).toEqual([]);
      }
    }
    // One chunk carries them all, reached only through the lazy wrappers.
    const lazyPhoneSurfaces = await readSource(
      "../components/shell/phone/lazyPhoneThreadSurfaces.ts",
    );
    expect(lazyPhoneSurfaces).toContain('import("./phoneThreadSurfaces")');
    expect(lazyPhoneSurfaces).toContain("preloadableLazy(");
    expect(staticValueImports(lazyPhoneSurfaces, "./phoneThreadSurfaces")).toEqual([]);
    // The chat routes load the wrappers (boot), so they stay a bare loader:
    // the mount hook and its toast live in `usePhoneThreadSurfaceReady`.
    expect(staticValueImports(lazyPhoneSurfaces, "../../chat/chatViewLazySurfaces")).toEqual([]);
    // On the phone tier both chat routes wait for the surfaces with their view.
    for (const route of ["_chat.$environmentId.$threadId.tsx", "_chat.draft.$draftId.tsx"]) {
      expect(await readSource(`../routes/${route}`), route).toContain(
        "loadChatRouteView(() => import(",
      );
    }
  });

  it("loads the Shiki highlighter on the first code block, not with the route", async () => {
    const chatMarkdown = await readSource("../components/ChatMarkdown.tsx");
    const highlightQueue = await readSource("../components/chat/codeHighlightQueue.ts");

    expect(staticValueImports(chatMarkdown, "@pierre/diffs")).toEqual([]);
    expect(staticValueImports(highlightQueue, "@pierre/diffs")).toEqual([]);
    expect(highlightQueue).toContain('import("@pierre/diffs")');
  });
});
