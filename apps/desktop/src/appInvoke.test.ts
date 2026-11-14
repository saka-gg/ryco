import { expect, it, vi } from "vitest";

const { handlers, removed, windows } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  removed: [] as string[],
  windows: new Set<unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (channel: string) => {
      removed.push(channel);
      handlers.delete(channel);
    },
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
  BrowserWindow: {
    fromWebContents: (contents: unknown) => (windows.has(contents) ? { contents } : null),
  },
}));
import { handleAppInvoke, INVALID_APP_SENDER_MESSAGE } from "./appInvoke.ts";

const frame = {};
const appContents = { mainFrame: frame };
windows.add(appContents);

it("replaces an earlier handler for the channel", () => {
  handleAppInvoke("desktop:test-replace", () => "first", { requireMainFrame: false });
  handleAppInvoke("desktop:test-replace", () => "second", { requireMainFrame: false });
  expect(removed.filter((channel) => channel === "desktop:test-replace")).toHaveLength(2);
  expect(handlers.get("desktop:test-replace")!({ sender: {}, senderFrame: {} })).toBe("second");
});

it("lets only a Ryco window's main frame call a guarded channel", () => {
  const run = vi.fn((_event: unknown, value: unknown) => value);
  handleAppInvoke("desktop:test-guarded", run, { requireMainFrame: true });
  const handler = handlers.get("desktop:test-guarded")!;
  expect(() => handler({ sender: {}, senderFrame: frame }, 1)).toThrow(INVALID_APP_SENDER_MESSAGE);
  expect(() => handler({ sender: appContents, senderFrame: {} }, 1)).toThrow(
    INVALID_APP_SENDER_MESSAGE,
  );
  expect(run).not.toHaveBeenCalled();
  expect(handler({ sender: appContents, senderFrame: frame }, 1)).toBe(1);
});

it("leaves an unguarded channel unchecked", () => {
  handleAppInvoke("desktop:test-unguarded", (_event, value) => value, {
    requireMainFrame: false,
  });
  expect(handlers.get("desktop:test-unguarded")!({ sender: {}, senderFrame: {} }, 2)).toBe(2);
});
