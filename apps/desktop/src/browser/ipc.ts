import { ipcMain, type BrowserWindow } from "electron";
import { Schema } from "effect";
import { ProjectBrowserCommand, ProjectBrowserSurface } from "@ryco/contracts";
import type { EmbeddedComputerBrowser } from "../computerUse/embeddedBrowser.ts";
import { record, textArg } from "../computerUse/native.ts";
import { ProjectSiteDiscovery } from "./discovery.ts";

export function registerProjectBrowserIpc(
  browser: EmbeddedComputerBrowser,
  getWindow: () => BrowserWindow | null,
): void {
  const discovery = new ProjectSiteDiscovery();
  const handle = (name: string, run: (input: unknown, window: BrowserWindow) => unknown) => {
    ipcMain.handle(`desktop:browser:${name}`, (event, input: unknown) => {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Browser controls are available only in the Ryco desktop window.");
      return run(input, window);
    });
  };
  browser.onFocusAddress((tab) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.focus();
      window.webContents.send("desktop:browser:focus-address", tab);
    }
  });
  browser.onState((state) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("desktop:browser:changed", state);
  });
  handle("state", () => browser.state());
  handle("open", async (input) => {
    const args = record(input);
    return (
      await browser.open(
        textArg(args, "url", 8192),
        false,
        AbortSignal.timeout(30_000),
        textArg(args, "project", 8192),
      )
    ).id;
  });
  handle("command", (input) =>
    browser.command(Schema.decodeUnknownSync(ProjectBrowserCommand)(input)),
  );
  handle("surface", (input, window) =>
    browser.surface(Schema.decodeUnknownSync(ProjectBrowserSurface)(input), window),
  );
  handle("capture", (input) => browser.capture(textArg({ tab: input }, "tab")));
  handle("discover", (input) =>
    discovery.discover(input === undefined ? undefined : textArg({ cwd: input }, "cwd", 8192)),
  );
}
