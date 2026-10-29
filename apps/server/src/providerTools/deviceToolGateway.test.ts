import { afterEach, describe, expect, it } from "vitest";

import { DEVICE_IDLE_SHUTDOWN_MS, DeviceManager } from "../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import {
  DEVICE_TOOL_NAMES,
  blockProcessDeviceToolsForAgentControl,
  deviceToolRequiresApproval,
  isViewerFacingDeviceToolError,
  startDeviceToolGateway,
  type DeviceToolGateway,
} from "./deviceToolGateway.ts";

let gateway: DeviceToolGateway | null = null;
let manager: DeviceManager | null = null;

afterEach(async () => {
  await gateway?.close();
  await manager?.dispose();
  gateway = null;
  manager = null;
});

async function post(
  url: string,
  headers: Readonly<Record<string, string>>,
  method: string,
  params?: unknown,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null } as const;
}

describe("device tool gateway", () => {
  it("serves the complete catalogue through a thread-bound bearer token", async () => {
    manager = new DeviceManager({ backend: new FakeDeviceBackend() });
    gateway = await startDeviceToolGateway(manager);
    let active = true;
    const binding = gateway.createBinding({
      threadId: "thread-a",
      isTurnActive: () => active,
    });

    const listed = await post(binding.url, binding.headers, "tools/list");
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(DEVICE_TOOL_NAMES);

    const inventory = await post(binding.url, binding.headers, "tools/call", {
      name: "device_list",
      arguments: { includeShutdown: true },
    });
    expect(inventory.status).toBe(200);
    const text = (inventory.body as { result: { content: Array<{ text: string }> } }).result
      .content[0]?.text;
    expect(JSON.parse(text ?? "{}").devices).toHaveLength(4);

    active = false;
    const inactive = await post(binding.url, binding.headers, "tools/call", {
      name: "device_list",
      arguments: {},
    });
    expect((inactive.body as { result: { isError: boolean } }).result.isError).toBe(true);

    binding.dispose();
    expect((await post(binding.url, binding.headers, "tools/list")).status).toBe(401);
  });

  it("marks every state-changing tool for provider approval", () => {
    expect(DEVICE_TOOL_NAMES.filter(deviceToolRequiresApproval)).toEqual([
      "device_boot",
      "device_install",
      "device_launch",
      "device_open_url",
      "device_tap",
      "device_swipe",
      "device_type",
      "device_press_button",
      "device_scroll_to_element",
    ]);
    expect(deviceToolRequiresApproval("device_list")).toBe(false);
    expect(deviceToolRequiresApproval("device_screenshot")).toBe(false);
    expect(deviceToolRequiresApproval("device_describe_ui")).toBe(false);
  });

  it("cannot use legacy mutation or content tools to bypass an Agent Control lease", async () => {
    const backend = new FakeDeviceBackend();
    manager = new DeviceManager({ backend });
    gateway = await startDeviceToolGateway(manager);
    const binding = gateway.createBinding({ threadId: "thread-locked", isTurnActive: () => true });
    const release = blockProcessDeviceToolsForAgentControl("thread-locked", "lease-1");

    const listed = await post(binding.url, binding.headers, "tools/list");
    expect(
      (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["device_list"]);

    for (const name of ["device_boot", "device_screenshot", "device_describe_ui"]) {
      const denied = await post(binding.url, binding.headers, "tools/call", {
        name,
        arguments: { udid: "FAKE-0001" },
      });
      expect((denied.body as { result: { isError: boolean } }).result.isError).toBe(true);
    }
    expect(backend.calls).toEqual([]);

    const releaseReplacement = blockProcessDeviceToolsForAgentControl("thread-locked", "lease-2");
    release();
    const stillLocked = await post(binding.url, binding.headers, "tools/list");
    expect(
      (stillLocked.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["device_list"]);

    releaseReplacement();
    const restored = await post(binding.url, binding.headers, "tools/list");
    expect(
      (restored.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(DEVICE_TOOL_NAMES);
  });

  it("holds a device an agent booted for its running turn, then lets it idle out", async () => {
    const backend = new FakeDeviceBackend();
    const timers = new Map<number, { readonly handler: () => void; readonly ms: number }>();
    let nextTimer = 0;
    manager = new DeviceManager({
      backend,
      attachDeadlineMs: 0,
      setTimeout: (handler, ms) => {
        nextTimer += 1;
        timers.set(nextTimer, { handler, ms });
        return nextTimer as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as unknown as number);
      },
    });
    const idleTimers = () =>
      [...timers.values()].filter((timer) => timer.ms === DEVICE_IDLE_SHUTDOWN_MS);
    gateway = await startDeviceToolGateway(manager);
    const binding = gateway.createBinding({ threadId: "thread-a", isTurnActive: () => true });
    manager.observeThreadTurn("thread-a", "turn-1");

    const booted = await post(binding.url, binding.headers, "tools/call", {
      name: "device_boot",
      arguments: { udid: "FAKE-0001" },
    });
    expect((booted.body as { result: { isError?: boolean } }).result.isError).not.toBe(true);
    expect(backend.callsOfKind("boot")).toHaveLength(1);
    // Attached for the agent, and held only by the running turn.
    expect((await manager.getThreadState("thread-a")).attachedDeviceUdid).toBe("FAKE-0001");
    expect(idleTimers()).toHaveLength(0);

    manager.observeThreadTurn("thread-a", null);
    expect(idleTimers()).toHaveLength(1);
    idleTimers()[0]!.handler();
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (backend.callsOfKind("shutdown").length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(backend.callsOfKind("shutdown").map((call) => call.udid)).toEqual(["FAKE-0001"]);
  });

  it("keeps recoverable navigation misses out of the viewer error state", () => {
    expect(isViewerFacingDeviceToolError(new Error('No element matching label "Save".'))).toBe(
      false,
    );
    expect(
      isViewerFacingDeviceToolError(new Error("Scrolling stopped moving before a match.")),
    ).toBe(false);
    expect(
      isViewerFacingDeviceToolError(new Error("The helper process exited unexpectedly.")),
    ).toBe(true);
  });
});
