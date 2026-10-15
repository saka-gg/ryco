import type { DeviceEvent, EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { DeviceRpcClient } from "../../rpc/deviceRpcClient.ts";
import {
  bindDeviceConnection,
  DEVICE_RUNTIME_IDLE_MS,
  ensureDeviceRuntime,
  isDeviceRuntimeBound,
  registerDeviceConnection,
  resetDeviceRuntimeForTests,
} from "./runtime.ts";
import { useDeviceStateStore } from "./store.ts";

function fakeDeviceClient() {
  let resubscribe: (() => void) | undefined;
  const list = vi.fn(async () => ({
    devices: [],
    availability: { kind: "available" as const },
  }));
  const onEvent = vi.fn((_listener: unknown, options?: { readonly onResubscribe?: () => void }) => {
    resubscribe = options?.onResubscribe;
    return () => undefined;
  });
  const client = { list, onEvent } as unknown as DeviceRpcClient;
  return { client, list, onEvent, resubscribe: () => resubscribe?.() };
}

describe("bindDeviceConnection", () => {
  it("listens for device events on connect without listing devices", () => {
    const device = fakeDeviceClient();
    const binding = bindDeviceConnection("env-device-lazy" as EnvironmentId, device.client);

    // An agent may ask for the device pane at any time, so the event stream
    // starts now; listing runs simctl on the server, so it waits for a surface.
    expect(device.onEvent).toHaveBeenCalledOnce();
    expect(device.list).not.toHaveBeenCalled();
    binding.dispose();
  });

  it("starts a new generation on resubscribe and reconnect without listing devices", () => {
    const environmentId = "env-device-generation" as EnvironmentId;
    const device = fakeDeviceClient();
    const binding = bindDeviceConnection(environmentId, device.client);
    const generation = () =>
      useDeviceStateStore.getState().environmentById[environmentId]?.generation;
    const initial = generation();

    device.resubscribe();
    const resubscribed = generation();
    binding.reconnecting();

    // The simulator pane lists on mount and on each generation change.
    expect(resubscribed).toBe((initial ?? 0) + 1);
    expect(generation()).toBe((resubscribed ?? 0) + 1);
    expect(device.list).not.toHaveBeenCalled();
    binding.dispose();
  });
});

describe("ensureDeviceRuntime", () => {
  afterEach(() => {
    resetDeviceRuntimeForTests();
    vi.useRealTimers();
  });

  it("starts nothing for a connection until a device surface retains it", () => {
    const environmentId = "env-device-retain" as EnvironmentId;
    const device = fakeDeviceClient();
    const registration = registerDeviceConnection(environmentId, device.client);

    // A connection alone opens no device stream (and so no device socket).
    expect(device.onEvent).not.toHaveBeenCalled();
    expect(isDeviceRuntimeBound(environmentId)).toBe(false);

    const release = ensureDeviceRuntime(environmentId);
    expect(device.onEvent).toHaveBeenCalledOnce();
    expect(isDeviceRuntimeBound(environmentId)).toBe(true);
    // A second surface shares the same stream.
    const releaseSecond = ensureDeviceRuntime(environmentId);
    expect(device.onEvent).toHaveBeenCalledOnce();
    release();
    releaseSecond();
    registration.dispose();
    expect(isDeviceRuntimeBound(environmentId)).toBe(false);
  });

  it("binds a connection that registers while a surface already retains it", () => {
    const environmentId = "env-device-late-connection" as EnvironmentId;
    const release = ensureDeviceRuntime(environmentId);
    const device = fakeDeviceClient();
    const registration = registerDeviceConnection(environmentId, device.client);
    expect(device.onEvent).toHaveBeenCalledOnce();
    release();
    registration.dispose();
  });

  it("stops the stream once nothing retains it for the idle period", () => {
    vi.useFakeTimers();
    const environmentId = "env-device-idle" as EnvironmentId;
    const unsubscribe = vi.fn();
    const device = fakeDeviceClient();
    device.onEvent.mockImplementation(() => unsubscribe);
    const registration = registerDeviceConnection(environmentId, device.client);

    ensureDeviceRuntime(environmentId)();
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS - 1);
    // Coming back within the grace period keeps the same stream.
    const release = ensureDeviceRuntime(environmentId);
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS * 2);
    expect(unsubscribe).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(isDeviceRuntimeBound(environmentId)).toBe(false);

    // A later surface binds again.
    ensureDeviceRuntime(environmentId);
    expect(device.onEvent).toHaveBeenCalledTimes(2);
    registration.dispose();
  });

  it("keeps a delivered pane request across an idle stop, but not past the connection", () => {
    vi.useFakeTimers();
    const environmentId = "env-device-open-request" as EnvironmentId;
    const threadId = "thread-device-open-request" as ThreadId;
    let deliver: ((event: DeviceEvent) => void) | undefined;
    const device = fakeDeviceClient();
    device.onEvent.mockImplementation((listener: unknown) => {
      deliver = listener as (event: DeviceEvent) => void;
      return () => undefined;
    });
    const registration = registerDeviceConnection(environmentId, device.client);
    const request = {
      type: "device.open-pane-requested",
      threadId,
      udid: "SIM-1",
      reason: "agent-tool",
    } as const;

    // A thread view of another thread keeps the stream; the agent asks for this one.
    ensureDeviceRuntime(environmentId)();
    deliver?.(request);
    // The user stays away past the idle period: the stream stops, the request
    // waits for the user to open its thread.
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS);
    expect(isDeviceRuntimeBound(environmentId)).toBe(false);
    expect(useDeviceStateStore.getState().consumeOpenRequest(environmentId, threadId)).toEqual(
      request,
    );

    // A disposed connection takes its requests with it.
    const release = ensureDeviceRuntime(environmentId);
    deliver?.(request);
    registration.dispose();
    release();
    expect(useDeviceStateStore.getState().consumeOpenRequest(environmentId, threadId)).toBeNull();
  });

  it("drops pane requests kept across an idle stop once their connection ends", () => {
    vi.useFakeTimers();
    const environmentId = "env-device-idle-dispose" as EnvironmentId;
    const threadId = "thread-device-idle-dispose" as ThreadId;
    const request = {
      type: "device.open-pane-requested",
      threadId,
      udid: "SIM-1",
      reason: "agent-tool",
    } as const;
    const deliverOn = (device: ReturnType<typeof fakeDeviceClient>) => {
      let deliver: ((event: DeviceEvent) => void) | undefined;
      device.onEvent.mockImplementation((listener: unknown) => {
        deliver = listener as (event: DeviceEvent) => void;
        return () => undefined;
      });
      return (event: DeviceEvent) => deliver?.(event);
    };
    const older = fakeDeviceClient();
    const olderRegistration = registerDeviceConnection(environmentId, older.client);
    const first = fakeDeviceClient();
    const deliverFirst = deliverOn(first);
    const firstRegistration = registerDeviceConnection(environmentId, first.client);

    ensureDeviceRuntime(environmentId)();
    deliverFirst(request);
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS);
    expect(isDeviceRuntimeBound(environmentId)).toBe(false);
    // An earlier connection ending does not take the current one's requests.
    olderRegistration.dispose();
    expect(useDeviceStateStore.getState().pendingOpenByThreadKey).not.toEqual({});
    // The environment is removed while the stream is idle.
    firstRegistration.dispose();
    expect(useDeviceStateStore.getState().consumeOpenRequest(environmentId, threadId)).toBeNull();

    // A replacing connection ends the idle one's requests the same way.
    const second = fakeDeviceClient();
    const deliverSecond = deliverOn(second);
    const secondRegistration = registerDeviceConnection(environmentId, second.client);
    ensureDeviceRuntime(environmentId)();
    deliverSecond(request);
    vi.advanceTimersByTime(DEVICE_RUNTIME_IDLE_MS);
    const third = registerDeviceConnection(environmentId, fakeDeviceClient().client);
    expect(useDeviceStateStore.getState().consumeOpenRequest(environmentId, threadId)).toBeNull();
    third.dispose();
    secondRegistration.dispose();
  });

  it("hands the stream back to a still-live connection when the newer one is disposed", () => {
    const environmentId = "env-device-overlap" as EnvironmentId;
    const release = ensureDeviceRuntime(environmentId);
    const live = fakeDeviceClient();
    const liveRegistration = registerDeviceConnection(environmentId, live.client);
    const candidate = fakeDeviceClient();
    const candidateRegistration = registerDeviceConnection(environmentId, candidate.client);
    expect(candidate.onEvent).toHaveBeenCalledOnce();

    candidateRegistration.dispose();
    expect(live.onEvent).toHaveBeenCalledTimes(2);
    expect(isDeviceRuntimeBound(environmentId)).toBe(true);
    release();
    liveRegistration.dispose();
  });
});
