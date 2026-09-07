import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { DesktopComputerUseRuntime } from "./runtime.ts";
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, input?: unknown) => unknown) =>
      handlers.set(name, handler),
  },
}));
import { registerComputerUseIpc } from "./ipc.ts";

it("admits only the exact main window and main frame for local policy changes", () => {
  const frame = {};
  const contents = { mainFrame: frame };
  const update = vi.fn();
  registerComputerUseIpc(
    { update } as unknown as DesktopComputerUseRuntime,
    () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow,
  );
  const handler = handlers.get("desktop:computer-use:policy")!;
  expect(() => handler({ sender: {}, senderFrame: frame }, {})).toThrow("only in the Ryco");
  expect(() => handler({ sender: contents, senderFrame: {} }, {})).toThrow("only in the Ryco");
  expect(update).not.toHaveBeenCalled();
  handler({ sender: contents, senderFrame: frame }, { enabled: false });
  expect(update).toHaveBeenCalledWith({ enabled: false });
});

it("reads fresh permissions instead of the initial cached unknown state", async () => {
  const frame = {};
  const contents = { mainFrame: frame };
  const refreshPermissions = vi.fn(async () => ({ accessibility: "granted" }));
  registerComputerUseIpc(
    { refreshPermissions } as unknown as DesktopComputerUseRuntime,
    () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow,
  );
  await expect(
    handlers.get("desktop:computer-use:state")!({ sender: contents, senderFrame: frame }),
  ).resolves.toEqual({ accessibility: "granted" });
  expect(refreshPermissions).toHaveBeenCalledOnce();
});
