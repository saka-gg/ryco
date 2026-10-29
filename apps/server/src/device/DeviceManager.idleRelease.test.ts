/**
 * The idle grace for Ryco-booted simulators: it starts once the last real
 * consumer of the device settles, agent attachments do not count as one, and
 * use that arrives during an idle shutdown waits for it and boots again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceBackendError } from "./DeviceBackend.ts";
import { DEVICE_IDLE_SHUTDOWN_MS, DeviceManager } from "./DeviceManager.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const DEVICE_A = "FAKE-0001";
const DEVICE_B = "FAKE-0002";

const SINK: DeviceFrameSink = {
  send: () => undefined,
  bufferedAmount: () => 0,
  isOpen: () => true,
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function makeManager(backend = new FakeDeviceBackend()) {
  const manager = new DeviceManager({ backend, attachDeadlineMs: 0, attachRetryMs: 1 });
  return { backend, manager };
}

const shutdowns = (backend: FakeDeviceBackend) =>
  backend.callsOfKind("shutdown").map((call) => call.udid);

const lifecycle = (backend: FakeDeviceBackend) =>
  backend.calls
    .filter((call) => call.kind === "shutdown" || call.kind === "boot" || call.kind === "tap")
    .map((call) => call.kind);

/** Let promise chains run without moving the clock meaningfully. */
const settle = () => vi.advanceTimersByTimeAsync(1);

/** The gateway's `device_boot`: boot and attach the thread, as one held agent call. */
async function agentBoots(manager: DeviceManager, threadId: string, udid: string): Promise<void> {
  await manager.withAgentActivity(
    threadId,
    async () => {
      const result = await manager.boot(udid);
      if (result.kind === "booted") await manager.ensureThreadAttached(threadId, udid);
    },
    { udid },
  );
}

async function agentTaps(manager: DeviceManager, threadId: string, udid: string): Promise<void> {
  await manager.withAgentActivity(threadId, () => manager.tap(udid, 10, 10), { udid });
}

/** Run an idle shutdown up to the point where simctl is shutting the device down. */
async function issueHeldIdleShutdown(
  manager: DeviceManager,
  backend: FakeDeviceBackend,
): Promise<() => void> {
  await manager.boot(DEVICE_A);
  // A pane call with no turn: the grace starts when it ends.
  await manager.tap(DEVICE_A, 1, 1);
  const release = backend.holdShutdowns();
  await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);
  expect(shutdowns(backend)).toEqual([DEVICE_A]);
  return release;
}

