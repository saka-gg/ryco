import { ipcMain, type BrowserWindow } from "electron";
import { ComputerBrowser } from "@ryco/contracts";
import { Schema } from "effect";
import type { DesktopComputerUseRuntime } from "./runtime.ts";

export function registerComputerUseIpc(
  runtime: DesktopComputerUseRuntime,
  getWindow: () => BrowserWindow | null,
): void {
  const handle = (name: string, run: (input: unknown) => unknown) => {
    ipcMain.handle(`desktop:computer-use:${name}`, (event, input: unknown) => {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Computer-use settings are available only in the Ryco desktop window.");
      return run(input);
    });
  };
  handle("state", () => runtime.refreshPermissions());
  handle("refresh", (input) => {
    if (input !== undefined && (typeof input !== "string" || input.length > 256))
      throw new Error("Invalid app search.");
    return runtime.refresh(input as string | undefined);
  });
  handle("policy", (input) => runtime.update(input));
  handle("permission", (input) => {
    if (input !== "accessibility" && input !== "screenRecording")
      throw new Error("Unknown native permission.");
    return runtime.permission(input);
  });
  handle("pair", (input) => runtime.pair(Schema.decodeUnknownSync(ComputerBrowser)(input)));
  handle("extension", () => runtime.showExtension());
  handle("browser-setup", (input) =>
    runtime.openBrowserSetup(Schema.decodeUnknownSync(ComputerBrowser)(input)),
  );
  handle("stop", () => runtime.stop());
}
