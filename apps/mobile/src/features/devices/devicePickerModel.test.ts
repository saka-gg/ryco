import type {
  DeviceAvailability,
  DeviceDescriptor,
  DeviceUdid,
  ThreadDeviceState,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachedDeviceCards,
  bootAndAttachDevice,
  createDeviceRecordingStore,
  deviceListSections,
  devicePlatformLines,
  deviceToolsTarget,
  freeSlotThenAttach,
  installAppRequest,
  launchAppRequest,
  recordingElapsedText,
  recordingStarted,
  recordingStatusText,
  recordingStopping,
  rememberBundleId,
  threadDevicesNotice,
  type DevicePickerApi,
} from "./devicePickerModel";

const THREAD = "thread-1" as ThreadId;
const udid = (value: string) => value as DeviceUdid;

function device(overrides: Partial<DeviceDescriptor> & { udid: string }): DeviceDescriptor {
  return {
    platform: "ios-simulator",
    name: overrides.udid,
    runtime: "iOS 26.0",
    state: "shutdown",
    bootSource: "user",
    ...overrides,
  } as DeviceDescriptor;
}

function threadState(overrides: Partial<ThreadDeviceState> = {}): ThreadDeviceState {
  return {
    threadId: THREAD,
    version: 1,
    attachedDeviceUdid: null,
    attachments: [],
    devices: [],
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
    ...overrides,
  } as ThreadDeviceState;
}

describe("device list", () => {
  it("groups iOS before Android and says what a press does", () => {
    const sections = deviceListSections({
      devices: [
        device({ udid: "pixel", name: "Pixel", platform: "android-emulator", runtime: "API 35" }),
        device({ udid: "off", name: "iPhone Off" }),
        device({ udid: "on", name: "iPhone On", state: "booted" }),
        device({ udid: "mine", name: "iPhone Mine", state: "booted" }),
        device({ udid: "agent", name: "iPhone Agent", state: "booted" }),
      ],
      threadState: threadState({
        attachments: [
          { udid: udid("agent"), source: "agent", attachPhase: null, lastError: null },
          { udid: udid("mine"), source: "user", attachPhase: null, lastError: null },
        ],
      }),
    });
    expect(sections.map((section) => section.label)).toEqual([
      "iOS Simulators",
      "Android Emulators",
    ]);
    const rows = Object.fromEntries(sections[0]!.rows.map((row) => [row.device.udid, row]));
    expect(rows.off).toMatchObject({ action: "start", attached: false });
    expect(rows.on).toMatchObject({ action: "attach", detail: "iOS 26.0 · Running" });
    expect(rows.mine).toMatchObject({
      action: null,
      attached: true,
      detail: "iOS 26.0 · Running · On this thread",
    });
    // Watching the agent's device makes it the person's.
    expect(rows.agent).toMatchObject({
      action: "attach",
      detail: "iOS 26.0 · Running · Agent's device",
    });
  });

  it("offers nothing while a device starts or stops", () => {
    const [section] = deviceListSections({
      devices: [device({ udid: "a" }), device({ udid: "b", state: "shutting-down" })],
      threadState: threadState({ startingDeviceUdids: [udid("a")] }),
    });
    expect(section!.rows.map((row) => [row.status, row.action])).toEqual([
      ["starting", null],
      ["stopping", null],
    ]);
  });
});

describe("attached devices", () => {
  const devices = [
    device({ udid: "a", name: "iPhone A", state: "booted" }),
    device({ udid: "b", name: "iPhone B", state: "booting" }),
  ];

  it("lists the newest attachment first, with its phase or failure", () => {
    const cards = attachedDeviceCards(
      threadState({
        attachments: [
          { udid: udid("a"), source: "user", attachPhase: null, lastError: null },
          { udid: udid("b"), source: "agent", attachPhase: "booting", lastError: null },
          { udid: udid("gone"), source: "user", attachPhase: null, lastError: "It crashed" },
        ],
      }),
      devices,
    );
    expect(cards.map((card) => [card.udid, card.statusLabel, card.tone])).toEqual([
      ["gone", "Failed", "error"],
      ["b", "Starting up…", "busy"],
      ["a", "Running", "running"],
    ]);
    expect(cards[0]!.name).toBe("Device");
  });

  it("acts on the chosen running device, else the latest running one", () => {
    const cards = attachedDeviceCards(
      threadState({
        attachments: [
          { udid: udid("a"), source: "user", attachPhase: null, lastError: null },
          { udid: udid("b"), source: "user", attachPhase: null, lastError: null },
        ],
      }),
      devices,
    );
    expect(deviceToolsTarget(cards, null)?.udid).toBe("a");
    expect(deviceToolsTarget(cards, udid("b"))?.udid).toBe("a");
    expect(deviceToolsTarget([], null)).toBeNull();
  });
});

