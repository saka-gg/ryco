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

/**
 * Backend → desktop lifecycle frames, written as newline-delimited JSON on the
 * same inherited duplex pipe (fd 4). Only desktop-launched backends write them.
 * - `http-bound`: the port is bound; the startup gate holds API/WS requests and
 *   may already serve the static shell.
 * - `http-serving`: the router's request handlers are attached.
 * - `startup-ready`: the startup command gate opened.
 * - `startup-phase`: a startup phase finished `ms` milliseconds after process
 *   start; `durationMs`, when present, is how long the phase itself ran.
 * - `fatal`: a non-retryable startup error; the backend exits with
 *   {@link DESKTOP_BACKEND_FATAL_EXIT_CODE} right after writing it.
 */
export type DesktopBackendLifecycleFrame =
  | { readonly type: "http-bound"; readonly port: number }
  | { readonly type: "http-serving"; readonly port: number }
  | { readonly type: "startup-ready" }
  | {
      readonly type: "startup-phase";
      readonly name: string;
      readonly ms: number;
      readonly durationMs?: number;
    }
  | { readonly type: "fatal"; readonly code: string; readonly message: string };

/** EX_CONFIG: the backend failed deterministically; restarting cannot help. */
export const DESKTOP_BACKEND_FATAL_EXIT_CODE = 78;

const DESKTOP_BACKEND_FRAME_MAX_TEXT = 4_096;
const boundedText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= DESKTOP_BACKEND_FRAME_MAX_TEXT;
const tcpPort = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;

export function parseDesktopBackendLifecycleFrame(
  value: unknown,
): DesktopBackendLifecycleFrame | null {
  if (!record(value)) return null;
  switch (value.type) {
    case "http-bound":
    case "http-serving":
      return tcpPort(value.port) ? { type: value.type, port: value.port } : null;
    case "startup-ready":
      return { type: "startup-ready" };
    case "startup-phase":
      if (!boundedText(value.name) || !counter(value.ms)) return null;
      // Older backends send no duration; a malformed one drops only the duration.
      return counter(value.durationMs)
        ? { type: "startup-phase", name: value.name, ms: value.ms, durationMs: value.durationMs }
        : { type: "startup-phase", name: value.name, ms: value.ms };
    case "fatal":
      return boundedText(value.code) && typeof value.message === "string"
        ? {
            type: "fatal",
            code: value.code,
            message: value.message.slice(0, DESKTOP_BACKEND_FRAME_MAX_TEXT),
          }
        : null;
    default:
      return null;
  }
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
