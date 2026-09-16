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

it("delivers native pixels separately from metadata when the accessibility tree is unavailable", async () => {
  const { call, driver, context } = fixture();
  await driver.execute(context);
  const fallback = call.getMockImplementation()!;
  call.mockImplementation(async (action) =>
    action === "get_window_state"
      ? {
          accessibility: null,
          notes: ["accessibility_unavailable: no AX window"],
          screenshots: [
            { mimeType: "image/png", data: "cGl4ZWxz", width: 800, height: 1600, scale: 2 },
          ],
        }
      : fallback(action),
  );
  Object.assign(context.request.args, { action: "observe", window: 41 });
  const observed = await driver.execute(context);
  expect(observed.isError).toBeUndefined();
  expect(observed.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "cGl4ZWxz" });
  const metadata = JSON.parse((observed.content[0] as { text: string }).text);
  expect(metadata.screenshotStatus).toBe("captured");
  expect(metadata.screenshots[0]).toEqual({
    mimeType: "image/png",
    width: 800,
    height: 1600,
    scale: 2,
  });
});

it("marks missing requested pixels as an error while preserving diagnostic text", async () => {
  const { call, driver, context } = fixture();
  await driver.execute(context);
  const fallback = call.getMockImplementation()!;
  call.mockImplementation(async (action) =>
    action === "get_window_state"
      ? {
          screenshots: [],
          accessibility: { tree: "menu bar" },
          notes: ["capture_failed: no pixels"],
        }
      : fallback(action),
  );
  Object.assign(context.request.args, { action: "observe", window: 41 });
  const failed = await driver.execute(context);
  expect(failed.isError).toBe(true);
  expect(JSON.parse((failed.content[0] as { text: string }).text)).toMatchObject({
    screenshotStatus: "unavailable",
    notes: ["capture_failed: no pixels"],
  });
  Object.assign(context.request.args, { screenshot: false });
  const textOnly = await driver.execute(context);
  expect(textOnly.isError).toBeUndefined();
  expect(context.activity).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: "find_elements" }),
  );
  expect(JSON.parse((textOnly.content[0] as { text: string }).text).screenshotStatus).toBe(
    "not_requested",
  );
});

it("supports bounded high-detail screenshot-only observations", async () => {
  const { call, driver, context } = fixture();
  await driver.execute(context);
  Object.assign(context.request.args, {
    action: "observe",
    window: 41,
    accessibility: false,
    max_dimension: 2400,
  });
  await driver.execute(context);
  expect(call).toHaveBeenLastCalledWith(
    "get_window_state",
    expect.objectContaining({
      include_screenshot: true,
      include_text: false,
      max_dimension: 2400,
      format: "png",
    }),
    context.signal,
  );
  Object.assign(context.request.args, { max_dimension: 999999 });
  await expect(driver.execute(context)).rejects.toThrow("Invalid max_dimension");
  Object.assign(context.request.args, { screenshot: false, max_dimension: 1600 });
  await expect(driver.execute(context)).rejects.toThrow("must request");
});
it("does not interpret activate as background control", async () => {
  const { driver, context, call } = fixture();
  await driver.execute(context);
  Object.assign(context.request.args, { action: "activate", window: 41 });
  await expect(driver.execute(context)).rejects.toThrow("explicit foreground mode");
  expect(context.authorizeForeground).not.toHaveBeenCalled();
  expect(call.mock.calls.some(([action]) => action === "activate_window")).toBe(false);
});