describe("DeviceManager idle release", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shuts down an agent-booted device a grace after its turn ends", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBe(DEVICE_A);

    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS - 1);
    expect(shutdowns(backend)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
    // The agent's attachment was metadata; it goes with the device.
    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBeNull();
  });

  it("keeps the device up while the agent's turn is still running", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);

    expect(shutdowns(backend)).toEqual([]);
  });

  it("restarts the grace after every call, pane input included", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, null);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS - 60_000);
    await manager.tap(DEVICE_A, 5, 5);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS - 60_000);
    expect(shutdowns(backend)).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("keeps the device up while a viewer watches it", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, null);
    const unsubscribe = manager.subscribeFrames(DEVICE_A, SINK);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("keeps the device up while it records", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS / 2);
    await manager.startRecording(DEVICE_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    await manager.stopRecording(DEVICE_A);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("keeps the device up while a person has it attached", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, null);
    await manager.attach(THREAD_B, DEVICE_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    await manager.detach(THREAD_B);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("never shuts down a device the user booted", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, null);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);

    expect(shutdowns(backend)).toEqual([]);
  });

  it("lets an agent attachment with no running turn idle out", async () => {
    // Agent Control's approved attach, executed when no turn is running.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, () =>
      manager.attach(THREAD_A, DEVICE_A, "agent"),
    );

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("releases an earlier turn's holds without touching the running turn's", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentBoots(manager, THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, "turn-2");
    await agentTaps(manager, THREAD_A, DEVICE_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("attributes a call to the turn the projection reports while it runs", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    const finish = deferred();
    const call = manager.withAgentActivity(THREAD_A, () => finish.promise, { udid: DEVICE_A });
    manager.observeThreadTurn(THREAD_A, "turn-1");
    finish.resolve();
    await call;

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("holds the device only for the call when no turn is known", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    const finish = deferred();
    const call = manager.withAgentActivity(THREAD_A, () => finish.promise, { udid: DEVICE_A });

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    finish.resolve();
    await call;
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS - 1);
    expect(shutdowns(backend)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("makes input wait for an issued idle shutdown, then boots again before it", async () => {
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);

    const input = manager.tap(DEVICE_A, 7, 7);
    await settle();
    expect(backend.callsOfKind("tap")).toHaveLength(1);
    release();
    await input;

    expect(lifecycle(backend)).toEqual(["boot", "tap", "shutdown", "boot", "tap"]);
    expect((await manager.list()).devices.find((device) => device.udid === DEVICE_A)?.state).toBe(
      "booted",
    );
  });

  it("restores the device once for every consumer waiting on the shutdown", async () => {
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);

    const first = manager.tap(DEVICE_A, 7, 7);
    const second = manager.withAgentActivity(THREAD_A, () => manager.tap(DEVICE_A, 8, 8), {
      udid: DEVICE_A,
    });
    const attached = manager.attach(THREAD_B, DEVICE_A);
    await settle();
    release();
    await Promise.all([first, second, attached]);

    expect(backend.callsOfKind("boot")).toHaveLength(2);
    expect(backend.callsOfKind("tap")).toHaveLength(3);
    // Attached while simctl shut the device down: the attachment survives it.
    expect((await manager.getThreadState(THREAD_B)).attachedDeviceUdid).toBe(DEVICE_A);
  });

  it("boots the device again for an agent attachment made during the shutdown", async () => {
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);

    const attached = manager.attach(THREAD_A, DEVICE_A, "agent");
    await settle();
    release();
    await attached;

    expect(backend.callsOfKind("boot")).toHaveLength(2);
    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBe(DEVICE_A);
  });

  it("fails the waiting call, and drops its attachment, when the device cannot come back", async () => {
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);
    backend.failNext("boot", new DeviceBackendError("boot refused"));

    const input = manager.tap(DEVICE_A, 7, 7);
    const attached = manager.attach(THREAD_A, DEVICE_A);
    const inputFailed = expect(input).rejects.toThrow("boot refused");
    const attachFailed = expect(attached).rejects.toThrow("boot refused");
    await settle();
    release();
    await inputFailed;
    await attachFailed;

    const state = await manager.getThreadState(THREAD_A);
    expect(state.attachedDeviceUdid).toBeNull();
    expect(state.attachPhase).toBeNull();
    expect(state.lastError).toBe("boot refused");
    expect(backend.callsOfKind("tap")).toHaveLength(1);
  });

  it("abandons an idle shutdown when a viewer arrives during stream teardown", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    // An agent attachment streams with nobody watching, and holds nothing.
    await manager.attach(THREAD_A, DEVICE_A, "agent");
    await settle();
    expect(backend.hasStream(DEVICE_A)).toBe(true);
    const detaching = deferred();
    const finishDetach = deferred();
    const detachStream = backend.detachStream.bind(backend);
    backend.detachStream = async (udid) => {
      detaching.resolve();
      await finishDetach.promise;
      await detachStream(udid);
    };

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);
    await detaching.promise;
    const unsubscribe = manager.subscribeFrames(DEVICE_A, SINK);
    const tapped = manager.tapElement(DEVICE_A, { label: "Fake Toggle" });
    finishDetach.resolve();
    // A shutdown that never happened must not make the tap stale.
    await expect(tapped).resolves.toMatchObject({ node: { label: "Fake Toggle" } });
    await settle();

    expect(shutdowns(backend)).toEqual([]);
    expect(backend.hasStream(DEVICE_A)).toBe(true);
    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBe(DEVICE_A);
    unsubscribe();
  });

  it("releases a removed thread's holds and attachment", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await agentTaps(manager, THREAD_A, DEVICE_A);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);

    await manager.handleThreadRemoved(THREAD_A);
    // The removed thread's turn is forgotten, so a late Agent Control hold holds nothing.
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, async () => undefined);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("attaches nothing for agent work that finishes after its thread was removed", async () => {
    const { manager } = makeManager();
    await manager.boot(DEVICE_A);
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await manager.handleThreadRemoved(THREAD_A);

    // A tap that was running when the thread went away surfaces its device now.
    await manager.surfaceDeviceForAgent(THREAD_A, DEVICE_A, "agent-tool");
    await settle();
    expect(manager.attachedThreadIds(DEVICE_A)).toEqual([]);

    // Restored and running again: its agent's device is surfaced as before.
    manager.observeThreadTurn(THREAD_A, "turn-2");
    await manager.surfaceDeviceForAgent(THREAD_A, DEVICE_A, "agent-tool");
    await settle();
    expect(manager.attachedThreadIds(DEVICE_A)).toEqual([THREAD_A]);
  });

  it("forgets the turn of a removed thread that never had a device record", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await manager.handleThreadRemoved(THREAD_A);
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, () => manager.boot(DEVICE_A));

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("never starts the grace from a boot alone", async () => {
    // The SSH device host's manager only boots and shuts down: a boot-time
    // timer there would power off devices the coding node is still using.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);

    expect(shutdowns(backend)).toEqual([]);
  });

  it("finishes an issued idle shutdown before disposing the rest", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_B);
    const release = await issueHeldIdleShutdown(manager, backend);

    const disposing = manager.dispose();
    await settle();
    expect(shutdowns(backend)).toEqual([DEVICE_A]);
    release();
    await disposing;

    expect(shutdowns(backend)).toEqual([DEVICE_A, DEVICE_B]);
  });

  it.each(["boot first", "tap first"] as const)(
    "shares one boot between a pane boot and input that wait on the shutdown (%s)",
    { timeout: 2_000 },
    async (order) => {
      const { backend, manager } = makeManager();
      const release = await issueHeldIdleShutdown(manager, backend);

      let booting: ReturnType<DeviceManager["boot"]>;
      let tapping: Promise<void>;
      if (order === "boot first") {
        booting = manager.boot(DEVICE_A);
        tapping = manager.tap(DEVICE_A, 7, 7);
      } else {
        tapping = manager.tap(DEVICE_A, 7, 7);
        booting = manager.boot(DEVICE_A);
      }
      await settle();
      expect(backend.callsOfKind("boot")).toHaveLength(1);
      release();

      expect((await booting).kind).toBe("booted");
      await tapping;
      expect(backend.callsOfKind("boot")).toHaveLength(2);
      expect(lifecycle(backend).slice(-3)).toEqual(["shutdown", "boot", "tap"]);
    },
  );

  it("holds an Agent Control boot for the running turn of a thread with no device record", async () => {
    const { backend, manager } = makeManager();
    manager.observeThreadTurn(THREAD_A, "turn-1");
    const booted = await manager.holdForAgentTurn(THREAD_A, DEVICE_A, () => manager.boot(DEVICE_A));
    expect(booted.kind).toBe("booted");

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);
    expect(shutdowns(backend)).toEqual([]);
    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("never downgrades a person's attachment to an agent's", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    // An approved Agent Control attach on the device the user already picked.
    await manager.attach(THREAD_A, DEVICE_A, "agent");

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);

    expect(shutdowns(backend)).toEqual([]);
  });

  it("lets the grace start while only an agent attachment remains", async () => {
    // Main returned early while any thread was attached, so an agent's
    // attachment on another thread kept the device up forever.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A, "agent");
    await manager.detach(THREAD_A);

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });
});

