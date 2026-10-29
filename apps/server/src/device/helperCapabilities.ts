/**
 * Parsing and interpretation of the device helper's `--probe` output.
 *
 * The helper reports each capability (framebuffer, hid, accessibility, encoder)
 * separately, because the private symbols behind them move independently
 * between Xcode releases. Keeping the parse and the availability mapping here —
 * away from process spawning — is what lets both be unit-tested against
 * synthetic probe payloads, including toolchains we cannot install.
 *
 * @module device/helperCapabilities
 */

import {
  DEVICE_CAPABILITY_LABELS,
  type DeviceAvailability,
  type DeviceCapabilityId,
  type DeviceCapabilityStatus,
  type DeviceToolchain,
} from "@ryco/contracts";

/** Every capability, in the order the pane should list them. */
export const DEVICE_CAPABILITY_IDS = [
  "framebuffer",
  "hid",
  "accessibility",
  "encoder",
] as const satisfies readonly DeviceCapabilityId[];

/**
 * How the helper delivers HID input: `dtuhid` (the guest's dtuhidd service,
 * CoreSimulator 1155.4+ / Xcode 27) or `indigo` (SimulatorKit's legacy
 * messages). Server-internal for now: logs and error messages only.
 */
export type HelperInputTransport = "dtuhid" | "indigo";

/** The helper's `inputTransport` field; anything else is unknown. */
export const parseHelperInputTransport = (value: unknown): HelperInputTransport | undefined =>
  value === "dtuhid" || value === "indigo" ? value : undefined;

export interface HelperProbeResult {
  readonly ok: boolean;
  readonly capabilities: readonly DeviceCapabilityStatus[];
  readonly toolchain: DeviceToolchain | undefined;
  /** A whole-helper failure (frameworks would not load, CoreSimulator unreachable). */
  readonly error: string | undefined;
  /** The transport `attach` will use on this host; absent from older helpers. */
  readonly inputTransport?: HelperInputTransport | undefined;
  /**
   * The host's CoreSimulator version. It is system-wide and installed by the
   * newest Xcode, so it can be newer than the selected Xcode, and it is what
   * picks the input transport.
   */
  readonly coreSimulatorVersion?: string | undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Diagnostics the probe reports next to the capabilities. */
const parseInputDiagnostics = (
  record: Record<string, unknown>,
): Pick<HelperProbeResult, "inputTransport" | "coreSimulatorVersion"> => ({
  inputTransport: parseHelperInputTransport(record["inputTransport"]),
  coreSimulatorVersion: asNonEmptyString(asRecord(record["toolchain"])?.["coreSimulatorVersion"]),
});

const parseToolchain = (value: unknown): DeviceToolchain | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const toolchain: DeviceToolchain = {
    xcodeVersion: asNonEmptyString(record["xcodeVersion"]),
    xcodeBuild: asNonEmptyString(record["xcodeBuild"]),
    macOS: asNonEmptyString(record["macOS"]),
  };
  return toolchain.xcodeVersion === undefined &&
    toolchain.xcodeBuild === undefined &&
    toolchain.macOS === undefined
    ? undefined
    : toolchain;
};

/**
 * One capability entry: `"ok"`, or an object naming what failed.
 *
 * An entry the helper did not report at all is treated as broken rather than
 * assumed working — an older helper that predates a capability genuinely cannot
 * provide it, and silently claiming otherwise would surface as a mystery
 * failure at the point of use.
 */
const parseCapability = (id: DeviceCapabilityId, raw: unknown): DeviceCapabilityStatus => {
  if (raw === "ok") return { id, ok: true };
  const record = asRecord(raw);
  if (!record) {
    return { id, ok: false, detail: "The device helper did not report this capability." };
  }
  return {
    id,
    ok: false,
    missingSymbol: asNonEmptyString(record["missingSymbol"]),
    detail: asNonEmptyString(record["error"]) ?? asNonEmptyString(record["purpose"]),
  };
};

/**
 * Parse `--probe` stdout. Never throws: a helper that emits garbage is a
 * degraded helper, and the pane must render that rather than crash.
 */
