import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

function region(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing ${end} after ${start}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("Desktop main quit confirmation wiring", () => {
  const main = source("main.ts");

  it("asks before the before-quit cleanup, and never holds programmatic or system quits", () => {
    const handler = region(
      main,
      "const quitCleanupHandler = createQuitCleanupHandler({",
      "cleanup:",
    );
    expect(handler).toContain("confirm: quitConfirmation.confirm");
    expect(handler).toContain(
      "mustQuitNow: () => isQuitting || updateInstallInFlight || systemShutdownNotice.active()",
    );
    expect(handler).toContain("onAbsorbed: quitConfirmation.revealDialog");
    expect(main).toContain('app.on("before-quit", quitCleanupHandler);');
    // Only a backend this process owns stops on quit.
    expect(main).toContain(
      "findTarget: () => (backendProcess === null ? null : findQuitGuardWindow())",
    );
  });

  it("accepts replies only from the asked window's own document", () => {
    const reply = region(
      main,
      "ipcMain.on(DESKTOP_QUIT_GUARD_IPC.reply, (event, raw: unknown) => {",
      "});",
    );
    expect(reply).toContain("if (event.senderFrame !== event.sender.mainFrame) return;");
    expect(reply).toContain("quitGuardRequester.receive(event.sender, raw);");
  });

  it("lets a system shutdown or session end through an open confirmation", () => {
    const watch = region(main, "function watchSystemShutdown(): void {", "\n}\n");
    expect(watch).toContain('powerMonitor.on("shutdown", () => {');
    expect(watch).toContain("systemShutdownNotice.mark();");
    expect(watch).toContain("if (quitCleanupHandler.confirming()) app.quit();");
    expect(watch).not.toContain("preventDefault");
    const dialog = region(main, "async function showQuitConfirmationDialog(", "\n}\n");
    expect(dialog).toContain('window.once("query-session-end", onSessionEnd)');
    expect(dialog).toContain('window.off("query-session-end", onSessionEnd)');
    expect(dialog).toContain("signal,");
  });

  it("handles termination signals itself, so a signal never opens the confirmation", () => {
    // Electron's shutdown-signal handler replaces handlers installed before `ready` and quits
    // through before-quit like a person would; ours must be installed after it.
    const handlers = region(main, "function handleTerminationSignals(): void {", "\n}\n");
    expect(handlers).toContain('process.on("SIGINT", () => {');
    expect(handlers).toContain('process.on("SIGTERM", () => {');
    expect(handlers.match(/isQuitting = true;/g)).toHaveLength(2);
    const ready = region(main, "app\n  .whenReady()\n  .then(() => {", "bootstrap()");
    expect(ready).toContain("handleTerminationSignals();");
    expect(main.match(/process\.on\("SIG(?:INT|TERM)"/g)).toHaveLength(2);
  });

  it("only asks windows whose app shell reported usable", () => {
    const find = region(main, "function findQuitGuardWindow()", "\n}\n");
    expect(find).toContain("contents.isCrashed()");
    expect(find).toContain("!appShellUsableContents.has(contents)");
  });
});
