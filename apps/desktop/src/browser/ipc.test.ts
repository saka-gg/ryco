import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { EmbeddedComputerBrowser } from "../computerUse/embeddedBrowser.ts";
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, input?: unknown) => unknown) =>
      handlers.set(name, fn),
  },
}));
import { registerProjectBrowserIpc } from "./ipc.ts";
it("denies guest webContents and subframes access to manual browser control", () => {
  const frame = {},
    contents = { mainFrame: frame };
  const state = vi.fn(() => ({ tabs: [] }));
  const browser = {
    state,
    onState: vi.fn(),
    onFocusAddress: vi.fn(),
  } as unknown as EmbeddedComputerBrowser;
  registerProjectBrowserIpc(
    browser,
    () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow,
  );
  const handler = handlers.get("desktop:browser:state")!;
  expect(() => handler({ sender: {}, senderFrame: frame })).toThrow("only in the Ryco");
  expect(() => handler({ sender: contents, senderFrame: {} })).toThrow("only in the Ryco");
  expect(state).not.toHaveBeenCalled();
  expect(handler({ sender: contents, senderFrame: frame })).toEqual({ tabs: [] });
});

it("keeps sign-in authorization behind the trusted shell main frame", () => {
  const frame = {},
    contents = { mainFrame: frame };
  const command = vi.fn();
  registerProjectBrowserIpc(
    { command, onState: vi.fn(), onFocusAddress: vi.fn() } as unknown as EmbeddedComputerBrowser,
    () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow,
  );
  const handler = handlers.get("desktop:browser:command")!;
  const input = { action: "allow-sign-in", tab: "fixture" };
  expect(() => handler({ sender: {}, senderFrame: frame }, input)).toThrow("only in the Ryco");
  expect(() => handler({ sender: contents, senderFrame: {} }, input)).toThrow("only in the Ryco");
  expect(command).not.toHaveBeenCalled();
  handler({ sender: contents, senderFrame: frame }, input);
  expect(command).toHaveBeenCalledWith(input);
});

it("lets only the trusted shell main frame start an element pick", async () => {
  const frame = {},
    contents = { mainFrame: frame };
  const pick = vi.fn(async (tab: string) => ({ kind: "cancelled", reason: "user", tab }));
  registerProjectBrowserIpc(
    { pick, onState: vi.fn(), onFocusAddress: vi.fn() } as unknown as EmbeddedComputerBrowser,
    () => ({ isDestroyed: () => false, webContents: contents }) as unknown as BrowserWindow,
  );
  const handler = handlers.get("desktop:browser:pick")!;
  expect(() => handler({ sender: {}, senderFrame: frame }, "tab-1")).toThrow("only in the Ryco");
  expect(() => handler({ sender: contents, senderFrame: {} }, "tab-1")).toThrow("only in the Ryco");
  expect(pick).not.toHaveBeenCalled();
  expect(() => handler({ sender: contents, senderFrame: frame }, { tab: "tab-1" })).toThrow(
    "Invalid tab.",
  );
  await expect(handler({ sender: contents, senderFrame: frame }, "tab-1")).resolves.toEqual({
    kind: "cancelled",
    reason: "user",
    tab: "tab-1",
  });
  expect(pick).toHaveBeenCalledWith("tab-1");
});
