import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import {
  DEVICE_SETUP_POLL_MS,
  devicesNeedSetupPoll,
} from "@ryco/client-runtime/state/device/picker";
import type {
  DevicePlatformAvailability,
  EnvironmentId,
  ThreadDeviceState,
  ThreadId,
} from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import { deviceErrorMessage } from "./devicePickerModel";
import { useThreadDevice } from "./useThreadDevice";

const NOOP = () => undefined;

/**
 * Every simulator and emulator the node can run, with the thread's device state, while the
 * Devices sheet shows them: read on open (as the web panel's Refresh does) and every few seconds
 * while the node's setup is still underway; boots and attachments arrive on the device event
 * stream `useThreadDevice` keeps. `apply` stores a state an action returned.
 */
export function useThreadDeviceInventory(environmentId: EnvironmentId, threadId: ThreadId) {
  const { api, threadState } = useThreadDevice(environmentId, threadId);
  const environmentState = useDeviceStateStore((state) => state.environmentById[environmentId]);
  const generation = environmentState === undefined ? null : environmentState.generation;
  const [platforms, setPlatforms] = useState<readonly DevicePlatformAvailability[] | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!api || generation === null) return Promise.resolve();
    return Promise.all([api.list({ includeShutdown: true }), api.getThreadState({ threadId })])
      .then(([listing, snapshot]) => {
        const store = useDeviceStateStore.getState();
        store.applyInventory(environmentId, generation, listing.devices, listing.availability);
        store.applyThreadSnapshot(environmentId, generation, snapshot);
        setPlatforms(listing.platforms);
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        setLoadError(deviceErrorMessage(cause, "The node did not list its devices."));
      });
  }, [api, environmentId, generation, threadId]);

  const availability = environmentState === undefined ? null : environmentState.availability;
  const needsPoll = devicesNeedSetupPoll(availability);
  useEffect(() => {
    void refresh().catch(NOOP);
    if (!needsPoll) return;
    const timer = setInterval(() => void refresh().catch(NOOP), DEVICE_SETUP_POLL_MS);
    return () => clearInterval(timer);
  }, [needsPoll, refresh]);

  const apply = useCallback(
    (snapshot: ThreadDeviceState) => {
      if (generation === null) return;
      useDeviceStateStore.getState().applyThreadSnapshot(environmentId, generation, snapshot);
    },
    [environmentId, generation],
  );

  return {
    api,
    threadState,
    environmentState: environmentState ?? null,
    availability: availability ?? threadState?.availability ?? null,
    platforms,
    loadError,
    refresh,
    apply,
  };
}
