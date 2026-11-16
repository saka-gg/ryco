import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * appWindows.ts holds the behaviour; these source checks pin main.ts to it. The bug lived in
 * main.ts: `BrowserWindow.getAllWindows()` also lists the embedded browser's hidden tab hosts,
 * so it kept the app running without a window and picked a host as "the" window.
 */
const main = readFileSync(join(import.meta.dirname, "main.ts"), "utf8");

/** The body of a top-level `function name(` in main.ts (up to its closing brace at column 0). */
function topLevelFunction(name: string): string {
  const start = main.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = main.indexOf("\n}\n", start);
  expect(end, `end of function ${name}`).toBeGreaterThan(start);
  return main.slice(start, end + 2);
}

describe("main.ts app window wiring", () => {
  it("tracks every window createWindow makes", () => {
    expect(topLevelFunction("createWindow")).toContain("appWindows.track(window);");
  });

  it("never picks a window from BrowserWindow.getAllWindows() or an unfiltered focused window", () => {
    expect(main).not.toMatch(/BrowserWindow\.getAllWindows\(\)\[0\]/u);
    expect(main).not.toMatch(/\[\w+\] = BrowserWindow\.getAllWindows\(\)/u);
    expect(main).not.toMatch(/BrowserWindow\.getAllWindows\(\)\.length/u);
    expect(main).not.toMatch(/BrowserWindow\.getFocusedWindow\(\) \?\?/u);
  });

  it("quits outside macOS when the last app window closes, not when every window has", () => {
    const registry = main.slice(
      main.indexOf("const appWindows = createAppWindowRegistry<BrowserWindow>({"),
      main.indexOf("\n});\n", main.indexOf("const appWindows = createAppWindowRegistry")),
    );
    expect(registry).toContain('if (process.platform !== "darwin" && !isQuitting) app.quit();');
    expect(main).toContain('app.on("window-all-closed", () => undefined);');
  });

  it("opens a missing window for menu actions through the path that loads the app", () => {
    expect(topLevelFunction("dispatchMenuAction")).not.toContain("createWindow(");
    const checkForUpdates = topLevelFunction("handleCheckForUpdatesMenuClick");
    expect(checkForUpdates).not.toContain("createWindow(");
    expect(checkForUpdates).toContain("openMainWindow();");
    const open = topLevelFunction("openMainWindow");
    expect(open).toContain("ensureDevelopmentInitialWindowOpen();");
    expect(open).toContain("ensureInitialBackendWindowOpen();");
    expect(main).toContain("open: openMainWindow,");
  });

  it("waits on every development backend child, not only the first", () => {
    expect(topLevelFunction("ensureInitialBackendWindowOpen")).toContain(
      "if (developmentReadinessWatchArmed) ensureDevelopmentInitialWindowOpen();",
    );
    const development = topLevelFunction("ensureDevelopmentInitialWindowOpen");
    expect(development).not.toContain("existingWindow !== null");
    expect(development).toContain("resumeDesktopHostedIdentityForBackend();");
    expect(topLevelFunction("bootstrap")).toContain("developmentReadinessWatchArmed = true;");
  });

  it("delivers a held menu action once an app window's shell reports usable", () => {
    const usable = main.indexOf("appShellUsableContents.add(event.sender);");
    expect(usable).toBeGreaterThanOrEqual(0);
    expect(main.slice(usable, usable + 400)).toContain(
      "if (appWindows.has(window)) appMenuActions.shellUsable(window);",
    );
    expect(main).toContain(
      "isShellUsable: (window) => appShellUsableContents.has(window.webContents),",
    );
  });
});
