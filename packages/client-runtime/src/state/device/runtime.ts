import type { EnvironmentId } from "@ryco/contracts";

import type { DeviceRpcClient } from "../../rpc/deviceRpcClient.ts";
import { useDeviceStateStore } from "./store.ts";

export interface DeviceConnectionBinding {
  readonly reconnecting: () => void;
  readonly dispose: () => void;
}

/**
 * Owns one environment's device event stream and its generation. Stream events
 * carry the generation current when they arrive, so a replaced connection can
 * never publish state into the new environment session.
 *
 * The event stream starts with the connection, because an agent can ask for
 * the device pane at any time. The inventory is not read here: listing devices
 * runs `xcrun simctl` / `adb` on the server, so the simulator pane lists on
 * mount and again whenever the generation changes, never on every connect.
 */
export function bindDeviceConnection(
  environmentId: EnvironmentId,
  client: DeviceRpcClient,
): DeviceConnectionBinding {
  let active = true;
  let generation = useDeviceStateStore.getState().beginConnection(environmentId);
  const store = () => useDeviceStateStore.getState();

  const unsubscribe = client.onEvent(
    (event) => {
      if (active) store().applyEvent(environmentId, generation, event);
    },
    {
      onResubscribe: () => {
        if (!active) return;
        generation = store().beginConnection(environmentId);
      },
      onError: () => {
        if (active) {
          store().markConnectionError(
            environmentId,
            generation,
            "Simulator event stream disconnected.",
          );
        }
      },
    },
  );
  return {
    reconnecting: () => {
      if (!active) return;
      generation = store().beginConnection(environmentId);
    },
    dispose: () => {
      if (!active) return;
      active = false;
      unsubscribe();
      store().clearEnvironment(environmentId, generation);
    },
  };
}
