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
  /** Where to copy the run's screenshot (absolute), for a PR or a report. */
  readonly screenshotOut: string | undefined;
  /** Skip the check that buttons, touches and keys reach the guest. */
  readonly skipInputCheck: boolean;
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

const VALUE_FLAGS = new Set(["--cache-dir", "--udid", "--screenshot-out"]);
const SWITCH_FLAGS = new Set(["--probe-only", "--allow-booted", "--skip-input-check"]);

/**
 * Strict on purpose: an argument this parser does not understand fails the
 * run. Ignoring it would turn a typo or `--udid=<udid>` style it did not
 * accept into the developer default, which drives whatever simulator is
 * already booted. Both `--flag value` and `--flag=value` are accepted.
 */
export function parseSmokeOptions(argv: readonly string[]): SmokeResult<SmokeOptions> {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const flag = equals > 0 ? argument.slice(0, equals) : argument;
    if (VALUE_FLAGS.has(flag)) {
      let value: string | undefined;
      if (equals > 0) {
        value = argument.slice(equals + 1);
      } else {
        index += 1;
        value = argv[index];
      }
      if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
        return { ok: false, error: `${flag} needs a value` };
      }
      if (values.has(flag)) return { ok: false, error: `${flag} was given more than once` };
      values.set(flag, value);
    } else if (SWITCH_FLAGS.has(flag)) {
      if (equals > 0) return { ok: false, error: `${flag} takes no value` };
      switches.add(flag);
    } else {
      return {
        ok: false,
        error: `unknown argument '${argument}' (expected --probe-only, --cache-dir <dir>, --udid <udid>, --allow-booted, --screenshot-out <path>, --skip-input-check)`,
      };
    }
  }
  const cacheDir = values.get("--cache-dir");
  const udid = values.get("--udid");
  const screenshotOut = values.get("--screenshot-out");
  const allowBooted = switches.has("--allow-booted");
  if (allowBooted && udid === undefined) {
    return { ok: false, error: "--allow-booted only applies together with --udid" };
  }
  return {
    ok: true,
    value: {
      probeOnly: switches.has("--probe-only"),
      cacheRoot: cacheDir === undefined ? undefined : resolve(cacheDir),
      udid,
      allowBooted,
      screenshotOut: screenshotOut === undefined ? undefined : resolve(screenshotOut),
      skipInputCheck: switches.has("--skip-input-check"),
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
