import { app, BrowserWindow, screen } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { DesktopComputerUseRuntime } from "../src/computerUse/runtime.ts";
import { ComputerUseOverlay } from "../src/computerUse/overlay.ts";

// Run the bundled script with Electron from the repository root. Only temporary
// profiles and a disposable local page are used; no personal browser is opened.
const directory = mkdtempSync(join(tmpdir(), "ryco-computer-integration-"));
app.setPath("userData", join(directory, "electron"));
app.on("window-all-closed", () => {});
async function main() {
  let exitCode = 0;
  let runtime: DesktopComputerUseRuntime | undefined;
  let overlay: ComputerUseOverlay | undefined;
  let closeBrowser: (() => Promise<void>) | undefined;
  const fixture = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<title>Ryco extension fixture</title><label>Name <input aria-label="Name" id="sample"></label><button onclick="document.getElementById(\'result\').textContent=\'Saved \'+document.getElementById(\'sample\').value">Save sample</button><p id="result">Waiting</p>',
    );
  });
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert(address && typeof address !== "string");
    const desktop = join(process.cwd(), "apps/desktop");
    runtime = new DesktopComputerUseRuntime({
      stateDir: directory,
      helperPath: join(desktop, "resources/ryco-computer-use-helper"),
      extensionPath: join(desktop, "browser-extension"),
      getWindow: () => null,
      changed: () => {},
    });
    await runtime.start();
    const permissionState = await runtime.refreshPermissions();
    assert(
      permissionState.permissionInfo?.checkedAt,
      "Permission check must run before publishing its result",
    );
    if (process.platform === "darwin") {
      assert(permissionState.helperAvailable);
      assert(["granted", "denied"].includes(permissionState.accessibility));
      assert(["granted", "denied"].includes(permissionState.screenRecording));
    }
    const binding = runtime.backendBinding();
    const request = {
      sessionId: "smoke",
      threadId: "thread",
      turnId: "turn",
      tool: "browser",
      args: { action: "tabs", browser: "chrome" },
    };
    const call = async (args: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const response = await fetch(binding.url, {
        method: "POST",
        headers: { authorization: `Bearer ${binding.token}`, ...headers },
        body: JSON.stringify({ ...request, args: { browser: "chrome", ...args } }),
      });
      return response;
    };
    assert.equal((await call({ action: "tabs" }, { origin: "https://example.com" })).status, 403);
    assert.equal((await call({ action: "tabs" }, { authorization: "Bearer invalid" })).status, 403);
    assert.equal((await (await call({ action: "tabs" })).json()).isError, true);
    runtime.update({
      enabled: true,
      foregroundEnabled: false,
      apps: { "browser:chrome": "allow" },
      browsers: ["chrome"],
    });
    request.turnId = "enabled-turn";
    // A malformed client frame before authentication must not crash Electron.
    await new Promise<void>((resolve, reject) => {
      const malformed = new WebSocket(
        binding.url.replace("http:", "ws:").replace("/control", "/browser"),
        {
          origin: `chrome-extension://${"a".repeat(32)}`,
        },
      );
      const timeout = setTimeout(() => {
        malformed.terminate();
        reject(new Error("Malformed socket was not closed"));
      }, 5000);
      malformed.on("error", () => {});
      malformed.on("open", () => malformed.send("unmasked", { mask: false }));
      malformed.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    assert.equal((await call({ action: "tabs" })).status, 200);
    const pairing = runtime.pair("chrome");
    const { chromium } = await import(
      pathToFileURL(join(process.cwd(), "apps/web/node_modules/playwright/index.mjs")).href
    );
    const extension = join(desktop, "browser-extension");
    const browser = await chromium.launchPersistentContext(join(directory, "chromium"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    closeBrowser = () => browser.close();
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#pairing").fill(JSON.stringify(pairing));
    await popup.locator("#connect").click();
    for (let attempt = 0; !runtime.state().connectedBrowsers.includes("chrome"); attempt++) {
      assert(attempt < 100, "Extension must authenticate");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await popup.waitForFunction(
      () => document.getElementById("status")?.textContent === "Connected to Ryco",
    );
    const execute = async (args: Record<string, unknown>) => {
      const value = await (await call(args)).json();
      assert(!value.isError, JSON.stringify(value));
      return JSON.parse(value.content[0].text);
    };
    const tab = (
      await execute({ action: "open", url: `http://127.0.0.1:${address.port}`, visible: false })
    ).id;
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        state = await execute({ action: "observe", tab });
        if (state.elements.length) break;
      } catch {
        /* Tab is still loading. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(state?.elements.length);
    const field = state.elements.find((entry: { name: string }) => entry.name === "Name");
    const button = state.elements.find((entry: { name: string }) => entry.name === "Save sample");
    await execute({ action: "fill", tab, ref: field.ref, text: "Ada" });
    await execute({ action: "click", tab, ref: button.ref });
    assert.match((await execute({ action: "observe", tab })).text, /Saved Ada/);
    runtime.stop();
    assert.equal((await (await call({ action: "tabs" })).json()).isError, true);
    const rotated = runtime.backendBinding();
    assert.notEqual(rotated.token, binding.token);
    assert.equal((await call({ action: "tabs" })).status, 403);

    overlay = new ComputerUseOverlay(
      () => {},
      () => {},
    );
    const pointer = screen.getCursorScreenPoint();
    const focus = BrowserWindow.getFocusedWindow();
    for (const x of [100, 250, 400])
      await overlay.show({
        threadId: "smoke",
        target: "Disposable fixture",
        mode: "background",
        action: "click",
        x,
        y: 180,
      });
    assert.deepEqual(
      screen.getCursorScreenPoint(),
      pointer,
      "Agent overlay must not move the physical cursor",
    );
    assert.equal(BrowserWindow.getFocusedWindow(), focus, "Agent overlay must not steal focus");
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === "Ryco Computer Use Overlay",
    );
    assert(window?.isVisible());
    const transform = await window.webContents.executeJavaScript(
      "document.getElementById('cursor').style.transform",
    );
    assert.match(transform, /400px/);
    await overlay.show(null);
    assert.equal(window.isVisible(), false);
    console.log(
      "PASS: real MV3 extension pairing, private HTTP authentication, Chromium background form control, revocation/token rotation, and repeated native cursor overlay without focus or pointer takeover.",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    overlay?.dispose();
    runtime?.dispose();
    await closeBrowser?.();
    fixture.closeAllConnections();
    fixture.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
