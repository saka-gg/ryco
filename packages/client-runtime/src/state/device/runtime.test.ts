import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DeviceRpcClient } from "../../rpc/deviceRpcClient.ts";
import { bindDeviceConnection } from "./runtime.ts";
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
