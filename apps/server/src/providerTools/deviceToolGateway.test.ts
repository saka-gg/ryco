import { request as httpRequest } from "node:http";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceBackendError } from "../device/DeviceBackend.ts";
import { DEVICE_IDLE_SHUTDOWN_MS, DeviceManager } from "../device/DeviceManager.ts";
import {
  DEVICE_WAIT_DEFAULT_MS,
  DEVICE_WAIT_MAX_MS,
  type DeviceSettleTiming,
} from "../device/deviceObservation.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import { DEVICE_TOOL_DEFINITIONS } from "./deviceToolDefinitions.ts";
import {
  DEVICE_TOOL_NAMES,
  blockProcessDeviceToolsForAgentControl,
  callDeviceTool,
  deviceToolRequiresApproval,
  isViewerFacingDeviceToolError,
  startDeviceToolGateway,
  type DeviceToolContent,
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
    const content = (inventory.body as { result: { content: Array<{ text: string }> } }).result
      .content;
    // The first successful call of a binding leads with the driving guide.
    expect(content[0]?.text).toMatch(/^- Device guide/u);
    expect(JSON.parse(content.at(-1)?.text ?? "{}").devices).toHaveLength(4);

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
      "device_configure",
    ]);
    expect(deviceToolRequiresApproval("device_list")).toBe(false);
    expect(deviceToolRequiresApproval("device_screenshot")).toBe(false);
    expect(deviceToolRequiresApproval("device_describe_ui")).toBe(false);
    expect(deviceToolRequiresApproval("device_wait")).toBe(false);
    expect(deviceToolRequiresApproval("device_logs")).toBe(false);
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

const UDID = "FAKE-0001";
const THREAD = "thread-evidence";

/** Settle windows short enough for real timers. */
const FAST: Partial<DeviceSettleTiming> = {
  quietMs: 20,
  timeoutMs: 400,
  pollMs: 5,
  startDelayMs: 5,
  changeGraceMs: 40,
  appChangeTimeoutMs: 60,
};

interface ToolResult {
  readonly content: DeviceToolContent[];
  readonly isError?: boolean;
}

const textBlock = (result: ToolResult, index: number) =>
  (result.content[index] as { readonly text: string }).text;
const jsonBlock = (result: ToolResult, index = 0) =>
  JSON.parse(textBlock(result, index)) as Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function noisePng(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#202020",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
}

/** A gateway over a booted fake simulator whose binding already received the guide. */
async function bootedGateway(timing: Partial<DeviceSettleTiming> = FAST) {
  const backend = new FakeDeviceBackend();
  await backend.boot(UDID);
  manager = new DeviceManager({ backend });
  gateway = await startDeviceToolGateway(manager, { timing });
  const binding = gateway.createBinding({ threadId: THREAD, isTurnActive: () => true });
  const call = async (name: string, args: Record<string, unknown>) =>
    (
      (await post(binding.url, binding.headers, "tools/call", { name, arguments: args })).body as {
        result: ToolResult;
      }
    ).result;
  await call("device_list", {});
  return { backend, binding, call, manager };
}

