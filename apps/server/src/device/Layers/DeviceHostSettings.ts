/**
 * DeviceHostSettingsLive - applies the SSH device hosts saved in the node's
 * settings (`deviceHosts`) to the device manager, at startup and on every
 * change, without a restart. Hosts from RYCO_DEVICE_HOSTS_FILE stay as well.
 *
 * Only a change of the host list reaches the manager: other settings changes
 * leave connected hosts alone.
 *
 * @module device/Layers/DeviceHostSettings
 */
import type { DeviceSshHost } from "@ryco/contracts";
import { Effect, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { DeviceService } from "../Services/DeviceService.ts";

export const DeviceHostSettingsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const { configureSshHosts } = yield* DeviceService;
    if (!configureSshHosts) return;
    const serverSettings = yield* ServerSettingsService;
    let applied: string | null = null;
    const apply = (hosts: readonly DeviceSshHost[]) =>
      Effect.promise(async () => {
        const key = JSON.stringify(hosts);
        if (key === applied) return;
        applied = key;
        await configureSshHosts(hosts).catch((error: unknown) => {
          console.warn(`[device] could not apply SSH device hosts: ${String(error)}`);
        });
      });
    // Subscribed before the read below, so a change made in between wins over the read.
    let changed = false;
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((settings) => {
        changed = true;
        return apply(settings.deviceHosts);
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    const initial = yield* serverSettings.getSettings.pipe(Effect.option);
    if (!changed && initial._tag === "Some") yield* apply(initial.value.deviceHosts);
  }),
);