describe("setup notice", () => {
  const ready = {
    connected: true,
    availability: { kind: "available" } as DeviceAvailability,
    platforms: [],
    gate: { showSetup: false, devicesOff: false },
    hasAttachment: false,
    attachedRunning: false,
    canManage: true,
  };

  it("shows the list when the node is ready", () => {
    expect(threadDevicesNotice(ready)).toBeNull();
  });

  it("asks the owner to finish first-run setup, and others to wait", () => {
    const gate = { showSetup: true, devicesOff: false };
    expect(threadDevicesNotice({ ...ready, gate })?.action).toEqual({
      label: "Finish setup",
      kind: "finish-setup",
    });
    expect(threadDevicesNotice({ ...ready, gate, canManage: false })?.action).toBeNull();
    // A thread already showing a device goes on showing it.
    expect(threadDevicesNotice({ ...ready, gate, hasAttachment: true })).toBeNull();
  });

  it("offers Turn on when simulators are off", () => {
    const notice = threadDevicesNotice({ ...ready, gate: { showSetup: false, devicesOff: true } });
    expect(notice?.kind).toBe("off");
    expect(notice?.action?.kind).toBe("turn-on");
  });

  it("lists the setup steps left, without the helper build", () => {
    const notice = threadDevicesNotice({
      ...ready,
      availability: {
        kind: "setup-required",
        steps: [
          { id: "install-xcode", label: "Install Xcode", done: false, detail: "xcode-select" },
          { id: "accept-xcode-license", label: "Accept the license", done: true },
          { id: "build-device-helper", label: "Build the helper", done: false },
        ],
      } as DeviceAvailability,
    });
    expect(notice?.kind).toBe("setup");
    expect(notice?.steps).toEqual([{ label: "Install Xcode", detail: "xcode-select" }]);
  });

  it("explains an unsupported node and keeps a running device through a helper blip", () => {
    expect(
      threadDevicesNotice({
        ...ready,
        availability: { kind: "unsupported-platform", platform: "linux" },
      })?.detail,
    ).toContain("linux");
    const helper = { kind: "helper-unavailable", message: "No answer" } as DeviceAvailability;
    expect(threadDevicesNotice({ ...ready, availability: helper })?.kind).toBe("helper");
    expect(
      threadDevicesNotice({ ...ready, availability: helper, attachedRunning: true }),
    ).toBeNull();
    expect(threadDevicesNotice({ ...ready, availability: null })?.kind).toBe("loading");
    expect(threadDevicesNotice({ ...ready, connected: false })?.kind).toBe("unavailable");
  });

  it("names each platform", () => {
    expect(
      devicePlatformLines([
        {
          platform: "android-emulator",
          availability: { kind: "unsupported-platform", platform: "x" },
        },
      ]),
    ).toEqual([
      {
        platform: "android-emulator",
        label: "Android Emulator",
        tone: "off",
        summary: "Not available on x",
      },
    ]);
    expect(devicePlatformLines(undefined)).toEqual([]);
  });
});

