/** Private inherited-pipe protocol. Never transported through renderer RPC. */
export interface DesktopResourceTelemetrySnapshot {
  readonly sampledAt: string;
  readonly processSample: boolean;
  readonly electronPid: number;
  readonly power: {
    readonly idleState: string;
    readonly idleSeconds: number;
    readonly onBattery: boolean;
    readonly thermalState: string;
    readonly speedLimitPercent: number | null;
    readonly suspended: boolean;
    readonly locked: boolean | null;
    readonly lowPowerMode: boolean | null;
    readonly updatedAt: string;
    readonly stale: boolean;
  };
  readonly processes: ReadonlyArray<{
    readonly pid: number;
    readonly startTimeMs: number;
    readonly type: string;
    readonly cpuPercent: number;
    readonly cpuTimeMs: number;
    readonly residentBytes: number;
    readonly privateBytes: number;
    readonly idleWakeupsPerSecond: number;
  }>;
}

export const DESKTOP_TELEMETRY_MAX_BYTES = 256 * 1024;
export const DESKTOP_TELEMETRY_STALE_MS = 90_000;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function parseDesktopResourceTelemetry(
  value: unknown,
): DesktopResourceTelemetrySnapshot | null {
  if (
    !record(value) ||
    typeof value.processSample !== "boolean" ||
    typeof value.sampledAt !== "string" ||
    !Number.isFinite(Date.parse(value.sampledAt)) ||
    !counter(value.electronPid) ||
    !Number.isSafeInteger(value.electronPid) ||
    value.electronPid === 0 ||
    !record(value.power) ||
    !Array.isArray(value.processes) ||
    value.processes.length > 512
  )
    return null;
  const power = value.power;
  if (
    typeof power.idleState !== "string" ||
    power.idleState.length > 32 ||
    !counter(power.idleSeconds) ||
    typeof power.onBattery !== "boolean" ||
    typeof power.thermalState !== "string" ||
    power.thermalState.length > 32 ||
    (power.speedLimitPercent !== null && !counter(power.speedLimitPercent)) ||
    typeof power.suspended !== "boolean" ||
    (power.locked !== null && typeof power.locked !== "boolean") ||
    (power.lowPowerMode !== null && typeof power.lowPowerMode !== "boolean") ||
    typeof power.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(power.updatedAt)) ||
    typeof power.stale !== "boolean"
  )
    return null;
  for (const entry of value.processes) {
    if (
      !record(entry) ||
      !counter(entry.pid) ||
      !Number.isSafeInteger(entry.pid) ||
      entry.pid === 0 ||
      typeof entry.type !== "string" ||
      entry.type.length > 128 ||
      ![
        entry.startTimeMs,
        entry.cpuPercent,
        entry.cpuTimeMs,
        entry.residentBytes,
        entry.privateBytes,
        entry.idleWakeupsPerSecond,
      ].every(counter)
    )
      return null;
  }
  const snapshot = value as unknown as DesktopResourceTelemetrySnapshot;
  // Electron exposes fractional milliseconds; the native monitor and public
  // telemetry contracts use whole milliseconds for identities and CPU counters.
  return {
    ...snapshot,
    processes: snapshot.processes.map((entry) => ({
      pid: entry.pid,
      startTimeMs: Math.trunc(entry.startTimeMs),
      type: entry.type,
      cpuPercent: entry.cpuPercent,
      cpuTimeMs: Math.trunc(entry.cpuTimeMs),
      residentBytes: entry.residentBytes,
      privateBytes: entry.privateBytes,
      idleWakeupsPerSecond: entry.idleWakeupsPerSecond,
    })),
  };
}

/** Reject oversized frames before parsing and bound unterminated input. */
export function createTelemetryLineReader(
  onValue: (value: unknown) => void,
  onInvalid: () => void,
) {
  let buffer = "";
  let failed = false;
  return (chunk: string) => {
    if (failed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > DESKTOP_TELEMETRY_MAX_BYTES) {
      failed = true;
      buffer = "";
      onInvalid();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        onValue(JSON.parse(line));
      } catch {
        onInvalid();
      }
    }
  };
}
