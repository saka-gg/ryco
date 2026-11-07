/**
 * DeviceToolAccessLive - keeps the device tool gateway's synchronous view of the "Use
 * simulators" and "Agents can use simulators" settings (`providerTools/deviceToolAccess.ts`)
 * in step with the node's settings.
 *
 * @module device/Layers/DeviceToolAccess
 */
import type { ServerSettings } from "@ryco/contracts";
import { Effect, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { setDeviceToolAccess } from "../../providerTools/deviceToolAccess.ts";

const publish = (settings: ServerSettings) =>
  Effect.sync(() =>
    setDeviceToolAccess({
      devicesEnabled: settings.devicesEnabled,
      agentDevicesEnabled: settings.agentDevicesEnabled,
    }),
  );

export const DeviceToolAccessLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    let changed = false;
    // Subscribed before the read below, so a change made in between wins over the read.
    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach((settings) => {
        changed = true;
        return publish(settings);
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
    // Unreadable settings keep the defaults (both on), as on a node without the settings.
    const initial = yield* serverSettings.getSettings.pipe(Effect.option);
    if (!changed && initial._tag === "Some") yield* publish(initial.value);
  }),
);