export const parseHelperProbe = (stdout: string): HelperProbeResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      ok: false,
      capabilities: DEVICE_CAPABILITY_IDS.map((id) => ({
        id,
        ok: false,
        detail: "The device helper preflight returned unreadable output.",
      })),
      toolchain: undefined,
      error: "The device helper preflight returned unreadable output.",
    };
  }

  const record = asRecord(parsed);
  if (!record) {
    return {
      ok: false,
      capabilities: DEVICE_CAPABILITY_IDS.map((id) => ({
        id,
        ok: false,
        detail: "The device helper preflight returned unreadable output.",
      })),
      toolchain: undefined,
      error: "The device helper preflight returned unreadable output.",
    };
  }

  const capabilitiesRecord = asRecord(record["capabilities"]);
  const error = asNonEmptyString(record["error"]);

  // A helper too old to report capabilities still answers `ok`. Trust that
  // rather than reporting four phantom breakages.
  if (!capabilitiesRecord) {
    const ok = record["ok"] === true;
    return {
      ok,
      capabilities: [],
      toolchain: parseToolchain(record["toolchain"]),
      error: ok ? undefined : (error ?? "The device helper preflight failed."),
      ...parseInputDiagnostics(record),
    };
  }

  const capabilities = DEVICE_CAPABILITY_IDS.map((id) =>
    parseCapability(id, capabilitiesRecord[id]),
  );

  return {
    ok: record["ok"] === true && capabilities.every((capability) => capability.ok),
    capabilities,
    toolchain: parseToolchain(record["toolchain"]),
    error,
    ...parseInputDiagnostics(record),
  };
};

/**
 * Map a probe onto the availability the pane renders, once setup is otherwise
 * complete.
 *
 * A capability failure is deliberately *not* `setup-required`: there is nothing
 * to install, so the pane opens and everything backed by a working capability
 * keeps working.
 */
export const availabilityFromProbe = (probe: HelperProbeResult): DeviceAvailability => {
  const broken = probe.capabilities.filter((capability) => !capability.ok);

  if (broken.length === 0) {
    // Frameworks that would not load at all leave no per-capability detail;
    // that is a helper failure, not a degraded one.
    if (!probe.ok && probe.error !== undefined) {
      return { kind: "helper-unavailable", message: probe.error };
    }
    return probe.capabilities.length > 0
      ? { kind: "available", capabilities: probe.capabilities, toolchain: probe.toolchain }
      : { kind: "available" };
  }

  // Everything broken means the helper is unusable, not partially usable.
  if (broken.length === probe.capabilities.length) {
    return {
      kind: "helper-unavailable",
      message: probe.error ?? describeBrokenCapabilities(broken, probe.toolchain),
    };
  }

  return { kind: "degraded", capabilities: probe.capabilities, toolchain: probe.toolchain };
};

/** Names the toolchain a failure was measured on, when the helper reported it. */
export const describeToolchain = (toolchain: DeviceToolchain | undefined): string => {
  if (!toolchain) return "";
  const version = toolchain.xcodeVersion;
  const build = toolchain.xcodeBuild;
  if (version && build) return `Xcode ${version} (${build})`;
  if (version) return `Xcode ${version}`;
  if (build) return `Xcode build ${build}`;
  return "";
};

/** A one-line summary of what is broken, for logs and error messages. */
export const describeBrokenCapabilities = (
  broken: readonly DeviceCapabilityStatus[],
  toolchain: DeviceToolchain | undefined,
): string => {
  const names = broken.map((capability) => DEVICE_CAPABILITY_LABELS[capability.id].toLowerCase());
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const where = describeToolchain(toolchain);
  return `${list} unavailable${where ? ` with ${where}` : ""}`;
};

/**
 * The error an operation raises when the capability behind it is broken.
 *
 * Names the capability and the Xcode it broke on, because the actionable fact
 * is "this Xcode moved a symbol", not "the call failed".
 */
export const capabilityUnavailableMessage = (
  capability: DeviceCapabilityStatus,
  toolchain: DeviceToolchain | undefined,
): string => {
  const label = DEVICE_CAPABILITY_LABELS[capability.id];
  const where = describeToolchain(toolchain);
  const symbol = capability.missingSymbol;
  const because = symbol
    ? ` The device helper could not resolve '${symbol}'.`
    : capability.detail
      ? ` ${capability.detail}`
      : "";
  return `${label} is unavailable${where ? ` with ${where}` : ""}.${because}`;
};
