import { expect, it, vi } from "vitest";
import { NativeComputerDriver } from "./native.ts";
import type { ComputerNativeHelper } from "./helper.ts";
import type { ComputerOperationContext } from "./policy.ts";

const window = {
  id: 41,
  app: "/Applications/Test.app",
  pid: 1234,
  x: 20,
  y: 30,
  width: 600,
  height: 400,
};
function fixture() {
  const call = vi.fn(async (action: string): Promise<unknown> => {
    if (action === "list_apps") return [{ id: window.app, displayName: "Test" }];
    if (action === "list_windows") return [window];
    if (action === "hello") return { screenLocked: false, protocolVersion: 3 };
    return { ok: true };
  });
  const driver = new NativeComputerDriver(
    { call, stop: vi.fn() } as unknown as ComputerNativeHelper,
    "/Applications/Ryco.app",
  );
  const context: ComputerOperationContext = {
    request: {
      sessionId: "session",
      threadId: "thread",
      turnId: "turn",
      tool: "computer",
      args: { action: "windows", app: window.app },
    },
    signal: new AbortController().signal,
    check: vi.fn(),
    authorizeApp: vi.fn(async () => {}),
    authorizeForeground: vi.fn(async () => {}),
    claim: vi.fn(),
    activity: vi.fn(async () => {}),
  };
  return { call, driver, context };
}
it("rejects an unobserved window even if the agent supplies a plausible id", async () => {
  const { driver, context } = fixture();
  Object.assign(context.request.args, {
    action: "click",
    app: window.app,
    window: 41,
    x: 10,
    y: 10,
  });
  await expect(driver.execute(context)).rejects.toThrow("not observed");
});
it("rejects window id reuse by another process", async () => {
  const { call, driver, context } = fixture();
  await driver.execute(context);
  call.mockImplementation(async (action) =>
    action === "list_windows"
      ? [{ ...window, pid: 999 }]
      : { screenLocked: false, protocolVersion: 3 },
  );
  Object.assign(context.request.args, {
    action: "click",
    app: window.app,
    window: 41,
    x: 10,
    y: 10,
  });
  await expect(driver.execute(context)).rejects.toThrow("identity changed");
  expect(call.mock.calls.some(([action]) => action === "click")).toBe(false);
});
it("rejects points outside the verified target frame", async () => {
  const { driver, context } = fixture();
  await driver.execute(context);
  Object.assign(context.request.args, {
    action: "click",
    app: window.app,
    window: 41,
    x: 601,
    y: 10,
  });
  await expect(driver.execute(context)).rejects.toThrow("Invalid x");
});
it("preserves background mode and publishes the target in screen coordinates", async () => {
  const { call, driver, context } = fixture();
  await driver.execute(context);
  Object.assign(context.request.args, {
    action: "click",
    app: window.app,
    window: 41,
    x: 10,
    y: 15,
  });
  await driver.execute(context);
  expect(call).toHaveBeenLastCalledWith(
    "click",
    expect.objectContaining({ mode: "background", x: 10, y: 15 }),
    context.signal,
  );
  expect(context.activity).toHaveBeenLastCalledWith(
    expect.objectContaining({ x: 30, y: 45, mode: "background" }),
  );
  expect(context.authorizeForeground).not.toHaveBeenCalled();
});
