// Flag parsing and simulator selection for scripts/device-helper-smoke.ts.
//
// Kept apart from the smoke itself (which boots simulators and spawns the
// helper) so the rule that matters on a shared Mac is unit tested: with
// `--udid` the smoke drives only a simulator it boots itself.

import { resolve } from "node:path";

export interface SmokeOptions {
  readonly probeOnly: boolean;
  /** Parent of the per-key build directory; the user cache when undefined. */
  readonly cacheRoot: string | undefined;
  readonly udid: string | undefined;
  readonly allowBooted: boolean;
}

export interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
}

export interface DeviceChoice {
  readonly device: SimctlDevice;
  /** Booted before this run; the smoke then neither boots nor shuts it down. */
  readonly wasBooted: boolean;
}

export type SmokeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const PREFERRED_DEVICES = ["iPhone 17 Pro", "iPhone 16 Pro", "iPhone 15 Pro", "iPhone"];

export function parseSmokeOptions(argv: readonly string[]): SmokeResult<SmokeOptions> {
  const values = new Map<string, string>();
  for (const flag of ["--cache-dir", "--udid"]) {
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      return { ok: false, error: `${flag} needs a value` };
    }
    values.set(flag, value);
  }
  const cacheDir = values.get("--cache-dir");
  const udid = values.get("--udid");
  const allowBooted = argv.includes("--allow-booted");
  if (allowBooted && udid === undefined) {
    return { ok: false, error: "--allow-booted only applies together with --udid" };
  }
  return {
    ok: true,
    value: {
      probeOnly: argv.includes("--probe-only"),
      cacheRoot: cacheDir === undefined ? undefined : resolve(cacheDir),
      udid,
      allowBooted,
    },
  };
}

/**
 * With `--udid`: exactly that simulator, and only while it is shut down (this
 * run boots it) unless `--allow-booted` permits reusing a booted one. A
 * simulator mid-boot or mid-shutdown belongs to someone else and is refused.
 *
 * Without `--udid` (a developer's own machine): reuse a booted simulator,
 * else boot a preferred one.
 */
export function selectSmokeSimulator(
  devices: readonly SimctlDevice[],
  options: Pick<SmokeOptions, "udid" | "allowBooted">,
): SmokeResult<DeviceChoice> {
  const { udid } = options;
  if (udid !== undefined) {
    const device = devices.find((candidate) => candidate.udid === udid);
    if (!device) return { ok: false, error: `no available iOS simulator with udid ${udid}` };
    if (device.state === "Booted") {
      return options.allowBooted
        ? { ok: true, value: { device, wasBooted: true } }
        : {
            ok: false,
            error: `simulator ${udid} is already booted; refusing to drive a simulator this run did not boot (pass --allow-booted to reuse it)`,
          };
    }
    if (device.state !== "Shutdown") {
      return {
        ok: false,
        error: `simulator ${udid} is ${device.state}; refusing to drive a simulator this run did not boot`,
      };
    }
    return { ok: true, value: { device, wasBooted: false } };
  }

  const booted = devices.find((device) => device.state === "Booted");
  if (booted) return { ok: true, value: { device: booted, wasBooted: true } };
  for (const preferred of PREFERRED_DEVICES) {
    const match = devices.find((device) => device.name.startsWith(preferred));
    if (match) return { ok: true, value: { device: match, wasBooted: false } };
  }
  const fallback = devices[0];
  if (fallback) return { ok: true, value: { device: fallback, wasBooted: false } };
  return {
    ok: false,
    error: "no available iOS simulators; install a runtime in Xcode Settings > Components",
  };
}
