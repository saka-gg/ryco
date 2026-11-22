/**
 * Where a hand-off's remote key input goes, on real Electron with hidden windows only. The owner's
 * keys from the phone or another browser reach a handed-off tab as CDP `Input.dispatchKeyEvent`
 * on the tab's own debugger session (`EmbeddedComputerBrowser.sendHandoffInput`, the commands of
 * `@ryco/shared/nodeBrowserInputCdp`). The tab's `before-input-event` hook turns Cmd/Ctrl+W into
 * closing the tab and Cmd/Ctrl+R into a reload, and the app menu has its own shortcuts (quit, new
 * window, settings, find, zoom, devtools).
 *
 * Measured 2026-11-21 on Electron 44.7.0 (macOS): CDP key events reach the page only. Neither the
 * tab's hook nor an app-menu shortcut sees them. The control proves the hook is live: the same
 * chords through Electron's own input path (`webContents.sendInputEvent`) reload and close the
 * tab. This smoke sends the raw commands (`sendHandoffInput`, no filter) to watch exactly that.
 * Windows and Linux route unhandled keys to menu accelerators and are not verified, so remote
 * input drops app-level chords before this point anyway (`BrowserHandoffs`, `isAppLevelChord`).
 *
 * Run with `node apps/desktop/scripts/computer-use-smoke.mjs handoff-keys`.
 */
import { app, BrowserWindow, Menu, webContents } from "electron";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeNodeBrowserPressedState,
  nodeBrowserInputCommands,
} from "@ryco/shared/nodeBrowserInputCdp";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";

const directory = mkdtempSync(join(process.env.RYCO_SMOKE_TMP || tmpdir(), "ryco-handoff-keys-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => {
  console.error("FAIL: the hand-off keys smoke did not finish within 120 s.");
  app.exit(2);
}, 120_000);

/** Records every keydown, and a marker that changes on each load (a reload shows as a new one). */
const PAGE =
  "<title>Sign in</title><input id=user autofocus><script>window.marker=Math.random();window.keys=[];addEventListener('keydown',e=>keys.push((e.metaKey?'meta+':'')+(e.ctrlKey?'ctrl+':'')+(e.altKey?'alt+':'')+(e.shiftKey?'shift+':'')+e.key))</script>";
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(PAGE);
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (label: string) => console.log(`handoff keys smoke: ${label}`);

const COMMAND = process.platform === "darwin" ? 4 : 2;
const ALT = 1;
/** App-level chords: the tab's hook (W, R, L) and the menu's shortcuts. */
const CHORDS: ReadonlyArray<{ key: string; code: string; modifiers: number }> = [
  { key: "r", code: "KeyR", modifiers: COMMAND },
  { key: "w", code: "KeyW", modifiers: COMMAND },
  { key: "l", code: "KeyL", modifiers: COMMAND },
  { key: "q", code: "KeyQ", modifiers: COMMAND },
  { key: "n", code: "KeyN", modifiers: COMMAND },
  { key: "f", code: "KeyF", modifiers: COMMAND },
  { key: ",", code: "Comma", modifiers: COMMAND },
  { key: "=", code: "Equal", modifiers: COMMAND },
  { key: "i", code: "KeyI", modifiers: COMMAND | ALT },
];

async function main() {
  let exitCode = 0;
  let browser: EmbeddedComputerBrowser | undefined;
  let owner: BrowserWindow | undefined;
  try {
    await app.whenReady();
    const menuHits: string[] = [];
    const item = (label: string, accelerator: string) => ({
      label,
      accelerator,
      click: () => menuHits.push(label),
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: "App", submenu: [item("quit", "CmdOrCtrl+Q"), item("settings", "CmdOrCtrl+,")] },
        {
          label: "Window",
          submenu: [
            item("new window", "CmdOrCtrl+N"),
            item("find", "CmdOrCtrl+F"),
            item("zoom in", "CmdOrCtrl+="),
            item("devtools", "Alt+CmdOrCtrl+I"),
          ],
        },
      ]),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    owner = new BrowserWindow({ width: 1000, height: 760, show: false });
    await owner.loadURL("data:text/html,Ryco");
    browser = new EmbeddedComputerBrowser();
    const tab = await browser.open(
      `http://127.0.0.1:${address.port}/`,
      false,
      new AbortController().signal,
      "fixture-project",
    );
    browser.surface(
      { owner: "surface-a", tab: tab.id, x: 0, y: 0, width: 800, height: 600 },
      owner,
    );
    const guest = webContents.fromId(Number(tab.id));
    assert(guest);
    const focusRequests: string[] = [];
    browser.onFocusAddress((id) => focusRequests.push(id));
    const read = async () =>
      (await guest.executeJavaScript("({ marker: window.marker, keys: window.keys })")) as {
        marker: number;
        keys: string[];
      };
    const before = await read();

    // Remote input: exactly what a hand-off sends.
    const pressed = makeNodeBrowserPressedState();
    const viewport = browser.handoffViewport(tab.id);
    assert(viewport);
    for (const chord of CHORDS) {
      for (const action of ["down", "up"] as const) {
        await browser.sendHandoffInput(
          tab.id,
          nodeBrowserInputCommands({ type: "key", action, ...chord }, pressed, viewport),
        );
      }
      await delay(100);
    }
    await delay(500);
    const after = await read();
    assert(
      browser.state().tabs.some((entry) => entry.id === tab.id),
      "Cmd/Ctrl+W closed the tab",
    );
    assert.equal(after.marker, before.marker, "Cmd/Ctrl+R reloaded the tab");
    assert.deepEqual(focusRequests, [], "Cmd/Ctrl+L reached the tab's hook");
    assert.deepEqual(menuHits, [], "a remote chord reached an app-menu shortcut");
    assert.equal(after.keys.length, CHORDS.length, `the page saw ${after.keys.join(", ")}`);
    step(`remote chords reach the page only (${after.keys.join(", ")})`);
    browser.releaseHandoffInput(tab.id);

    // Control: Electron's own input path does reach the hook (reload, then close).
    const modifiers: Array<"meta" | "control"> = [
      process.platform === "darwin" ? "meta" : "control",
    ];
    guest.sendInputEvent({ type: "keyDown", keyCode: "R", modifiers });
    guest.sendInputEvent({ type: "keyUp", keyCode: "R", modifiers });
    for (let waited = 0; waited < 5_000; waited += 100) {
      await delay(100);
      const now = await read().catch(() => undefined);
      if (now && now.marker !== before.marker) break;
    }
    assert.notEqual((await read()).marker, before.marker, "control: Cmd/Ctrl+R did not reload");
    guest.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers });
    for (let waited = 0; waited < 5_000; waited += 100) {
      await delay(100);
      if (!browser.state().tabs.some((entry) => entry.id === tab.id)) break;
    }
    assert(
      !browser.state().tabs.some((entry) => entry.id === tab.id),
      "control: Cmd/Ctrl+W did not close the tab",
    );
    step("control: the same chords through sendInputEvent reload and close the tab");
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    browser?.dispose();
    owner?.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}

void main();
