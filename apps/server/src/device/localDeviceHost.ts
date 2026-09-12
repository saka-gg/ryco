import { runProcess } from "../processRunner.ts";
import { AndroidEmulatorBackend } from "./AndroidEmulatorBackend.ts";
import { PlatformDeviceBackend } from "./PlatformDeviceBackend.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";
import type { DeviceHostBackend } from "./HostDeviceBackend.ts";

/** Per-device helpers share the compiled binary, never their live attachment. */
export function shareDeviceHelperBuilds(run: typeof runProcess): typeof runProcess {
  const builds = new Map<string, ReturnType<typeof runProcess>>();
  return (command, args, options) => {
    if (command !== "/bin/sh" || !args[0]?.endsWith("/build.sh") || !args[1]) {
      return run(command, args, options);
    }
    // The backend's output directory incorporates the Xcode/source cache key.
    const key = JSON.stringify([args[0], args[1]]);
    const existing = builds.get(key);
    if (existing) return existing;
    const build = run(command, args, options).finally(() => builds.delete(key));
    builds.set(key, build);
    return build;
  };
}

export function localDeviceHost(platform: NodeJS.Platform = process.platform): DeviceHostBackend {
  const run = shareDeviceHelperBuilds(runProcess);
  // Keep one Android adapter: SDK failures, transport identities and ownership
  // must stay pinned across discovery and sequential calls on all factory instances.
  const android = new AndroidEmulatorBackend({ platform });
  const makeBackend = () =>
    new PlatformDeviceBackend(new IosSimulatorBackend({ platform, run }), android);
  return {
    host: { id: "local", name: "This node", transport: "local" },
    backend: makeBackend(),
    createDeviceBackend: makeBackend,
  };
}