describe("device tool evidence, waits, logs and configure", () => {
  it("lists fifteen tools with flat schemas and wait bounds that match the observer", () => {
    expect(DEVICE_TOOL_NAMES).toHaveLength(15);
    expect(DEVICE_TOOL_NAMES.slice(-3)).toEqual(["device_wait", "device_logs", "device_configure"]);
    expect(JSON.stringify(DEVICE_TOOL_DEFINITIONS)).not.toMatch(/"(?:oneOf|anyOf|allOf)"/u);
    const wait = DEVICE_TOOL_DEFINITIONS.find((tool) => tool.name === "device_wait")!;
    const properties = wait.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(properties.timeoutMs?.maximum).toBe(DEVICE_WAIT_MAX_MS);
    expect(wait.description).toContain(
      `defaults to ${DEVICE_WAIT_DEFAULT_MS}, max ${DEVICE_WAIT_MAX_MS}`,
    );
  });

  it("returns the settled screen as JSON and text after a tap, with no screenshot by default", async () => {
    const { backend, call } = await bootedGateway();

    const result = await call("device_tap", { udid: UDID, x: 10, y: 10 });

    expect(result.isError).toBeUndefined();
    expect(result.content.map((block) => block.type)).toEqual(["text", "text"]);
    expect(jsonBlock(result)).toMatchObject({
      udid: UDID,
      x: 10,
      y: 10,
      settled: true,
      screenChanged: false,
      settleSignal: "accessibility",
      screenPoints: { width: 393, height: 852 },
      screenshot: "skipped",
    });
    expect(textBlock(result, 1)).toContain('Screen 393x852pt · app "Fake App"');
    expect(textBlock(result, 1)).toContain('- Button "Continue" @196,725');
    expect(backend.callsOfKind("tap")).toEqual([{ kind: "tap", udid: UDID, x: 10, y: 10 }]);
    expect(backend.callsOfKind("screenshot")).toHaveLength(0);
  });

  it("attaches exactly one screenshot when asked, and names what a label tap hit", async () => {
    const { backend, call } = await bootedGateway();

    const result = await call("device_tap", { udid: UDID, label: "Fake Toggle", screenshot: true });

    expect(result.content.map((block) => block.type)).toEqual(["text", "text", "image"]);
    expect(jsonBlock(result)).toMatchObject({
      x: 340,
      y: 222,
      element: { role: "CheckBox", subrole: "Switch", label: "Fake Toggle", valueBeforeTap: "0" },
      screenshot: "attached",
    });
    expect(backend.callsOfKind("screenshot")).toHaveLength(1);
  });

  it("skips the settle and the evidence with observe:false", async () => {
    const { backend, call } = await bootedGateway();
    const describesBefore = backend.callsOfKind("describeUi").length;

    const result = await call("device_tap", { udid: UDID, x: 1, y: 2, observe: false });

    expect(result.content).toHaveLength(1);
    expect(jsonBlock(result)).toEqual({ udid: UDID, x: 1, y: 2 });
    expect(backend.callsOfKind("describeUi")).toHaveLength(describesBefore);
  });

  it("still attaches a requested screenshot with observe:false, without settling", async () => {
    const { backend, call } = await bootedGateway();
    const describesBefore = backend.callsOfKind("describeUi").length;

    const result = await call("device_swipe", {
      udid: UDID,
      fromX: 10,
      fromY: 500,
      toX: 10,
      toY: 100,
      observe: false,
      screenshot: true,
    });

    expect(result.content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(jsonBlock(result)).toMatchObject({ udid: UDID, screenshot: "attached" });
    expect(jsonBlock(result)).not.toHaveProperty("settled");
    expect(backend.callsOfKind("screenshot")).toHaveLength(1);
    expect(backend.callsOfKind("describeUi")).toHaveLength(describesBefore);
  });

  it("sees a swipe change the screen", async () => {
    const { call } = await bootedGateway();

    // Scrolls the fake list far enough for its virtualized deep row to come on screen.
    const result = await call("device_swipe", {
      udid: UDID,
      fromX: 200,
      fromY: 1_900,
      toX: 200,
      toY: 100,
    });

    expect(jsonBlock(result)).toMatchObject({ screenChanged: true, settled: true });
    expect(textBlock(result, 1)).toContain('- Button "Deep Row"');
  });

  it("attaches a screenshot and reports null settle flags when the device has no tree", async () => {
    const { backend, call } = await bootedGateway();
    vi.spyOn(backend, "describeUi").mockRejectedValue(
      new DeviceBackendError("no accessibility tree"),
    );

    const result = await call("device_press_button", { udid: UDID, button: "home" });

    expect(result.content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(jsonBlock(result)).toMatchObject({
      button: "home",
      settled: null,
      screenChanged: null,
      settleSignal: "none",
      screenshot: "attached",
    });
  });

  it("returns the settled screen after scrolling an element into view", async () => {
    const { backend, call } = await bootedGateway();

    const result = await call("device_scroll_to_element", { udid: UDID, label: "Deep Row" });

    expect(backend.callsOfKind("swipe").length).toBeGreaterThan(0);
    expect(jsonBlock(result)).toMatchObject({
      udid: UDID,
      element: { role: "Button", label: "Deep Row" },
      tapPoint: { x: 196 },
      settled: true,
      screenChanged: null,
    });
    expect(textBlock(result, 1)).toContain('- Button "Deep Row"');
  });

  it("bounds typed text and launch arguments before touching the device", async () => {
    const { backend, call, manager } = await bootedGateway();

    const typed = await call("device_type", { udid: UDID, text: "x".repeat(4_097) });
    const launched = await call("device_launch", {
      udid: UDID,
      bundleId: "com.example.app",
      arguments: Array.from({ length: 65 }, () => "-flag"),
    });

    expect(typed.isError).toBe(true);
    expect(textBlock(typed, 0)).toBe(
      'Argument "text" must be a string of at most 4096 characters.',
    );
    expect(launched.isError).toBe(true);
    expect(textBlock(launched, 0)).toContain('Argument "arguments"');
    expect(backend.callsOfKind("typeText")).toHaveLength(0);
    expect(backend.callsOfKind("launch")).toHaveLength(0);
    // Argument mistakes are the agent's to fix; the pane stays healthy.
    expect((await manager.getThreadState(THREAD)).lastError).toBeNull();

    const ok = await call("device_type", { udid: UDID, text: "x".repeat(4_096) });
    expect(jsonBlock(ok)).toMatchObject({ length: 4_096, settled: true });
  });

  it("reports a launch whose app never replaces the one in front as unsettled", async () => {
    const { call } = await bootedGateway();

    const result = await call("device_launch", { udid: UDID, bundleId: "com.example.app" });

    expect(jsonBlock(result)).toMatchObject({
      udid: UDID,
      bundleId: "com.example.app",
      pid: 4_242,
      settled: false,
      screenChanged: null,
    });
  });

  it("waits for a labelled element, or for the screen to settle", async () => {
    const { call } = await bootedGateway();

    const element = await call("device_wait", { udid: UDID, label: "Continue" });
    const screen = await call("device_wait", { udid: UDID, timeoutMs: 1_000 });

    // A labelled wait ends the moment the element is there; it measured no settle.
    expect(jsonBlock(element)).toMatchObject({ udid: UDID, status: "ready", settled: null });
    expect(textBlock(element, 1)).toContain('- Button "Continue"');
    expect(jsonBlock(screen)).toMatchObject({ status: "ready", settled: true });
  });

  it("reads logs with the default bounds", async () => {
    const { backend, call } = await bootedGateway();

    const result = await call("device_logs", { udid: UDID, bundleId: "com.example.app" });
    const refused = await call("device_logs", { udid: UDID, bundleId: "--help" });

    expect(backend.callsOfKind("readLogs")).toEqual([
      {
        kind: "readLogs",
        udid: UDID,
        query: { bundleId: "com.example.app", sinceSeconds: 300, level: "default", limit: 100 },
      },
    ]);
    expect(jsonBlock(result)).toMatchObject({ bundleId: "com.example.app", log: [] });
    expect(refused.isError).toBe(true);
  });

  it("applies one simulator setting and refuses an invalid one", async () => {
    const { backend, call } = await bootedGateway();

    const applied = await call("device_configure", {
      udid: UDID,
      setting: { type: "appearance", value: "dark" },
    });
    const invalid = await call("device_configure", {
      udid: UDID,
      setting: { type: "appearance", value: "dim" },
    });

    expect(jsonBlock(applied)).toEqual({ udid: UDID, applied: "appearance" });
    expect(invalid.isError).toBe(true);
    expect(textBlock(invalid, 0)).toMatch(/^Argument "setting" is not a valid setting: /u);
    expect(backend.callsOfKind("testing")).toEqual([
      { kind: "testing", input: { udid: UDID, action: { type: "appearance", value: "dark" } } },
    ]);
  });

  it("treats a malformed push payload or tap as the agent's mistake, not a device failure", async () => {
    const { backend, call, manager } = await bootedGateway();

    const push = await call("device_configure", {
      udid: UDID,
      setting: { type: "push", bundleId: "com.example.app", payload: '{"alert":"hi"}' },
    });
    const tap = await call("device_tap", { udid: UDID });

    expect(push.isError).toBe(true);
    expect(textBlock(push, 0)).toBe(
      'Argument "setting" is not a valid setting: Push payload must be a JSON object containing an aps object.',
    );
    expect(backend.callsOfKind("testing")).toHaveLength(0);
    expect(tap.isError).toBe(true);
    expect(textBlock(tap, 0)).toMatch(/^A tap needs either label/u);
    expect(backend.callsOfKind("tap")).toHaveLength(0);
    // Neither reaches the pane's error state.
    expect((await manager.getThreadState(THREAD)).lastError).toBeNull();
  });

  it("describes the screen compactly by default and as JSON on request", async () => {
    const { call } = await bootedGateway();

    const compact = await call("device_describe_ui", { udid: UDID });
    const tree = await call("device_describe_ui", { udid: UDID, format: "tree" });

    expect(textBlock(compact, 0)).toMatch(
      /^Screen 393x852pt · app "Fake App" · 2 visible elements\n/u,
    );
    expect((jsonBlock(tree).root as { label: string }).label).toBe("Fake App");
  });

  it("sends the driving guide once, with the first successful call of each binding", async () => {
    const backend = new FakeDeviceBackend();
    manager = new DeviceManager({ backend });
    gateway = await startDeviceToolGateway(manager, { timing: FAST });
    const call = async (
      binding: { url: string; headers: Readonly<Record<string, string>> },
      name: string,
      args: Record<string, unknown>,
    ) =>
      (
        (await post(binding.url, binding.headers, "tools/call", { name, arguments: args }))
          .body as { result: ToolResult }
      ).result;
    const binding = gateway.createBinding({ threadId: THREAD, isTurnActive: () => true });

    const failed = await call(binding, "device_wait", { udid: UDID, timeoutMs: -1 });
    const first = await call(binding, "device_list", {});
    const second = await call(binding, "device_list", {});

    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
    expect(textBlock(failed, 0)).not.toContain("Device guide");
    expect(first.content).toHaveLength(2);
    expect(textBlock(first, 0)).toMatch(/^- Device guide \(sent once\)/u);
    expect(textBlock(first, 0)).toContain("device_scroll_to_element instead of device_swipe loops");
    expect(textBlock(first, 0).length).toBeLessThan(2_000);
    expect(second.content).toHaveLength(1);
    expect(textBlock(second, 0)).not.toContain("Device guide");

    const other = gateway.createBinding({ threadId: "thread-other", isTurnActive: () => true });
    expect(textBlock(await call(other, "device_list", {}), 0)).toMatch(/^- Device guide/u);
  });

  it("stops settling when the provider drops the request", async () => {
    const { backend, binding, manager } = await bootedGateway({
      ...FAST,
      changeGraceMs: 30_000,
      timeoutMs: 30_000,
    });
    const describes = () => backend.callsOfKind("describeUi").length;
    // A raw request without keep-alive, so dropping it closes its socket at once.
    const request = httpRequest(binding.url, {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", ...binding.headers },
    });
    request.on("error", () => undefined);
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "device_tap", arguments: { udid: UDID, x: 5, y: 5 } },
      }),
    );
    const started = describes();
    const deadline = Date.now() + 5_000;
    while (describes() < started + 5 && Date.now() < deadline) await sleep(5);
    expect(describes()).toBeGreaterThanOrEqual(started + 5);

    request.destroy();
    await sleep(100);
    const afterAbort = describes();
    await sleep(200);

    expect(describes()).toBe(afterAbort);
    // A call nobody waits for any more is not a device failure.
    expect((await manager.getThreadState(THREAD)).lastError).toBeNull();
    // The tap reached the device before the settle, so the device was surfaced then.
    expect((await manager.getThreadState(THREAD)).attachedDeviceUdid).toBe(UDID);
  });

  it("stops a call the client cancels without dropping its connection", async () => {
    const { backend, binding } = await bootedGateway();
    const describes = () => backend.callsOfKind("describeUi").length;
    const pending = post(binding.url, binding.headers, "tools/call", {
      name: "device_wait",
      arguments: { udid: UDID, label: "Never", timeoutMs: 30_000 },
    });
    const deadline = Date.now() + 5_000;
    while (describes() < 2 && Date.now() < deadline) await sleep(5);

    const started = Date.now();
    const response = await fetch(binding.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...binding.headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1, reason: "user stopped" },
      }),
    });
    const cancelled = (await pending).body as { result: ToolResult };
    const afterCancel = describes();
    await sleep(300);

    expect(response.status).toBe(202);
    expect(cancelled.result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(describes()).toBe(afterCancel);
  });

  it("aborts calls still running when the gateway closes", async () => {
    const { backend, binding } = await bootedGateway();
    const describes = () => backend.callsOfKind("describeUi").length;
    const pending = post(binding.url, binding.headers, "tools/call", {
      name: "device_wait",
      arguments: { udid: UDID, label: "Never", timeoutMs: 30_000 },
    }).catch(() => null);
    const deadline = Date.now() + 5_000;
    while (describes() < 2 && Date.now() < deadline) await sleep(5);

    const started = Date.now();
    await gateway!.close();
    gateway = null;
    const closedIn = Date.now() - started;
    await pending;
    const afterClose = describes();
    await sleep(300);

    // Shutdown does not wait out the 30 s wait, and nothing keeps polling.
    expect(closedIn).toBeLessThan(2_000);
    expect(describes()).toBe(afterClose);
  });

  it("fits images to the caller's transport budget", async () => {
    const backend = new FakeDeviceBackend();
    await backend.boot(UDID);
    manager = new DeviceManager({ backend });
    backend.setScreenshotPng((await noisePng(1_000, 1_000)).toString("base64"));

    const tapped = await callDeviceTool({
      manager,
      threadId: THREAD,
      name: "device_tap",
      args: { udid: UDID, x: 1, y: 1, screenshot: true },
      maxImageBase64Chars: 360_000,
      timing: FAST,
    });
    const shot = await callDeviceTool({
      manager,
      threadId: THREAD,
      name: "device_screenshot",
      args: { udid: UDID },
      maxImageBase64Chars: 360_000,
    });

    const tapImage = tapped.content[2] as { data: string; mimeType: string };
    expect(tapImage.mimeType).toBe("image/jpeg");
    expect(tapImage.data.length).toBeLessThanOrEqual(360_000);
    const tapMetadata = JSON.parse((tapped.content[0] as { text: string }).text);
    expect(tapMetadata.screenshot).toMatch(/^attached: scaled from 1000x1000 to \d+x\d+ JPEG/u);
    expect(tapMetadata.screenshotPixels).toEqual({ width: 1_000, height: 1_000 });
    expect(shot.isError).toBeUndefined();
    const shotImage = shot.content[1] as { data: string; mimeType: string };
    expect(shotImage.mimeType).toBe("image/jpeg");
    expect(shotImage.data.length).toBeLessThanOrEqual(360_000);
    // width and height stay the capture's: Android input coordinates are its pixels.
    const shotMetadata = JSON.parse((shot.content[0] as { text: string }).text);
    expect(shotMetadata).toMatchObject({ mimeType: "image/png", width: 1_000, height: 1_000 });
    expect(shotMetadata.scaledToFitTransport).toMatchObject({ mimeType: "image/jpeg" });
    expect(shotMetadata.scaledToFitTransport.width).toBeLessThan(1_000);
  });
});
