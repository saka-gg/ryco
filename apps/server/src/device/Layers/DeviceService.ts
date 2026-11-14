/**
 * DeviceServiceLive - one DeviceManager for the server process.
 *
 * The manager exists on every platform so no caller has to branch on `null`;
 * local iOS/Android adapters and configured SSH hosts share its lifecycle
 * and authorization surface.
 *
 * @module device/Layers/DeviceService
 */
import { Effect, Layer } from "effect";
import * as path from "node:path";

import { resolveRycoBaseDir } from "../../os-jank.ts";
import { makeBootOwnershipStore, NULL_BOOT_OWNERSHIP } from "../bootOwnership.ts";
import { DEVICE_SSH_HOST_LIMIT, type DeviceSshHost } from "@ryco/contracts";

import { HostDeviceBackend, type DeviceHostBackend } from "../HostDeviceBackend.ts";
import { readDeviceHostConfig, sshDeviceHostId } from "../deviceHostConfig.ts";
import { DeviceManager } from "../DeviceManager.ts";
import { localDeviceHost } from "../localDeviceHost.ts";
import { DeviceService, type DeviceServiceShape } from "../Services/DeviceService.ts";
import {
  installProcessDeviceToolGateway,
  startDeviceToolGateway,
} from "../../providerTools/deviceToolGateway.ts";

export interface DeviceServiceLiveOptions {
  readonly platform?: NodeJS.Platform;
  readonly hostsFile?: string;
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
  const baseDir = resolveRycoBaseDir(process.env.RYCO_HOME);
  const stateDir = path.join(baseDir, process.env.VITE_DEV_SERVER_URL ? "dev" : "userdata");
  return path.join(stateDir, "device-boot-ownership.json");
}

/**
 * Routing entries for SSH hosts, deduplicated by identity and capped. Only a
 * node with a configured SSH host loads its backend and the host protocol.
 */
async function sshHostEntries(
  configs: readonly { readonly config: DeviceSshHost; readonly source: "settings" | "file" }[],
): Promise<DeviceHostBackend[]> {
  if (configs.length === 0) return [];
  const { SshDeviceBackend } = await import("../SshDeviceBackend.ts");
  const seen = new Set<string>();
  const entries: DeviceHostBackend[] = [];
  for (const { config, source } of configs) {
    const id = sshDeviceHostId(config);
    if (seen.has(id) || entries.length >= DEVICE_SSH_HOST_LIMIT) continue;
    seen.add(id);
    entries.push({
      host: { id, name: config.name, transport: "ssh", source },
      backend: new SshDeviceBackend(config),
    });
  }
  return entries;
}

export function makeDeviceServiceLayer(
  options: DeviceServiceLiveOptions = {},
): Layer.Layer<DeviceService> {
  return Layer.effect(
    DeviceService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const hosts = yield* Effect.promise(() =>
        readDeviceHostConfig(options.hostsFile ?? process.env.RYCO_DEVICE_HOSTS_FILE),
      );
      const supported = ["darwin", "linux", "win32"].includes(platform) || hosts.length > 0;
      const sshHosts = yield* Effect.promise(() =>
        sshHostEntries(hosts.map((config) => ({ config, source: "file" as const }))),
      );
      const backend = new HostDeviceBackend([localDeviceHost(platform), ...sshHosts]);
      // Settings hosts join the file's; the file's win a tie, being the same destination.
      let configuring: Promise<void> = Promise.resolve();
      const configureSshHosts = (settingsHosts: readonly DeviceSshHost[]) => {
        const next = configuring.then(async () => {
          const fileIds = new Set(hosts.map(sshDeviceHostId));
          const entries = await sshHostEntries([
            ...hosts.map((config) => ({ config, source: "file" as const })),
            ...settingsHosts
              .filter((config) => !fileIds.has(sshDeviceHostId(config)))
              .map((config) => ({ config, source: "settings" as const })),
          ]);
          await backend.setRemoteHosts(entries);
        });
        configuring = next.catch(() => undefined);
        return next;
      };
      // Local boots are recovered here; SSH workers recover their own boots on the Mac.
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
      return { supported, manager, configureSshHosts } satisfies DeviceServiceShape;
    }),
  );
}

export const DeviceServiceLive = makeDeviceServiceLayer();
