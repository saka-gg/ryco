import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { EnvironmentId, ThreadId, type ThreadDeviceState } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const detach = vi.fn(async () => undefined);
vi.mock("../environmentApi", () => ({ readEnvironmentApi: () => ({ device: { detach } }) }));

const {
  adoptableUdids,
  closeWorkspaceDeviceTab,
  deviceWorkspaceThreadKey,
  floatWorkspaceDevice,
  forgetReleasedDevice,
  showAgentOpenedDevice,
} = await import("./deviceWorkspaceActions");
const { useDeviceTabsStore } = await import("./deviceTabsStore");
const { useWorkspaceMiniPlayerStore } = await import("./workspaceMiniPlayerStore");

const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("t1") };
const threadKey = deviceWorkspaceThreadKey(thread);

function attach(entries: ReadonlyArray<{ udid: string; source: "user" | "agent" }>) {
  const state = {
    threadId: thread.threadId,
    version: 1,
    attachedDeviceUdid: entries.at(-1)?.udid ?? null,
    attachments: entries.map((entry) => ({ ...entry, attachPhase: null, lastError: null })),
    devices: [],
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
  } as unknown as ThreadDeviceState;
  useDeviceStateStore.setState({ threadByKey: { [threadKey]: state } });
}

beforeEach(() => {
  detach.mockClear();
  useDeviceTabsStore.setState({ byThreadKey: {} });
  useWorkspaceMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("device workspace actions", () => {
  it("detaches a closed tab's device, and never adopts it back from a stale snapshot", () => {
    attach([{ udid: "A", source: "user" }]);
    useDeviceTabsStore.getState().openDevice(threadKey, "A");
    const tabId = useDeviceTabsStore.getState().byThreadKey[threadKey]!.tabs[0]!.id;

    expect(closeWorkspaceDeviceTab(thread, tabId)).toBe(0);

    expect(detach).toHaveBeenCalledWith({ threadId: thread.threadId, udid: "A" });
    // The detach is in flight; the attachment is still listed.
    expect(adoptableUdids(threadKey, [{ udid: "A", source: "user" }])).toEqual([]);
    forgetReleasedDevice(threadKey, "A");
    expect(adoptableUdids(threadKey, [{ udid: "A", source: "user" }])).toEqual(["A"]);
  });

  it("keeps a closed tab's device attached while it floats", () => {
    attach([{ udid: "A", source: "user" }]);
    useDeviceTabsStore.getState().openDevice(threadKey, "A");
    floatWorkspaceDevice(thread, "A");
    const tabId = useDeviceTabsStore.getState().byThreadKey[threadKey]!.tabs[0]!.id;

    closeWorkspaceDeviceTab(thread, tabId);

    expect(detach).not.toHaveBeenCalled();
  });

  it("releases the device a new floating device replaces", () => {
    attach([
      { udid: "A", source: "user" },
      { udid: "B", source: "agent" },
    ]);
    floatWorkspaceDevice(thread, "A");

    expect(
      showAgentOpenedDevice({ thread, udid: "B", floating: true, devicePanelVisible: false }),
    ).toBe("float");

    expect(detach).toHaveBeenCalledWith({ threadId: thread.threadId, udid: "A" });
  });

  it("leaves an agent's attachment for the agent", () => {
    attach([{ udid: "B", source: "agent" }]);
    floatWorkspaceDevice(thread, "B");
    floatWorkspaceDevice(thread, "C");
    expect(detach).not.toHaveBeenCalled();
  });

  it("opens a tab instead of floating when floating is off, and nothing when it shows", () => {
    expect(
      showAgentOpenedDevice({ thread, udid: "A", floating: false, devicePanelVisible: false }),
    ).toBe("tab");
    expect(
      useDeviceTabsStore.getState().byThreadKey[threadKey]?.tabs.map((tab) => tab.udid),
    ).toEqual(["A"]);
    expect(
      showAgentOpenedDevice({ thread, udid: "A", floating: true, devicePanelVisible: true }),
    ).toBe("none");
  });
});