describe("boot and attach", () => {
  function fakeApi(bootResult: "booted" | "limit") {
    const calls: string[] = [];
    const api: DevicePickerApi = {
      boot: async (input) => {
        calls.push(`boot ${input.udid} ${input.threadId}`);
        return bootResult === "booted"
          ? { kind: "booted", device: device({ udid: input.udid, state: "booted" }) }
          : { kind: "boot-limit-reached", limit: 3, rycoBooted: [device({ udid: "old" })] };
      },
      attach: async (input) => {
        calls.push(`attach ${input.udid}`);
        return threadState({ attachedDeviceUdid: input.udid });
      },
      shutdown: async (input) => {
        calls.push(`shutdown ${input.udid}`);
      },
    };
    return { api, calls };
  }

  it("boots a stopped device for the thread, then attaches it", async () => {
    const { api, calls } = fakeApi("booted");
    const outcome = await bootAndAttachDevice(api, THREAD, device({ udid: "a" }));
    expect(outcome.kind).toBe("attached");
    expect(calls).toEqual(["boot a thread-1", "attach a"]);
  });

  it("attaches a running device without booting it", async () => {
    const { api, calls } = fakeApi("booted");
    await bootAndAttachDevice(api, THREAD, device({ udid: "a", state: "booted" }));
    expect(calls).toEqual(["attach a"]);
  });

  it("hands back the shutdown candidates at the boot limit, and frees one on request", async () => {
    const { api, calls } = fakeApi("limit");
    const requested = device({ udid: "a" });
    const outcome = await bootAndAttachDevice(api, THREAD, requested);
    expect(outcome).toMatchObject({ kind: "boot-limit", limit: 3, requested });
    expect(calls).toEqual(["boot a thread-1"]);
    await freeSlotThenAttach(api, THREAD, device({ udid: "old" }), requested);
    expect(calls.slice(1)).toEqual(["shutdown old", "boot a thread-1"]);
  });
});

describe("install and launch", () => {
  it("takes an absolute .app path for a simulator and an .apk for an emulator", () => {
    expect(installAppRequest(udid("a"), "ios-simulator", "  ")).toEqual({
      ok: false,
      reason: null,
    });
    expect(installAppRequest(udid("a"), "ios-simulator", "/build/My.app/")).toEqual({
      ok: true,
      input: { udid: "a", appPath: "/build/My.app" },
    });
    expect(installAppRequest(udid("a"), "ios-simulator", "build/My.app").ok).toBe(false);
    expect(installAppRequest(udid("a"), "ios-simulator", "/build/app.apk").ok).toBe(false);
    expect(installAppRequest(udid("a"), "android-emulator", "C:\\out\\app.apk").ok).toBe(true);
    expect(installAppRequest(udid("a"), "android-emulator", "/out/My.app").ok).toBe(false);
  });

  it("takes a bundle id without spaces", () => {
    expect(launchAppRequest(udid("a"), " com.example.app ")).toEqual({
      ok: true,
      input: { udid: "a", bundleId: "com.example.app" },
    });
    expect(launchAppRequest(udid("a"), "com example").ok).toBe(false);
    expect(launchAppRequest(udid("a"), "")).toEqual({ ok: false, reason: null });
  });

  it("remembers installed bundle ids newest first, once each", () => {
    expect(rememberBundleId(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberBundleId(["a", "b", "c", "d"], "e")).toEqual(["e", "a", "b", "c"]);
  });
});

describe("recording", () => {
  const startedAt = "2026-11-08T10:00:00.000Z";

  it("counts from the node's start time", () => {
    expect(recordingElapsedText(startedAt, Date.parse(startedAt) + 65_400)).toBe("1:05");
    expect(recordingElapsedText(startedAt, Date.parse(startedAt) - 5_000)).toBe("0:00");
  });

  it("says what the recording is doing", () => {
    const recording = recordingStarted({ udid: udid("a"), path: "/rec.mp4", startedAt });
    expect(recordingStatusText(recording, Date.parse(startedAt) + 3_000)).toBe("Recording · 0:03");
    expect(recordingStatusText(recordingStopping(recording), 0)).toBe("Saving…");
    expect(
      recordingStatusText(
        {
          kind: "idle",
          saved: {
            udid: udid("a"),
            path: "/rec.mp4",
            sizeBytes: 1,
            durationMs: 12_000,
            stoppedAt: startedAt,
          },
        },
        0,
      ),
    ).toBe("Saved 0:12 to /rec.mp4");
  });

  it("keeps each device's recording apart and tells subscribers", () => {
    const store = createDeviceRecordingStore();
    let notified = 0;
    const stop = store.subscribe(() => (notified += 1));
    const key = store.key("env", "a");
    store.set(key, { kind: "starting" });
    expect(store.get(key).kind).toBe("starting");
    expect(store.get(store.key("env", "b")).kind).toBe("idle");
    stop();
    store.set(key, { kind: "idle", saved: null });
    expect(notified).toBe(1);
  });
});
