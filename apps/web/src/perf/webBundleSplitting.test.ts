import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("web bundle splitting boundaries", () => {
  it("keeps chat route files limited to eager route metadata", async () => {
    const serverRoute = await readSource("../routes/_chat.$environmentId.$threadId.tsx");
    const draftRoute = await readSource("../routes/_chat.draft.$draftId.tsx");

    for (const routeSource of [serverRoute, draftRoute]) {
      expect(routeSource).toContain("lazy(");
      expect(routeSource).not.toContain("../components/ChatView");
      expect(routeSource).not.toContain("../components/ChatRightPanel");
    }
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
    const settingsRoute = await readSource("../routes/settings.tsx");
    const diagnosticsRoute = await readSource("../routes/_settings.diagnostics.tsx");
    const nativeAuthorizationRoute = await readSource("../routes/native.authorize.$handoffId.tsx");

    expect(statisticsRoute).toContain('import("../components/statistics/StatisticsPage")');
    expect(statisticsRoute).not.toContain("import { StatisticsPage }");
    expect(pullRequestsRoute).toContain('import("../components/pullRequests/PullRequestsPage")');
    expect(pullRequestsRoute).not.toContain("import { PullRequestsPage }");
    expect(settingsRoute).toContain('import("../components/settings/SettingsPage")');
    expect(settingsRoute).not.toContain("import { SettingsPage }");
    expect(diagnosticsRoute).toContain('import("../components/settings/DiagnosticsSettings")');
    expect(diagnosticsRoute).not.toContain("import { DiagnosticsSettings }");
    expect(nativeAuthorizationRoute).toContain(
      'import("../components/hostedHub/HostedNativeAuthorizationRoute")',
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
});
