import { app, BrowserWindow, session, webContents } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";

// Never reads an installed browser profile or contacts a real identity provider.
const directory = mkdtempSync(join(tmpdir(), "ryco-sign-in-fixture-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
let origin = "";
let provider = "";
let posted = "";
const serve: import("node:http").RequestListener = (request, response) => {
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/download") {
    response.writeHead(200, {
      "Content-Disposition": "attachment; filename=fixture.txt",
      "Content-Type": "application/octet-stream",
    });
    response.end("disposable fixture");
    return;
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { Location: `${provider}/provider` });
    response.end();
    return;
  }
  if (request.url === "/post") {
    request.setEncoding("utf8");
    request.on("data", (data: string) => {
      posted += data;
    });
    request.on("end", () => {
      response.writeHead(302, { Location: `${provider}/provider` });
      response.end();
    });
    return;
  }
  if (request.url === "/provider") {
    response.end(
      `<title>Fake identity provider</title><button id="finish" onclick="location.href='${origin}/callback'">Complete fixture sign-in</button>`,
    );
    return;
  }
  if (request.url === "/callback") {
    response.setHeader("Set-Cookie", "fixture-sign-in=complete; SameSite=Lax; Path=/");
    response.end(
      `<script>opener.postMessage('fixture-complete', ${JSON.stringify(origin)}); window.close()</script>`,
    );
    return;
  }
  response.end(`<title>Disposable sign-in fixture</title><script>
    window.result = '';
    addEventListener('message', event => { if (event.origin === location.origin) window.result = event.data });
    window.start = () => window.lastPopup = window.open('${provider}/redirect', 'signin', 'width=500,height=600,nodeIntegration=yes,contextIsolation=no');
    window.blank = () => { const child = window.open('about:blank', 'signin'); if (child) child.location = '${provider}/redirect'; return !!child; };
    </script><form method="post" target="signin" action="${provider}/post"><input name="fixture" value="disposable"><button>Sign in</button></form>`);
};
const server = createServer(serve);
const providerServer = createServer(serve);
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > 5_000) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function main() {
  const watchdog = setTimeout(() => {
    console.error("Sign-in fixture timed out");
    app.exit(1);
  }, 60_000);
  let code = 0;
  let browser: EmbeddedComputerBrowser | undefined;
  let owner: BrowserWindow | undefined;
  try {
    await app.whenReady();
    origin = await listen(server);
    provider = await listen(providerServer);
    owner = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await owner.loadURL("data:text/html,Ryco disposable shell fixture");
    browser = new EmbeddedComputerBrowser();
    const signal = new AbortController().signal;
    const tab = await browser.open(origin, false, signal, "fixture");
    const guest = webContents.fromId(Number(tab.id));
    assert(guest);
    const surface = { owner: "fixture", tab: tab.id, x: 0, y: 50, width: 800, height: 600 };
    browser.surface(surface, owner);
    const baseWindows = new Set(BrowserWindow.getAllWindows());
    const currentPopup = () =>
      BrowserWindow.getAllWindows().find((window) => !baseWindows.has(window));
    const focus = async () => {
      owner!.show();
      owner!.focus();
      await until(() => owner!.isFocused(), "fixture focus");
    };
    const arm = async () => {
      await focus();
      await browser!.command({ action: "allow-sign-in", tab: tab.id });
    };
    const open = async (expression = "window.start(); true") => {
      await arm();
      await guest.executeJavaScript(expression);
      await until(() => Boolean(currentPopup()?.isVisible()), "popup visibility");
      const popup = currentPopup();
      assert(popup);
      await until(
        () =>
          popup.webContents.getURL() === `${provider}/provider` && !popup.webContents.isLoading(),
        "provider redirect",
      );
      return popup;
    };
    assert.equal(
      await guest.executeJavaScript("window.start() === null"),
      true,
      "Unarmed popup denied",
    );
    assert(!currentPopup());
    await arm();
    assert.equal(
      await guest.executeJavaScript("window.open('file:///tmp/fixture') === null"),
      true,
    );
    assert(!currentPopup());
    for (const expression of [
      "window.start(); true",
      "window.blank()",
      "document.querySelector('form').submit(); true",
    ]) {
      const popup = await open(expression);
      assert(owner.isFocused(), "Opening must not steal foreground focus");
      assert.equal(popup.webContents.session, guest.session);
      assert.notEqual(popup.webContents.session, session.defaultSession);
      // Pinned Electron exposes this diagnostic at runtime, but omits it from public typings.
      // Production popup handling uses only public APIs.
      const preferences = (
        popup.webContents as typeof popup.webContents & {
          getLastWebPreferences(): Electron.WebPreferences;
        }
      ).getLastWebPreferences();
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert(!preferences.preload);
      assert.equal(
        await popup.webContents.executeJavaScript(
          "typeof require + ':' + typeof window.desktopBridge",
        ),
        "undefined:undefined",
      );
      assert.equal(
        await popup.webContents.executeJavaScript(
          "window.open('https://example.invalid') === null",
        ),
        true,
      );
      assert.equal(
        await popup.webContents.executeJavaScript(
          "navigator.permissions.query({name:'geolocation'}).then(p => p.state)",
        ),
        "denied",
      );
      let blockedDownload = false;
      const download = (event: Electron.Event) => {
        blockedDownload = event.defaultPrevented;
      };
      guest.session.once("will-download", download);
      await popup.webContents.executeJavaScript(
        `location.href = ${JSON.stringify(origin + "/download")}; true`,
      );
      await until(() => blockedDownload, "profile blocks download");
      popup.focus();
      await until(() => popup.isFocused(), "user focuses sign-in");
      assert.equal(
        browser.state().tabs[0]?.signInPopup,
        "open",
        "Popup stays usable after opener loses focus",
      );
      await assert.rejects(
        browser.send(tab.id, "Runtime.evaluate", { expression: "1" }, signal),
        /Finish or close/,
      );
      await guest.executeJavaScript("window.result = ''");
      await popup.webContents
        .executeJavaScript("document.getElementById('finish').click(); true")
        .catch(() => {});
      await until(
        async () => await guest.executeJavaScript("window.result === 'fixture-complete'"),
        "opener callback",
      );
      await until(() => !currentPopup(), "self-close");
      assert.equal(browser.state().tabs[0]?.signInPopup, "idle");
    }
    assert.equal(posted, "fixture=disposable", "Native popup keeps form POST body");
    assert.equal(
      (await guest.session.cookies.get({ url: origin, name: "fixture-sign-in" }))[0]?.value,
      "complete",
    );
    assert.equal((await session.defaultSession.cookies.get({ url: origin })).length, 0);
    for (const close of [
      () => browser!.surface({ ...surface, tab: null }, owner!),
      () => browser!.surface({ ...surface, owner: "replacement" }, owner!),
      () => browser!.command({ action: "popout", tab: tab.id }),
      () => guest.loadURL(origin),
      () => owner!.loadURL("data:text/html,Restarted disposable shell"),
      () => browser!.stop(),
    ]) {
      await browser.command({ action: "dock", tab: tab.id });
      browser.surface(surface, owner);
      const popup = await open();
      await close();
      await until(() => popup.isDestroyed(), "lifecycle close");
      assert.equal(browser.state().tabs[0]?.signInPopup, "idle");
      await until(
        async () => await guest.executeJavaScript("!window.lastPopup || window.lastPopup.closed"),
        "opener sees closed popup",
      );
    }
    browser.surface(surface, owner);
    const other = await browser.open(origin, false, signal, "fixture");
    for (const window of BrowserWindow.getAllWindows()) baseWindows.add(window);
    const switching = await open();
    browser.surface({ ...surface, tab: other.id }, owner);
    await until(() => switching.isDestroyed(), "tab switch cleanup");
    await browser.close(other.id, signal);
    browser.surface(surface, owner);
    // Local refusal exercises a real initial load failure without contacting the internet.
    await arm();
    await guest.executeJavaScript("window.open('http://127.0.0.1:1', 'failed'); true");
    await until(() => browser!.state().tabs[0]?.signInPopup === "failed", "load failure cleanup");
    const failed = await open();
    failed.webContents.forcefullyCrashRenderer();
    await until(() => failed.isDestroyed(), "renderer failure cleanup");
    assert.equal(browser.state().tabs[0]?.signInPopup, "failed");
    // Electron may place same-site opener/child in one renderer process.
    // Reload the fixture opener as the UI recovery action after a forced crash.
    await guest.loadURL(origin);
    const closing = await open();
    await browser.close(tab.id, signal);
    await until(() => closing.isDestroyed(), "opener tab close");
    const next = await browser.open(origin, false, signal, "fixture");
    for (const window of BrowserWindow.getAllWindows()) baseWindows.add(window);
    const nextGuest = webContents.fromId(Number(next.id));
    assert(nextGuest);
    assert.equal(
      (await nextGuest.session.cookies.get({ url: origin, name: "fixture-sign-in" }))[0]?.value,
      "complete",
    );
    browser.surface({ ...surface, tab: next.id }, owner);
    await focus();
    await browser.command({ action: "allow-sign-in", tab: next.id });
    await nextGuest.executeJavaScript("window.start(); true");
    await until(() => Boolean(currentPopup()), "shutdown popup");
    const shutdownPopup = currentPopup()!;
    browser.dispose();
    await until(() => shutdownPopup.isDestroyed(), "desktop shutdown");
    browser = new EmbeddedComputerBrowser();
    assert.equal(browser.state().tabs.length, 0, "Restart must not restore popup grants");
    console.log(
      "PASS: explicit consent, unsafe denial, redirect/opener callback, blank navigation, POST, sandbox/profile isolation, permission/download denial, load failure, tab switching, no focus theft, human focus, agent exclusion, surface/popout/navigation/reload/stop/crash/tab-close/shutdown cleanup.",
    );
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    clearTimeout(watchdog);
    browser?.dispose();
    owner?.destroy();
    for (const instance of [server, providerServer]) {
      instance.closeAllConnections();
      instance.close();
    }
    rmSync(directory, { recursive: true, force: true });
    app.exit(code);
  }
}
void main();
