import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("honors browser cancellation and does not auto-reconnect on the next alarm", async () => {
  let onDetach!: (source: { tabId: number }, reason: string) => void;
  let onAlarm!: () => void;
  const sockets: unknown[] = [];
  const remove = vi.fn(async () => {});
  const config = { url: "ws://127.0.0.1:1234/browser", browser: "chrome", token: "a".repeat(43) };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    close = vi.fn();
    send = vi.fn();
    addEventListener = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  runInNewContext(
    readFileSync(new URL("../../browser-extension/background.js", import.meta.url), "utf8"),
    {
      WebSocket: Socket,
      URL,
      chrome: {
        runtime: { onMessage: { addListener: vi.fn() } },
        debugger: {
          detach: vi.fn(async () => {}),
          onDetach: {
            addListener: (fn: typeof onDetach) => {
              onDetach = fn;
            },
          },
        },
        alarms: {
          create: vi.fn(),
          onAlarm: {
            addListener: (fn: typeof onAlarm) => {
              onAlarm = fn;
            },
          },
        },
        storage: { local: { get: async () => ({ config }), remove } },
      },
    },
  );
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  onDetach({ tabId: 1 }, "canceled_by_user");
  expect(remove).toHaveBeenCalledWith("config");
  onAlarm();
  await new Promise((resolve) => setImmediate(resolve));
  expect(sockets).toHaveLength(1);
});
