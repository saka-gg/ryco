import { afterEach, describe, expect, it } from "vitest";

import { DeviceManager } from "../device/DeviceManager.ts";
import { FakeDeviceBackend } from "../device/FakeDeviceBackend.ts";
import { withAttachmentInstructions } from "../provider/attachmentInstructionDelivery.ts";
import {
  AGENT_DEVICES_OFF_TEXT,
  DEFAULT_DEVICE_TOOL_ACCESS,
  DEVICES_OFF_TEXT,
  agentDeviceRefusal,
  setDeviceToolAccess,
} from "./deviceToolAccess.ts";
import {
  createProcessDeviceToolBinding,
  installProcessDeviceToolGateway,
  startDeviceToolGateway,
  threadHasDeviceTools,
  type DeviceToolGateway,
} from "./deviceToolGateway.ts";
import { DEVICE_ROUTING_INSTRUCTIONS } from "./deviceToolRouting.ts";

let gateway: DeviceToolGateway | null = null;
let manager: DeviceManager | null = null;

afterEach(async () => {
  setDeviceToolAccess(DEFAULT_DEVICE_TOOL_ACCESS);
  installProcessDeviceToolGateway(null);
  await gateway?.close();
  await manager?.dispose();
  gateway = null;
  manager = null;
});

async function startProcessGateway() {
  manager = new DeviceManager({ backend: new FakeDeviceBackend() });
  gateway = await startDeviceToolGateway(manager);
  installProcessDeviceToolGateway(gateway);
}

async function call(
  binding: { url: string; headers: Readonly<Record<string, string>> },
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
) {
  const response = await fetch(binding.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...binding.headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  return (
    (await response.json()) as {
      result: { isError?: boolean; content: Array<{ type: string; text?: string }> };
    }
  ).result;
}

describe("device tool access settings", () => {
  it("names the setting to turn on, Use simulators first", () => {
    expect(agentDeviceRefusal(DEFAULT_DEVICE_TOOL_ACCESS)).toBeNull();
    expect(agentDeviceRefusal({ devicesEnabled: false, agentDevicesEnabled: true })).toBe(
      DEVICES_OFF_TEXT,
    );
    expect(agentDeviceRefusal({ devicesEnabled: false, agentDevicesEnabled: false })).toBe(
      DEVICES_OFF_TEXT,
    );
    expect(agentDeviceRefusal({ devicesEnabled: true, agentDevicesEnabled: false })).toBe(
      AGENT_DEVICES_OFF_TEXT,
    );
    expect(AGENT_DEVICES_OFF_TEXT).toContain("Agents can use simulators");
    expect(AGENT_DEVICES_OFF_TEXT).toContain("do not drive a simulator another way");
  });

  it("gives a session started while access is off no device tools at all", async () => {
    await startProcessGateway();
    setDeviceToolAccess({ devicesEnabled: true, agentDevicesEnabled: false });
    expect(createProcessDeviceToolBinding({ threadId: "t-off", isTurnActive: () => true })).toBe(
      null,
    );
    expect(threadHasDeviceTools("t-off")).toBe(false);

    setDeviceToolAccess(DEFAULT_DEVICE_TOOL_ACCESS);
    const binding = createProcessDeviceToolBinding({ threadId: "t-on", isTurnActive: () => true });
    expect(binding).not.toBeNull();
    expect(threadHasDeviceTools("t-on")).toBe(true);
    binding!.dispose();
    binding!.dispose();
    expect(threadHasDeviceTools("t-on")).toBe(false);
  });

  it("refuses calls of a running session once access is turned off", async () => {
    await startProcessGateway();
    const binding = createProcessDeviceToolBinding({
      threadId: "t-run",
      isTurnActive: () => true,
    })!;
    expect((await call(binding, "device_read", { action: "list" })).isError).toBeUndefined();

    setDeviceToolAccess({ devicesEnabled: false, agentDevicesEnabled: true });
    const refused = await call(binding, "device_read", { action: "list" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toBe(DEVICES_OFF_TEXT);
    binding.dispose();
  });

  it("sends the driving guide once to each agent of a session", async () => {
    await startProcessGateway();
    const callers = new Map([["toolu_sub", "agent-1"]]);
    const binding = createProcessDeviceToolBinding({
      threadId: "t-agents",
      isTurnActive: () => true,
      agentKeyFor: (toolUseId) => (toolUseId === undefined ? undefined : callers.get(toolUseId)),
    })!;
    const guided = async (meta?: Record<string, unknown>) =>
      (await call(binding, "device_read", { action: "list" }, meta)).content[0]?.text?.startsWith(
        "- Device guide",
      ) === true;

    expect(await guided({ "claudecode/toolUseId": "toolu_main" })).toBe(true);
    expect(await guided()).toBe(false);
    // A subagent never saw its parent's results: it gets the guide on its own first call.
    expect(await guided({ "claudecode/toolUseId": "toolu_sub" })).toBe(true);
    expect(await guided({ "claudecode/toolUseId": "toolu_sub" })).toBe(false);
    binding.dispose();
  });

  it("adds the routing rules to first-turn instructions only for sessions with device tools", () => {
    expect(withAttachmentInstructions("hi")).not.toContain("<ryco_devices>");
    const withDevices = withAttachmentInstructions("hi", { deviceTools: true });
    expect(withDevices).toContain(DEVICE_ROUTING_INSTRUCTIONS);
    expect(withDevices.endsWith("\n\nhi")).toBe(true);
    expect(DEVICE_ROUTING_INSTRUCTIONS.length).toBeLessThan(1_200);
  });
});
