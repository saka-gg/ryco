import { ComputerNativeHelper } from "../src/computerUse/helper.ts";
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { EmbeddedComputerBrowser } from "../src/computerUse/embeddedBrowser.ts";
import { BrowserComputerDriver } from "../src/computerUse/browser.ts";
import { ComputerPolicyController, DEFAULT_COMPUTER_POLICY } from "../src/computerUse/policy.ts";

const directory = mkdtempSync(join(tmpdir(), "ryco-project-browser-"));
app.setPath("userData", directory);
app.on("window-all-closed", () => {});
const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(
    '<title>Shared project preview</title><style>body{font:20px system-ui;padding:40px;background:#f5f4ef}input,button{font:inherit;padding:10px}h1{font-size:32px}</style><h1>Project preview</h1><label>Name <input aria-label="Name" id="name"></label><button onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">Save</button><p id="result">Ready</p>',
  );
});
async function main() {
  let exitCode = 0;
  let browser: EmbeddedComputerBrowser | undefined;
  let owner: BrowserWindow | undefined;
  try {
    await app.whenReady();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    owner = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await owner.loadURL(
      "data:text/html;charset=utf-8,<style>body{background:%23232228;color:white;font:16px system-ui;padding:16px}</style>Ryco · Browser panel fixture",
    );
    browser = new EmbeddedComputerBrowser();
    const tab = await browser.open(
      `http://127.0.0.1:${address.port}`,
      false,
      new AbortController().signal,
      "fixture-project",
    );
    const surface = { owner: "surface-a", tab: tab.id, x: 350, y: 70, width: 600, height: 550 };
    browser.surface(surface, owner);
    assert.equal(browser.state().tabs[0]?.presentation, "panel");
    owner.showInactive();
    const driver = new BrowserComputerDriver(new Map([["ryco", browser]]));
    const policy = new ComputerPolicyController({
      policy: { ...DEFAULT_COMPUTER_POLICY, enabled: true },
      consent: async () => "once",
      persist: () => {},
      activity: () => {},
      cancel: () => driver.stop(),
    });
    const execute = (args: Record<string, unknown>) =>
      policy.execute(
        {
          sessionId: "session",
          threadId: "thread",
          turnId: "turn",
          tool: "browser",
          args: { ...args, tab: tab.id },
        },
        new AbortController().signal,
        (context) => driver.execute(context, "ryco"),
      );
    const decoded = (result: Awaited<ReturnType<typeof execute>>) =>
      JSON.parse((result.content[0] as { text: string }).text);
    const state = decoded(await execute({ action: "observe" }));
    const field = state.elements.find((element: { name: string }) => element.name === "Name");
    await execute({ action: "fill", ref: field.ref, text: "Same tab, same state" });
    browser.surface({ ...surface, owner: "surface-b", width: 390 }, owner);
    browser.surface({ ...surface, tab: null }, owner);
    assert.equal(
      browser.state().tabs[0]?.presentation,
      "panel",
      "Stale surface cleanup must not detach its replacement",
    );
    assert.throws(
      () => browser!.surface({ ...surface, width: 2000 }, owner!),
      /Invalid browser surface/,
    );
    owner.webContents.setZoomFactor(1.25);
    browser.surface(
      { ...surface, owner: "surface-b", x: 280, y: 56, width: 480, height: 440 },
      owner,
    );
    assert(
      owner.contentView.children.some((view) => {
        const bounds = view.getBounds();
        return bounds.x === 350 && bounds.y === 70 && bounds.width === 600 && bounds.height === 550;
      }),
      "App zoom must preserve native guest alignment",
    );
    owner.webContents.setZoomFactor(1);
    await browser.command({ action: "popout", tab: tab.id });
    assert.equal(browser.state().tabs[0]?.presentation, "window");
    const preview = BrowserWindow.getAllWindows().find((window) => window !== owner);
    assert(preview);
    const [previewWidth, previewHeight] = preview.getContentSize();
    assert(
      preview.contentView.children.some((view) => {
        const bounds = view.getBounds();
        return bounds.width === previewWidth && bounds.height === previewHeight;
      }),
      "The popped-out page must fill its preview window",
    );
    await browser.command({ action: "dock", tab: tab.id });
    browser.surface({ ...surface, owner: "surface-c" }, owner);
    const verify = (await browser.send(
      tab.id,
      "Runtime.evaluate",
      {
        expression:
          "({value:document.getElementById('name').value,bridge:typeof window.desktopBridge,node:typeof require})",
        returnByValue: true,
      },
      new AbortController().signal,
    )) as { result: { value: { value: string; bridge: string; node: string } } };
    assert.equal(verify.result.value.value, "Same tab, same state");
    assert.equal(verify.result.value.bridge, "undefined");
    assert.equal(verify.result.value.node, "undefined");
    await new Promise((resolve) => setTimeout(resolve, 200));
    owner.setTitle("Ryco project browser fixture");
    if (process.platform === "darwin") {
      const helper = new ComputerNativeHelper(
        join(process.cwd(), "apps/desktop/resources/ryco-computer-use-helper"),
        join(directory, "capture"),
      );
      try {
        const windows = (await helper.call("list_windows")) as Array<{
          id: number;
          app: string;
          pid: number;
          title: string;
        }>;
        const target = windows.find(
          (window) => window.pid === process.pid && window.title === "Ryco project browser fixture",
        );
        assert(target, "The docked fixture window must exist");
        const snapshot = (await helper.call("get_window_state", {
          window: { app: target.app, id: target.id },
          include_screenshot: true,
          include_text: false,
          max_dimension: 1400,
          format: "png",
        })) as { screenshots: Array<{ data: string }> };
        assert(snapshot.screenshots[0]?.data, "Native capture must include the fixture window");
        writeFileSync(
          join(tmpdir(), "ryco-project-browser-native.png"),
          Buffer.from(snapshot.screenshots[0].data, "base64"),
        );
      } finally {
        helper.stop();
      }
    }
    await owner.loadURL("data:text/html,Reloaded Ryco shell");
    assert.equal(
      browser.state().tabs[0]?.presentation,
      "background",
      "Reloading the shell must detach its guest",
    );
    await browser.close(tab.id, new AbortController().signal);
    assert.equal(browser.state().tabs.length, 0);
    console.log(
      "PASS: docked native page, shared agent input, surface fencing, bounds validation, popout/redock state, guest isolation, shell reload and tab cleanup.",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    browser?.dispose();
    owner?.destroy();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    app.exit(exitCode);
  }
}
void main();
