import { ipcMain, type BrowserWindow } from "electron";
import { ComputerBrowser } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { DESKTOP_COMPUTER_USE_IPC } from "../desktopIpcChannels.ts";
import type { DesktopComputerUseRuntime } from "./runtime.ts";

export function registerComputerUseIpc(
  runtime: DesktopComputerUseRuntime,
  getWindow: () => BrowserWindow | null,
): void {
  const handle = (channel: string, run: (input: unknown) => unknown) => {
    ipcMain.handle(channel, (event, input: unknown) => {
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
  handle(DESKTOP_COMPUTER_USE_IPC.betaHistory, (input) => runtime.beta.readHistory(input));
  handle(DESKTOP_COMPUTER_USE_IPC.betaState, () => runtime.beta.currentState());
  handle(DESKTOP_COMPUTER_USE_IPC.betaCheck, () => runtime.beta.check());
  handle(DESKTOP_COMPUTER_USE_IPC.betaSetup, () => runtime.beta.setup());
  handle(DESKTOP_COMPUTER_USE_IPC.betaTurnOn, () => runtime.beta.turnOn());
  handle(DESKTOP_COMPUTER_USE_IPC.betaSetupPermission, (input) => {
    if (input !== "accessibility" && input !== "screenRecording" && input !== "inputMonitoring")
      throw new Error("Unknown Computer permission.");
    return runtime.beta.setupPermission(input);
  });
  handle(DESKTOP_COMPUTER_USE_IPC.betaRevokeApp, (input) => runtime.beta.revokeApp(input));
  handle(DESKTOP_COMPUTER_USE_IPC.betaPreferences, (input) => runtime.beta.update(input));
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
  handle(DESKTOP_COMPUTER_USE_IPC.betaPrepare, (input) => {
    const value = threadInput(input);
    return runtime.beta.prepare(value.threadId, value.explicit);
  });
  handle(DESKTOP_COMPUTER_USE_IPC.betaPreview, (input) => {
    const value = threadInput(input);
    return runtime.beta.preview(value.threadId, value.visible);
  });
  handle(DESKTOP_COMPUTER_USE_IPC.betaStop, (input) =>
    runtime.beta.stopTask(threadInput(input).threadId),
  );
  handle(DESKTOP_COMPUTER_USE_IPC.state, () => runtime.state());
  handle(DESKTOP_COMPUTER_USE_IPC.checkPermissions, () => runtime.refreshPermissions());
  handle(DESKTOP_COMPUTER_USE_IPC.refresh, (input) => {
    if (input !== undefined && (typeof input !== "string" || input.length > 256))
      throw new Error("Invalid app search.");
    return runtime.refresh(input as string | undefined);
  });
  handle(DESKTOP_COMPUTER_USE_IPC.policy, (input) => runtime.update(input));
  handle(DESKTOP_COMPUTER_USE_IPC.permission, (input) => {
    if (input !== "accessibility" && input !== "screenRecording")
      throw new Error("Unknown native permission.");
    return runtime.permission(input);
  });
  handle(DESKTOP_COMPUTER_USE_IPC.pair, (input) =>
    runtime.pair(Schema.decodeUnknownSync(ComputerBrowser)(input)),
  );
  handle(DESKTOP_COMPUTER_USE_IPC.extension, () => runtime.showExtension());
  handle(DESKTOP_COMPUTER_USE_IPC.browserSetup, (input) =>
    runtime.openBrowserSetup(Schema.decodeUnknownSync(ComputerBrowser)(input)),
  );
  handle(DESKTOP_COMPUTER_USE_IPC.stop, () => runtime.stop());
}
