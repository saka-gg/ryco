import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

/**
 * main.ts only wires window-state persistence and renderer crash recovery
 * (windowState.ts, rendererCrashRecovery.ts hold the behaviour). Its wiring is
 * where the original bug lived (a crash handler in the packaged branch only,
 * nothing scheduling a reload), so these source checks pin it.
 */
async function readMain(): Promise<string> {
  return readFile(new URL("./main.ts", import.meta.url), "utf8");
}

/** The body of a top-level `function name(` in main.ts (up to its closing brace at column 0). */
function topLevelFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  expect(end, `end of function ${name}`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

function braceDepthAt(body: string, index: number): number {
  const prefix = body.slice(0, index);
  return prefix.split("{").length - prefix.split("}").length;
}

describe("main.ts window recovery wiring", () => {
  it("maximizes a restored window right before its first show", async () => {
    const reveal = topLevelFunction(await readMain(), "revealWindow");
    const beforeFirstShow = reveal.indexOf("desktopWindowState.beforeFirstShow(window);");
    expect(beforeFirstShow).toBeGreaterThanOrEqual(0);
    expect(beforeFirstShow).toBeLessThan(reveal.indexOf("window.show();"));
  });

  it("restores, then tracks, every window it creates", async () => {
    const create = topLevelFunction(await readMain(), "createWindow");
    const restore = create.indexOf("desktopWindowState.restore(readDisplayWorkAreas())");
    const construct = create.indexOf("new BrowserWindow({");
    const track = create.indexOf("desktopWindowState.track(window, restoredWindowState);");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(construct);
    expect(create.slice(construct, track)).toContain("...restoredWindowState.bounds,");
    expect(track).toBeGreaterThan(construct);
  });

  it("attaches crash recovery to development and packaged windows alike", async () => {
    const create = topLevelFunction(await readMain(), "createWindow");
    const attach = create.indexOf("attachRendererCrashRecovery(window,");
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("attachRendererCrashRecovery(", attach + 1)).toBe(-1);
    // Directly in the function body, outside the `if (isDevelopment) … else …` branches.
    expect(braceDepthAt(create, attach)).toBe(1);
    expect(create.slice(create.indexOf("if (isDevelopment) {"), attach)).toContain("\n  }\n");
  });

  it("reports a usable shell to the window's crash recovery", async () => {
    expect(await readMain()).toContain(
      "rendererCrashRecoveries.get(event.sender)?.noteShellUsable();",
    );
  });

  it("saves the window before a relaunch exits the app", async () => {
    const relaunch = topLevelFunction(await readMain(), "relaunchDesktopApp");
    const flush = relaunch.indexOf("desktopWindowState.flushAll();");
    expect(flush).toBeGreaterThanOrEqual(0);
    expect(flush).toBeLessThan(relaunch.lastIndexOf("app.exit("));
  });
});
