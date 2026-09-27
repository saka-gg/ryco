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
  handle("beta-history", (input) => runtime.beta.readHistory(input));
  handle("beta-state", () => runtime.beta.state());
  handle("beta-check", () => runtime.beta.check());
  handle("beta-setup", () => runtime.beta.setup());
  handle("beta-preferences", (input) => runtime.beta.update(input));
  const threadInput = (input: unknown) => {
    const value = input as { threadId?: unknown; explicit?: unknown; visible?: unknown };
    if (
      !value ||
      typeof value.threadId !== "string" ||
      !value.threadId.length ||
      value.threadId.length > 256
    )
      throw new Error("Invalid Computer thread.");
    return {
      threadId: value.threadId,
      explicit: value.explicit === true,
      visible: value.visible === true,
    };
  };
  handle("beta-prepare", (input) => {
    const value = threadInput(input);
    return runtime.beta.prepare(value.threadId, value.explicit);
  });
  handle("beta-preview", (input) => {
    const value = threadInput(input);
    return runtime.beta.preview(value.threadId, value.visible);
  });
  handle("beta-stop", (input) => runtime.beta.stopTask(threadInput(input).threadId));
  handle("state", () => runtime.state());
  handle("check-permissions", () => runtime.refreshPermissions());
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