describe("DeviceManager idle release edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches and surfaces the device again when the agent uses it after an idle shutdown", async () => {
    const { backend, manager } = makeManager();
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "device.open-pane-requested") openRequests.push(event.udid);
    });
    const agentTapsAndSurfaces = () =>
      manager.withAgentActivity(
        THREAD_A,
        async () => {
          await manager.tap(DEVICE_A, 1, 1);
          await manager.surfaceDeviceForAgent(THREAD_A, DEVICE_A, "agent-tool");
        },
        { udid: DEVICE_A },
      );
    manager.observeThreadTurn(THREAD_A, "turn-1");
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, () => manager.boot(DEVICE_A));
    await agentTapsAndSurfaces();
    manager.observeThreadTurn(THREAD_A, null);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);
    expect(shutdowns(backend)).toEqual([DEVICE_A]);
    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBeNull();

    // A later turn boots the device without attaching (an Agent Control boot)
    // and drives it: the pane must show it again, not stay on the picker.
    manager.observeThreadTurn(THREAD_A, "turn-2");
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, () => manager.boot(DEVICE_A));
    await agentTapsAndSurfaces();

    expect((await manager.getThreadState(THREAD_A)).attachedDeviceUdid).toBe(DEVICE_A);
    expect(openRequests).toEqual([DEVICE_A, DEVICE_A]);
    await manager.dispose();
  });

  it("forgets a recording whose stop failed, so the grace can start", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.startRecording(DEVICE_A);
    backend.failNext("stopRecording", new DeviceBackendError("Device FAKE-0001 is not recording"));

    await expect(manager.stopRecording(DEVICE_A)).rejects.toThrow("not recording");
    expect(manager.isRecording(DEVICE_A)).toBe(false);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("leaves a recording running when a thread is removed while a person on another thread watches", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A);
    await manager.startRecording(DEVICE_A);

    await manager.handleThreadRemoved(THREAD_A);
    expect(backend.callsOfKind("stopRecording")).toEqual([]);
    expect(manager.isRecording(DEVICE_A)).toBe(true);

    // The watching person's own detach still ends it, as before.
    await manager.detach(THREAD_B);
    expect(backend.callsOfKind("stopRecording").map((call) => call.udid)).toEqual([DEVICE_A]);
    await manager.dispose();
  });

  it("stops the recording when a removed thread leaves only an agent attachment", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    await manager.attach(THREAD_B, DEVICE_A, "agent");
    await manager.startRecording(DEVICE_A);

    await manager.handleThreadRemoved(THREAD_A);

    expect(backend.callsOfKind("stopRecording").map((call) => call.udid)).toEqual([DEVICE_A]);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);
    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("lets an explicit shutdown defer to an idle shutdown already with simctl", async () => {
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);

    const explicit = manager.shutdown(DEVICE_A);
    await settle();
    release();
    await explicit;
    await settle();

    // One simctl shutdown, not a second one racing the first.
    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("resumes a pane label tap that arrives while simctl shuts the device down", async () => {
    // The restoration boot does not change the device's lifecycle generation,
    // so the operation guard taken before the wait still holds.
    const { backend, manager } = makeManager();
    const release = await issueHeldIdleShutdown(manager, backend);

    const tapped = manager.tapElement(DEVICE_A, { label: "Fake Toggle" });
    await settle();
    release();

    await expect(tapped).resolves.toMatchObject({ node: { label: "Fake Toggle" } });
    expect(backend.callsOfKind("boot")).toHaveLength(2);
  });

  it("does not hold an action that opts out of a turn starting while it runs", async () => {
    // An approved Agent Control action can execute after its turn ended.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    const finish = deferred();
    const call = manager.withAgentActivity(THREAD_A, () => finish.promise, {
      udid: DEVICE_A,
      joinLateTurn: false,
    });
    manager.observeThreadTurn(THREAD_A, "turn-2");
    finish.resolve();
    await call;

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("holds an approved boot only for the turn running when it started", async () => {
    const { backend, manager } = makeManager();
    await manager.holdForAgentTurn(THREAD_A, DEVICE_A, async () => {
      const result = await manager.boot(DEVICE_A);
      // The user starts a new turn while the approved boot is still running.
      manager.observeThreadTurn(THREAD_A, "turn-2");
      return result;
    });

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });

  it("never starts the grace from a refused explicit shutdown", async () => {
    // The SSH device host's manager only boots and shuts down: a timer armed
    // there would later power off a device the coding node is still using.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    backend.failNext("shutdown", new DeviceBackendError("simctl refused"));

    await expect(manager.shutdown(DEVICE_A)).rejects.toThrow("simctl refused");
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS * 3);

    expect(shutdowns(backend)).toEqual([]);
  });

  it("tries an idle shutdown again a grace later when simctl refuses it", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.tap(DEVICE_A, 1, 1);
    backend.failNext("shutdown", new DeviceBackendError("simctl refused"));

    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);
    // The refused call is not recorded by the fake.
    expect(shutdowns(backend)).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEVICE_IDLE_SHUTDOWN_MS + 1);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
  });
});

describe("DeviceManager idle release on a device switch", () => {
  it("shuts the old device down at once although its frame socket is still open", async () => {
    // The pane closes the old device's frame socket only after the attach
    // resolves; counting that viewer would turn every switch into a grace.
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.boot(DEVICE_B);
    await manager.attach(THREAD_A, DEVICE_A);
    const unsubscribe = manager.subscribeFrames(DEVICE_A, SINK);

    await manager.attach(THREAD_A, DEVICE_B);

    expect(shutdowns(backend)).toEqual([DEVICE_A]);
    unsubscribe();
  });

  it("keeps the old device up while an agent call is still using it", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    await manager.boot(DEVICE_B);
    await manager.attach(THREAD_A, DEVICE_A);
    const finish = deferred();
    const call = manager.withAgentActivity(THREAD_B, () => finish.promise, { udid: DEVICE_A });

    await manager.attach(THREAD_A, DEVICE_B);
    expect(shutdowns(backend)).toEqual([]);
    finish.resolve();
    await call;
    await manager.dispose();
  });
});
