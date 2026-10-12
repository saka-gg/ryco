import { readFile } from "node:fs/promises";
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

    expect(worktreeList).toContain('import("../worktrees/LinkedWorktreeItemDialog")');
    expect(worktreeList).not.toMatch(/import \{[^}]*\bLinkedWorktreeItemDialog\b/u);
    expect(projectDialogs).toContain('import("../worktrees/NewWorktreeDialog")');
    expect(projectDialogs).not.toMatch(/import \{[^}]*\bNewWorktreeDialog\b/u);
    for (const source of [worktreeList, projectDialogs]) {
      expect(source).toContain("preloadableLazy(");
      expect(source).toContain("useLazyComponentReady(");
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
});
