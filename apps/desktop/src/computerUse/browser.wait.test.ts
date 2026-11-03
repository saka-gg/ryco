// `wait` cases that need fake timers; browser.test.ts runs in the pure project, which allows none.
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { BrowserComputerDriver, type BrowserTransport } from "./browser.ts";
import type { ComputerOperationContext } from "./policy.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function fixture(state: Record<string, unknown>) {
  const controller = new AbortController();
  let stopped = false;
  const transport: BrowserTransport = {
    tabs: vi.fn(async () => [{ id: "1", url: "https://example.com/", title: "Test" }]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async (_tab: string, method: string) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "f", loaderId: "doc" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { value: state } };
    }),
  };
  const context: ComputerOperationContext = {
    request: { sessionId: "s", threadId: "t", turnId: "u", tool: "browser", args: {} },
    signal: controller.signal,
    check: vi.fn(() => {
      if (stopped) throw new Error("Computer use stopped. Start a new turn to resume.");
    }),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  const driver = new BrowserComputerDriver(new Map([["chrome", transport]]));
  const run = (args: Record<string, unknown>) =>
    driver.execute(
      { ...context, request: { ...context.request, args: { tab: "1", ...args } } },
      "chrome",
    );
  const stop = () => {
    stopped = true;
    controller.abort();
  };
  return { run, transport, stop };
}

it("times out after the given timeout and names what it still waits for", async () => {
  const { run, transport } = fixture({
    selector: true,
    text: false,
    url: "https://example.com/",
    title: "T",
    readyState: "interactive",
  });
  const waiting = run({
    action: "wait",
    selector: "#a",
    text: "Saved",
    idle: "load",
    timeout: 1_000,
  });
  const failed = expect(waiting).rejects.toThrow(
    "Wait timed out after 1000 ms; still waiting for the text to appear, the page to load.",
  );
  await vi.advanceTimersByTimeAsync(999);
  const polls = vi
    .mocked(transport.send)
    .mock.calls.filter(([, method]) => method === "Runtime.evaluate");
  expect(polls.length).toBeGreaterThanOrEqual(9);
  await vi.advanceTimersByTimeAsync(1);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it("inverts selector and text with gone", async () => {
  const { run } = fixture({
    selector: true,
    text: null,
    url: "u",
    title: "t",
    readyState: "complete",
  });
  const waiting = run({ action: "wait", selector: "#spinner", gone: true, timeout: 300 });
  const failed = expect(waiting).rejects.toThrow("still waiting for the selector to disappear.");
  await vi.advanceTimersByTimeAsync(300);
  await failed;
});

it("stops polling at once when the operation is stopped", async () => {
  const { run, stop } = fixture({
    selector: false,
    text: null,
    url: "u",
    title: "t",
    readyState: "complete",
  });
  const waiting = run({ action: "wait", selector: "#never", timeout: 30_000 });
  const failed = expect(waiting).rejects.toThrow("Computer use stopped.");
  await vi.advanceTimersByTimeAsync(250);
  stop();
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});
