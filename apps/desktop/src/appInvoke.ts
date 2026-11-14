import { BrowserWindow, ipcMain, type IpcMain, type IpcMainInvokeEvent } from "electron";

/** The one error a renderer gets from a channel it may not call. */
export const INVALID_APP_SENDER_MESSAGE = "Invalid sender.";

/** Electron's own invoke listener type: renderer arguments arrive untyped. */
export type AppInvokeHandler = Parameters<IpcMain["handle"]>[1];

export interface AppInvokeOptions {
  /**
   * Only the main frame of a Ryco window's document may call the channel.
   * The preload is attached only to the main window with context isolation
   * and the sandbox on, so subframes and other windows never reach a channel;
   * this is defense in depth. `false` keeps a channel unchecked, as it was.
   */
  readonly requireMainFrame: boolean;
}

/** Whether an invoke came from the main frame of a Ryco window's document. */
export function isAppMainFrameSender(event: IpcMainInvokeEvent): boolean {
  return (
    BrowserWindow.fromWebContents(event.sender) !== null &&
    event.senderFrame === event.sender.mainFrame
  );
}

/** The Ryco window that sent an invoke; throws for a sender without one. */
export function appSenderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error(INVALID_APP_SENDER_MESSAGE);
  return owner;
}

/**
 * Register a renderer invoke channel, replacing any earlier handler for it,
 * with the sender check every guarded channel shares.
 */
export function handleAppInvoke(
  channel: string,
  run: AppInvokeHandler,
  options: AppInvokeOptions,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (event, ...args) => {
    if (options.requireMainFrame && !isAppMainFrameSender(event)) {
      throw new Error(INVALID_APP_SENDER_MESSAGE);
    }
    return run(event, ...args);
  });
}
