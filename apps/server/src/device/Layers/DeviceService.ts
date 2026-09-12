/**
 * DeviceServiceLive - one DeviceManager for the server process.
 *
 * The manager exists on every platform so no caller has to branch on `null`;
 * iOS and Android adapters share its lifecycle and authorization. Tooling
 * availability is reported by each adapter; host support gates the surface.
 *
 * @module device/Layers/DeviceService
 */
import { Effect, Layer } from "effect";
import { homedir } from "node:os";
import * as path from "node:path";

import { makeBootOwnershipStore, NULL_BOOT_OWNERSHIP } from "../bootOwnership.ts";
import { AndroidEmulatorBackend } from "../AndroidEmulatorBackend.ts";
import { PlatformDeviceBackend } from "../PlatformDeviceBackend.ts";
import { DeviceManager } from "../DeviceManager.ts";
import { IosSimulatorBackend } from "../IosSimulatorBackend.ts";
import { DeviceService, type DeviceServiceShape } from "../Services/DeviceService.ts";
import {
  installProcessDeviceToolGateway,
  startDeviceToolGateway,
} from "../../providerTools/deviceToolGateway.ts";

export interface DeviceServiceLiveOptions {
  readonly platform?: NodeJS.Platform;
  /** Where to remember this run's boots; omit to remember nothing. */
  readonly bootOwnershipPath?: string;
}

/**
 * Where the boot record lives, derived the way the server derives its state
 * directory so both land in the same place under a custom RYCO_HOME.
 *
 * Resolved here rather than taken from ServerConfig because this layer is built
 * before that config is in scope, and getting the path wrong only costs the
 * crash-recovery, not the feature.
 */
function defaultBootOwnershipPath(): string {
  const baseDir = process.env.RYCO_HOME?.trim() || path.join(homedir(), ".ryco");
  const stateDir = path.join(baseDir, process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
  return path.join(stateDir, "device-boot-ownership.json");
}

export function makeDeviceServiceLayer(
  options: DeviceServiceLiveOptions = {},
): Layer.Layer<DeviceService> {
  return Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const supported = ["darwin", "linux", "win32"].includes(platform);
      const backend = new PlatformDeviceBackend(
        new IosSimulatorBackend({ platform }),
        new AndroidEmulatorBackend({ platform }),
      );
      // Both adapters share one persistent boot ownership record.
      const bootOwnership = supported
        ? makeBootOwnershipStore(options.bootOwnershipPath ?? defaultBootOwnershipPath())
        : NULL_BOOT_OWNERSHIP;
      const manager = new DeviceManager({ backend, bootOwnership });
      const toolGateway = supported
        ? yield* Effect.promise(() => startDeviceToolGateway(manager))
        : null;
      installProcessDeviceToolGateway(toolGateway);

      // A previous run that crashed left its simulators booted and no longer
      // owned by anyone: reclaim them before this run starts counting boots,
      // or they linger forever outside the cap and the idle sweep.
      if (supported) {
        yield* Effect.promise(async () => {
          const reclaimed = await manager.reclaimOrphanedBoots().catch(() => []);
          if (reclaimed.length > 0) {
            console.info(
              `[device] shut down ${reclaimed.length} simulator(s) left booted by a previous ` +
                `Ryco run: ${reclaimed.join(", ")}`,
            );
          }
        });
      }

      // App quit shuts down every simulator Ryco booted and leaves the
      // user's own devices running.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          installProcessDeviceToolGateway(null);
          await toolGateway?.close().catch(() => undefined);
          await manager.dispose();
        }),
      );
      return { supported, manager } satisfies DeviceServiceShape;
    }),
  );
}

export const DeviceServiceLive = makeDeviceServiceLayer();
