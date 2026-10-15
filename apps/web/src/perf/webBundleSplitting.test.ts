import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

/** A `React.lazy` import: route bodies must not suspend on their first render. */
const REACT_LAZY_IMPORT = /import\s*\{[^}]*\blazy\b[^}]*\}\s*from\s*"react"/;

describe("web bundle splitting boundaries", () => {
  it("keeps chat route files limited to eager route metadata", async () => {
    const serverRoute = await readSource("../routes/_chat.$environmentId.$threadId.tsx");
    const draftRoute = await readSource("../routes/_chat.draft.$draftId.tsx");

    expect(serverRoute).toContain('import("../components/routeViews/ChatThreadRouteView")');
    expect(draftRoute).toContain('import("../components/routeViews/DraftChatThreadRouteView")');
    for (const routeSource of [serverRoute, draftRoute]) {
      expect(routeSource).toContain("lazyRouteComponent(");
      expect(routeSource).not.toMatch(REACT_LAZY_IMPORT);
      expect(routeSource).not.toContain("<Suspense");
      expect(routeSource).not.toContain("../components/ChatView");
      expect(routeSource).not.toContain("../components/ChatRightPanel");
    }
  });

  it("splits route bodies at the route level so navigation never commits a Suspense fallback", async () => {
    const routeFiles = [
      "../routes/_chat.$environmentId.$threadId.tsx",
      "../routes/_chat.draft.$draftId.tsx",
      "../routes/statistics.tsx",
      "../routes/pull-requests.tsx",
      "../routes/projects.tsx",
      "../routes/_settings.diagnostics.tsx",
      "../routes/native.authorize.$handoffId.tsx",
    ];
    for (const file of routeFiles) {
      const source = await readSource(file);
      expect(source, file).toContain("lazyRouteComponent(");
      expect(source, file).not.toMatch(REACT_LAZY_IMPORT);
      expect(source, file).not.toContain("<Suspense");
    }

    // Settings keeps its component next to the preload that warms it.
    const settingsRoute = await readSource("../routes/settings.tsx");
    const settingsRouteModule = await readSource("../settingsRoute.ts");
    expect(settingsRoute).toContain("SettingsRouteComponent");
    expect(settingsRoute).not.toMatch(REACT_LAZY_IMPORT);
    expect(settingsRouteModule).toContain("lazyRouteComponent(");
    expect(settingsRouteModule).toContain("SettingsRouteComponent.preload");
  });

  it("keeps the chat layout and index bodies out of the route registration graph", async () => {
    const layoutRoute = await readSource("../routes/_chat.tsx");
    const indexRoute = await readSource("../routes/_chat.index.tsx");

    expect(layoutRoute).toContain('import("../components/routeViews/ChatLayoutRouteView")');
    expect(indexRoute).toContain('import("../components/routeViews/ChatIndexRouteView")');
    for (const source of [layoutRoute, indexRoute]) {
      expect(source).toContain("lazyRouteComponent(");
      expect(source).not.toMatch(REACT_LAZY_IMPORT);
      // Only the route helpers stay eager; stores and views load with the body.
      expect(source.match(/^import [^;]+;$/gmu)?.length ?? 0).toBeLessThanOrEqual(2);
    }
    expect(indexRoute).not.toContain("NoActiveThreadState");
    expect(layoutRoute).not.toContain("useHandleNewThread");
  });

  it("loads the preview navigation guard after the first render", async () => {
    const rootRoute = await readSource("../routes/__root.tsx");

    // File Preview drafts only exist once the preview panel has loaded.
    expect(rootRoute).not.toMatch(/^import \{ PreviewFileNavigationGuard \}/mu);
    expect(rootRoute).toContain('import("../components/PreviewFileNavigationGuard")');
  });

  it("runs the hosted access check from the boot chunk without a chunk round trip", async () => {
    const rootRoute = await readSource("../routes/__root.tsx");
    const bootGate = await readSource("../hostedHub/bootGate.ts");
    const hostedState = await readSource("../hostedHub/state.ts");

    expect(rootRoute).toContain('import { runHostedBootGate } from "../hostedHub/bootGate";');
    expect(rootRoute).not.toContain("hostedHub/logging");
    expect(rootRoute).not.toContain('import("../hostedHub/state")');
    expect(rootRoute).not.toContain('import("../hostedHub/readCache")');
    expect(bootGate).toMatch(/^import \{[^}]*\} from "\.\/readCache";$/mu);
    expect(bootGate).toMatch(/^import \{[^}]*\} from "\.\/state";$/mu);
    // The console boundary goes in before the hosted runtime is wired.
    const ensure = hostedState.slice(
      hostedState.indexOf("function ensureWebHostedRuntimeConfigured"),
    );
    expect(ensure.indexOf("installHostedConsoleBoundary()")).toBeGreaterThan(0);
    expect(ensure.indexOf("installHostedConsoleBoundary()")).toBeLessThan(
      ensure.indexOf("configureWebHostedRuntime("),
    );
  });

  it("loads feature stylesheets with the chunks that render them", async () => {
    const indexCss = await readSource("../index.css");
    const owners: ReadonlyArray<readonly [string, string]> = [
      ["../components/pullRequests/PullRequestsPage.tsx", "./pullRequests.css"],
      ["../components/pullRequests/workspace/WorkspacePullRequestPanel.tsx", "../pullRequests.css"],
      ["../components/projects/ProjectsPage.tsx", "./projects.css"],
      ["../components/automations/dialog/AutomationsDialog.tsx", "../styles/automations.css"],
      ["../components/overview/crown/CrownOverview.tsx", "../overview.css"],
    ];
    for (const sheet of ["pullRequests.css", "projects.css", "automations.css", "overview.css"]) {
      expect(indexCss).not.toContain(sheet);
    }
    for (const [owner, sheet] of owners) {
      expect(await readSource(owner), owner).toContain(`import "${sheet}";`);
    }
    // The sidebar's workspace pull request popover renders the rail's marks.
    expect(indexCss).toContain('@import "./components/pullRequests/styles/rail.css";');
    expect(await readSource("../components/pullRequests/pullRequests.css")).not.toContain(
      '@import "./styles/rail.css";',
    );
  });

  it("loads the root shell during beforeLoad instead of through React.lazy", async () => {
    const rootRoute = await readSource("../routes/__root.tsx");

    expect(rootRoute).toContain('import("../components/RootAppShell")');
    expect(rootRoute).toContain('import("../components/hostedHub/HostedHubRoot")');
    expect(rootRoute).toContain("preloadableLazy(");
    expect(rootRoute).not.toMatch(/const RootAppShell = lazy\(/);
    expect(rootRoute).not.toMatch(/const HostedHubRoot = lazy\(/);
  });

  it("keeps optional shell surfaces behind lazy imports", async () => {
    const appSidebarLayout = await readSource("../components/AppSidebarLayout.tsx");
    const commandPalette = await readSource("../components/CommandPalette.tsx");

    expect(appSidebarLayout).toContain('import("./shell/phone/PhoneSettingsSurface")');
    expect(appSidebarLayout).not.toContain("./settings/SettingsPage");
    expect(commandPalette).toContain('import("./CommandPaletteDialog")');
    expect(commandPalette).not.toContain("./CommandPalette.logic");
  });

  it("keeps heavy route bodies out of the eager route registration graph", async () => {
    const statisticsRoute = await readSource("../routes/statistics.tsx");
    const pullRequestsRoute = await readSource("../routes/pull-requests.tsx");
    const projectsRoute = await readSource("../routes/projects.tsx");
    const settingsRoute = await readSource("../routes/settings.tsx");
    const diagnosticsRoute = await readSource("../routes/_settings.diagnostics.tsx");
    const nativeAuthorizationRoute = await readSource("../routes/native.authorize.$handoffId.tsx");

    const settingsRouteModule = await readSource("../settingsRoute.ts");

    expect(statisticsRoute).toContain('import("../components/routeViews/StatisticsRouteView")');
    expect(statisticsRoute).not.toContain("components/statistics/StatisticsPage");
    // Its data prefetch is loaded on demand as well.
    expect(statisticsRoute).toContain('import("../components/statistics/statisticsPrefetch")');
    expect(statisticsRoute).not.toMatch(
      /from "\.\.\/components\/(statistics\/(statisticsPrefetch|useUsageSummary)|settings\/statistics\/useStatistics)"/,
    );
    expect(pullRequestsRoute).toContain('import("../components/routeViews/PullRequestsRouteView")');
    expect(pullRequestsRoute).not.toContain("components/pullRequests/PullRequestsPage");
    expect(projectsRoute).toContain('import("../components/routeViews/ProjectsRouteView")');
    expect(projectsRoute).not.toContain("components/projects/ProjectsPage");
    expect(settingsRouteModule).toContain('import("./components/routeViews/SettingsRouteView")');
    expect(settingsRouteModule).not.toContain('from "./components/settings/SettingsPage"');
    expect(settingsRoute).not.toContain("components/settings/SettingsPage");
    expect(diagnosticsRoute).toContain('import("../components/routeViews/DiagnosticsRouteView")');
    expect(diagnosticsRoute).not.toContain("components/settings/DiagnosticsSettings");
    expect(nativeAuthorizationRoute).toContain(
      'import("../components/routeViews/NativeAuthorizationRouteView")',
    );
    expect(nativeAuthorizationRoute).not.toContain(
      "components/hostedHub/HostedNativeAuthorizationRoute",
    );
  });

  it("keeps the first-navigation pairing surface eager", async () => {
    const pairRoute = await readSource("../routes/pair.tsx");

    expect(pairRoute).toContain('from "../components/auth/PairingRouteSurface"');
    expect(pairRoute).not.toContain('import("../components/auth/PairingRouteSurface")');
  });

  it("loads xterm css from the terminal drawer chunk instead of the app entry", async () => {
    const mainEntry = await readSource("../main.tsx");
    const terminalDrawer = await readSource("../components/ThreadTerminalDrawer.tsx");

    expect(mainEntry).not.toContain("@xterm/xterm/css/xterm.css");
    expect(terminalDrawer).toContain("@xterm/xterm/css/xterm.css");
  });

  // Transitive reachability (hosted runtime, markdown, dialogs) is guarded by
  // standardBootGraph.test.ts and, on the built dist, `bun run perf:bundle-budget`.
  it("keeps the pull request diff renderer behind the Files tab chunk", async () => {
    const reader = await readSource("../components/pullRequests/PullRequestReader.tsx");

    expect(reader).toContain('import("./files/FilesTab")');
    expect(reader).not.toMatch(/import \{[^}]*\bFilesTab\b[^}]*\} from "\.\/files\/FilesTab"/u);
    // The shared loader: a loaded tab renders on the first pass, never through a fallback.
    expect(reader).toContain("preloadableLazy(");
    expect(reader).not.toMatch(REACT_LAZY_IMPORT);
    expect(reader).not.toContain("<Suspense");
  });

  it("mounts sidebar worktree dialogs lazily and preloads them on intent", async () => {
    const worktreeList = await readSource("../components/sidebar/SidebarWorktreeList.tsx");
    const projectDialogs = await readSource("../components/sidebar/SidebarProjectDialogOwner.tsx");
    const projectItem = await readSource("../components/sidebar/SidebarProjectItem.tsx");
    const sharedDialogs = await readSource("../components/worktrees/lazyWorktreeDialogs.ts");

    // One code-split wrapper per dialog, shared with the chat, so a preload
    // from either surface serves both.
    expect(sharedDialogs).toContain('import("./LinkedWorktreeItemDialog")');
    expect(sharedDialogs).toContain('import("./NewWorktreeDialog")');
    expect(sharedDialogs).toContain("preloadableLazy(");
    expect(sharedDialogs).not.toMatch(
      /^import \{[^}]*\} from "\.\/(?:LinkedWorktreeItemDialog|NewWorktreeDialog)";$/mu,
    );
    expect(worktreeList).not.toMatch(/import \{[^}]*\bLinkedWorktreeItemDialog\b/u);
    expect(projectDialogs).not.toMatch(/import \{[^}]*\bNewWorktreeDialog\b/u);
    for (const source of [worktreeList, projectDialogs]) {
      expect(source).toContain('from "../worktrees/lazyWorktreeDialogs"');
      expect(source).not.toContain("preloadableLazy(");
      expect(source).toContain("useLazyComponentReady(");
      // A failed chunk is a toast with a Retry, never the root error view.
      expect(source).toContain("onLoadError:");
      expect(source).not.toMatch(REACT_LAZY_IMPORT);
      expect(source).not.toContain("<Suspense");
    }
    // Pointing at what opens them starts the chunk load.
    expect(worktreeList).toContain("onOpenLinkedItemIntent={preloadLinkedWorktreeItemDialog}");
    expect(projectItem).toContain("onOpenNewWorktreeIntent={preloadNewWorktreeDialog}");
  });

  it("preloads the shell's on-demand dialogs from their entry points", async () => {
    const primaryActions = await readSource("../components/sidebar/SidebarPrimaryActions.tsx");
    const automationsStore = await readSource(
      "../components/automations/automationsDialogStore.ts",
    );

    expect(automationsStore).toContain('import("./dialog/AutomationsDialog")');
    expect(primaryActions).toContain("onPointerEnter={preloadAutomationsDialog}");
    expect(primaryActions).toContain("onFocus={preloadAutomationsDialog}");
  });

  it("keeps React.lazy off every surface except an explicit allowlist", async () => {
    // `React.lazy` commits its fallback on every first mount and React then
    // holds the reveal for up to 300 ms; code-split surfaces use
    // `preloadableLazy` instead. Allowed: the frozen phone tier, render-null or
    // overlay guards whose fallback never shows content, and the PDF preview.
    const allowed = new Set([
      "main.tsx",
      "routes/__root.tsx",
      "components/AppSidebarLayout.tsx",
      "components/shell/phone/PhoneSettingsSurface.tsx",
      "components/chat/AttachmentDocumentPreview.tsx",
    ]);
    const srcRoot = new URL("../", import.meta.url);
    const entries = await readdir(srcRoot, { recursive: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      const file = entry.replaceAll("\\", "/");
      if (!file.endsWith(".tsx") || /\.(?:test|browser)\.tsx$/u.test(file)) continue;
      if (allowed.has(file)) continue;
      const source = await readFile(new URL(file, srcRoot), "utf8");
      if (/(?<![\w.])lazy\(|React\.lazy\(/u.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
