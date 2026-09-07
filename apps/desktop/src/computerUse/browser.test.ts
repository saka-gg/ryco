import { expect, it, vi } from "vitest";
import { BrowserComputerDriver, type BrowserTransport } from "./browser.ts";
import type { ComputerOperationContext } from "./policy.ts";

it("requires a new observation when a replacement browser reuses tab and document ids", async () => {
  const makeTransport = (): BrowserTransport => ({
    tabs: vi.fn(async () => [{ id: "1", url: "https://example.com/", title: "Test" }]),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async (_tab, method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame", loaderId: "doc" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      return { result: { value: {} } };
    }),
  });
  const transports = new Map<"chrome", BrowserTransport>([["chrome", makeTransport()]]);
  const driver = new BrowserComputerDriver(transports);
  const context: ComputerOperationContext = {
    request: {
      sessionId: "session",
      threadId: "thread",
      turnId: "turn",
      tool: "browser",
      args: { action: "observe", tab: "1" },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(),
    authorizeForeground: vi.fn(),
    claim: vi.fn(),
    activity: vi.fn(),
  };
  await driver.execute(context, "chrome");
  const replacement = makeTransport();
  transports.set("chrome", replacement);
  Object.assign(context.request.args, { action: "type", text: "Must not be typed" });
  await expect(driver.execute(context, "chrome")).rejects.toThrow("Observe this document");
  expect(replacement.send).not.toHaveBeenCalledWith(
    "1",
    "Input.insertText",
    expect.anything(),
    expect.anything(),
  );
});
