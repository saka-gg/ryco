import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export interface NativeResourceProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly startTimeMs: number;
  readonly runTimeMs: number;
  readonly name: string;
  readonly command: string;
  readonly status: string;
  readonly cpuPercent: number;
  readonly cpuTimeMs: number;
  readonly residentBytes: number;
  readonly virtualBytes: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
  readonly ioSemantics: "storage" | "all-io";
}
export interface NativeResourceSnapshot {
  readonly sampledAtUnixMs: number;
  readonly collectionDurationMicros: number;
  readonly scannedProcessCount: number;
  readonly retainedProcessCount: number;
  readonly inaccessibleProcessCount: number;
  readonly processes: ReadonlyArray<NativeResourceProcess>;
}
export interface NativeResourceHealth {
  readonly status: "starting" | "healthy" | "unavailable" | "stopped";
  readonly sidecarPid?: number;
  readonly sidecarVersion?: string;
  readonly restartCount: number;
  readonly lastError?: string;
}
export interface NativeHostPowerState {
  readonly stale: boolean;
  readonly suspended: boolean;
  readonly locked: boolean | null;
  readonly lowPowerMode: boolean | null;
  readonly onBattery: boolean;
  readonly thermalState: string;
}

export function resolveNativeSampleIntervalMs(
  power: NativeHostPowerState | null,
  active: boolean,
): number {
  if (power && !power.stale) {
    if (
      power.suspended ||
      power.locked === true ||
      power.lowPowerMode === true ||
      power.thermalState === "serious" ||
      power.thermalState === "critical"
    )
      return 15_000;
    if (power.onBattery) return 5_000;
  }
  return active ? 1_000 : 5_000;
}

interface ExternalProcess {
  readonly pid: number;
  readonly startTimeMs: number;
}
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
/** After this long without a request the sidecar drops to its background sampling rate. */
const BACKGROUND_AFTER_IDLE_MS = 90_000;
/** After this long without a request the sidecar is stopped; the next request starts it again. */
const STOP_AFTER_IDLE_MS = 10 * 60_000;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => numeric(value) && Number.isSafeInteger(value);

export function decodeNativeSnapshot(value: unknown): NativeResourceSnapshot | undefined {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    value.type !== "snapshot" ||
    !integer(value.sampledAtUnixMs) ||
    value.sampledAtUnixMs > 8.64e15 ||
    !integer(value.collectionDurationMicros) ||
    !integer(value.scannedProcessCount) ||
    !integer(value.retainedProcessCount) ||
    !integer(value.inaccessibleProcessCount) ||
    !Array.isArray(value.processes) ||
    value.processes.length > 20_000
  )
    return undefined;
  const processes: NativeResourceProcess[] = [];
  for (const entry of value.processes) {
    if (
      !isRecord(entry) ||
      !integer(entry.pid) ||
      entry.pid <= 0 ||
      !integer(entry.ppid) ||
      !integer(entry.startTimeMs) ||
      !integer(entry.runTimeMs) ||
      !numeric(entry.cpuPercent) ||
      !integer(entry.cpuTimeMs) ||
      !integer(entry.residentBytes) ||
      !integer(entry.virtualBytes) ||
      !integer(entry.ioReadBytes) ||
      !integer(entry.ioWriteBytes) ||
      typeof entry.name !== "string" ||
      typeof entry.command !== "string" ||
      typeof entry.status !== "string" ||
      (entry.ioSemantics !== "storage" && entry.ioSemantics !== "all-io")
    )
      return undefined;
    const name = entry.name.replace(/\p{Cc}/gu, "").slice(0, 1024);
    processes.push({
      pid: entry.pid,
      ppid: entry.ppid,
      startTimeMs: entry.startTimeMs,
      runTimeMs: entry.runTimeMs,
      name,
      command: name,
      status: entry.status.slice(0, 256),
      cpuPercent: entry.cpuPercent,
      cpuTimeMs: entry.cpuTimeMs,
      residentBytes: entry.residentBytes,
      virtualBytes: entry.virtualBytes,
      ioReadBytes: entry.ioReadBytes,
      ioWriteBytes: entry.ioWriteBytes,
      ioSemantics: entry.ioSemantics,
    });
  }
  return {
    sampledAtUnixMs: value.sampledAtUnixMs,
    collectionDurationMicros: value.collectionDurationMicros,
    scannedProcessCount: value.scannedProcessCount,
    retainedProcessCount: value.retainedProcessCount,
    inaccessibleProcessCount: value.inaccessibleProcessCount,
    processes,
  };
}

async function resolveBinary(): Promise<string> {
  const name = process.platform === "win32" ? "ryco-resource-monitor.exe" : "ryco-resource-monitor";
  const candidates = [
    path.resolve(
      import.meta.dirname,
      "resource-monitor",
      `${process.platform}-${process.arch}`,
      name,
    ),
    path.resolve(
      import.meta.dirname,
      "../resource-monitor",
      `${process.platform}-${process.arch}`,
      name,
    ),
    path.resolve(import.meta.dirname, "resource-monitor", name),
    path.resolve(import.meta.dirname, "../resource-monitor", name),
    path.resolve(import.meta.dirname, "../../../../native/resource-monitor/target/release", name),
    path.resolve(import.meta.dirname, "../../../native/resource-monitor/target/release", name),
  ];
  for (const candidate of candidates) {
    try {
      const executable = candidate.replace(/\.asar([\\/])/gu, ".asar.unpacked$1");
      await access(executable);
      return executable;
    } catch {
      /* Try the next bundled location. */
    }
  }
  throw new Error("Native resource monitor binary is unavailable.");
}

interface PendingRequest {
  readonly resolve: (value: ReadonlyArray<NativeResourceSnapshot>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly snapshots: NativeResourceSnapshot[];
  bytes: number;
}

export function makeNativeResourceMonitor(
  options: { readonly resolveBinary?: () => Promise<string> } = {},
) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let startPromise: Promise<void> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelStartup: ((error: Error) => void) | undefined;
  let samplePromise: Promise<NativeResourceSnapshot> | undefined;
  let sampleGeneration = 0;
  let cachedSample: { value: NativeResourceSnapshot; expiresAt: number } | undefined;
  let health: NativeResourceHealth = { status: "stopped", restartCount: 0 };
  let externalProcesses: ReadonlyArray<ExternalProcess> = [];
  let generation = 0;
  let requestSequence = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleStopTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAfter = 0;
  let hostPower: NativeHostPowerState | null = null;
  let activeDemand = false;
  let appliedIntervalMs = 5_000;
  const pending = new Map<string, PendingRequest>();
  const stop = (message?: string) => {
    generation += 1;
    if (idleTimer) clearTimeout(idleTimer);
    if (idleStopTimer) clearTimeout(idleStopTimer);
    activeDemand = false;
    const previous = child;
    child = undefined;
    startPromise = undefined;
    samplePromise = undefined;
    sampleGeneration += 1;
    cachedSample = undefined;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    cancelStartup?.(new Error(message ?? "Resource monitor stopped."));
    cancelStartup = undefined;
    previous?.kill();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message ?? "Resource monitor stopped."));
    }
    pending.clear();
    health = {
      status: message ? "unavailable" : "stopped",
      restartCount: health.restartCount,
      ...(message ? { lastError: message } : {}),
    };
    if (message) retryAfter = Date.now() + 30_000;
  };
  const send = (command: Record<string, unknown>) => {
    if (!child?.stdin.writable || child.stdin.writableLength > 256 * 1024)
      throw new Error("Resource monitor command stream unavailable.");
    child.stdin.write(`${JSON.stringify({ version: 3, ...command })}\n`);
  };
  const updateInterval = () => {
    const interval = resolveNativeSampleIntervalMs(hostPower, activeDemand);
    if (health.status !== "healthy" || interval === appliedIntervalMs) return;
    try {
      send({ type: "setSampleInterval", sampleIntervalMs: interval });
      appliedIntervalMs = interval;
    } catch {
      stop("Resource monitor interval update failed.");
    }
  };
  const touch = () => {
    activeDemand = true;
    updateInterval();
    if (idleTimer) clearTimeout(idleTimer);
    // Keep bounded history collecting after the page closes, with lower overhead.
    idleTimer = setTimeout(() => {
      activeDemand = false;
      updateInterval();
    }, BACKGROUND_AFTER_IDLE_MS);
    idleTimer.unref();
    // Nobody is reading the samples any more: stop the sidecar instead of
    // sampling forever. The next request starts it again.
    if (idleStopTimer) clearTimeout(idleStopTimer);
    idleStopTimer = setTimeout(() => stop(), STOP_AFTER_IDLE_MS);
    idleStopTimer.unref();
  };
  const start = (): Promise<void> => {
    if (startPromise) return startPromise;
    if (child && health.status === "healthy") return Promise.resolve();
    if (Date.now() < retryAfter)
      return Promise.reject(new Error(health.lastError ?? "Resource monitor unavailable."));
    const activeGeneration = ++generation;
    health = { status: "starting", restartCount: health.restartCount };
    const promise = (options.resolveBinary ?? resolveBinary)()
      .then(
        (binary) =>
          new Promise<void>((resolve, reject) => {
            if (activeGeneration !== generation) {
              reject(new Error("Resource monitor start superseded."));
              return;
            }
            const processChild = spawn(binary, [], { stdio: "pipe", windowsHide: true });
            child = processChild;
            let buffer = "";
            let ready = false;
            cancelStartup = reject;
            startupTimer = setTimeout(
              () => fail("Resource monitor handshake timed out."),
              REQUEST_TIMEOUT_MS,
            );
            const fail = (message: string) => {
              if (activeGeneration !== generation) return;
              clearTimeout(startupTimer);
              stop(message);
              reject(new Error(message));
            };
            processChild.on("error", () => fail("Resource monitor could not start."));
            processChild.on("exit", () => fail("Resource monitor exited."));
            processChild.stdin.on("error", () => fail("Resource monitor input closed."));
            processChild.stderr.resume();
            processChild.stdout.setEncoding("utf8");
            processChild.stdout.on("data", (chunk: string) => {
              if (activeGeneration !== generation) return;
              buffer += chunk;
              if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
                fail("Resource monitor response exceeded its size limit.");
                return;
              }
              let newline: number;
              while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                let value: unknown;
                try {
                  value = JSON.parse(line);
                } catch {
                  fail("Resource monitor returned invalid JSON.");
                  return;
                }
                if (!isRecord(value) || value.version !== 3) {
                  fail("Resource monitor protocol mismatch.");
                  return;
                }
                if (value.type === "hello" && !ready) {
                  if (
                    !integer(value.sidecarPid) ||
                    value.sidecarPid !== processChild.pid ||
                    typeof value.sidecarVersion !== "string"
                  ) {
                    fail("Invalid resource monitor identity.");
                    return;
                  }
                  ready = true;
                  clearTimeout(startupTimer);
                  startupTimer = undefined;
                  cancelStartup = undefined;
                  health = {
                    status: "healthy",
                    restartCount: health.restartCount,
                    sidecarPid: value.sidecarPid,
                    sidecarVersion: value.sidecarVersion.slice(0, 100),
                  };
                  try {
                    send({
                      type: "configure",
                      rootPid: process.pid,
                      sampleIntervalMs: resolveNativeSampleIntervalMs(hostPower, true),
                      externalProcesses,
                    });
                  } catch {
                    fail("Resource monitor configuration failed.");
                    return;
                  }
                  appliedIntervalMs = resolveNativeSampleIntervalMs(hostPower, true);
                  touch();
                  resolve();
                  continue;
                }
                if (value.type === "error") {
                  fail("Resource monitor reported a collection error.");
                  return;
                }
                const request =
                  typeof value.requestId === "string" ? pending.get(value.requestId) : undefined;
                if (!request) continue;
                request.bytes += Buffer.byteLength(line);
                if (request.bytes > MAX_HISTORY_BYTES) {
                  fail("Resource history exceeded its size limit.");
                  return;
                }
                const records =
                  value.type === "historyChunk" && Array.isArray(value.snapshots)
                    ? value.snapshots
                    : [value];
                for (const record of records) {
                  const snapshot = decodeNativeSnapshot(record);
                  if (!snapshot || request.snapshots.length >= 3600) {
                    fail("Resource monitor returned an invalid snapshot.");
                    return;
                  }
                  request.snapshots.push(snapshot);
                }
                if (
                  value.type === "snapshot" ||
                  (value.type === "historyChunk" && value.done === true)
                ) {
                  clearTimeout(request.timer);
                  pending.delete(value.requestId as string);
                  request.resolve(request.snapshots);
                }
              }
            });
          }),
      )
      .catch((error: unknown) => {
        if (activeGeneration === generation) stop("Native resource monitor is unavailable.");
        throw error;
      });
    startPromise = promise;
    return promise;
  };
  const request = async (type: "sampleNow" | "readHistory", windowMs?: number) => {
    await start();
    touch();
    if (pending.size >= 8) throw new Error("Too many pending resource monitor requests.");
    const requestId = String(++requestSequence);
    return new Promise<ReadonlyArray<NativeResourceSnapshot>>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop("Resource monitor request timed out.");
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer, snapshots: [], bytes: 0 });
      try {
        send({ type, requestId, ...(windowMs !== undefined ? { windowMs } : {}) });
      } catch {
        stop("Resource monitor command failed.");
      }
    });
  };
  return {
    sample(options?: { readonly fresh?: boolean }): Promise<NativeResourceSnapshot> {
      // Destructive actions must always obtain their own current OS identity sample.
      if (!options?.fresh) {
        if (cachedSample && cachedSample.expiresAt > Date.now() && health.status === "healthy") {
          touch();
          return Promise.resolve(cachedSample.value);
        }
        if (samplePromise) return samplePromise;
      }
      const activeSampleGeneration = sampleGeneration;
      const collection = request("sampleNow").then((snapshots) => {
        const snapshot = snapshots[0];
        if (!snapshot) throw new Error("Resource monitor returned no snapshot.");
        // External identity changes and stop/retry invalidate all previous samples.
        if (health.status === "healthy" && sampleGeneration === activeSampleGeneration) {
          cachedSample = { value: snapshot, expiresAt: Date.now() + 1000 };
        }
        return snapshot;
      });
      if (!options?.fresh) {
        samplePromise = collection;
        const clear = () => {
          if (samplePromise === collection) samplePromise = undefined;
        };
        void collection.then(clear, clear);
      }
      return collection;
    },
    history(windowMs: number) {
      return request("readHistory", Math.max(0, Math.min(3_600_000, Math.round(windowMs) || 0)));
    },
    setExternalProcesses(processes: ReadonlyArray<ExternalProcess>) {
      const selected = processes
        .filter((entry) => integer(entry.pid) && entry.pid > 0 && integer(entry.startTimeMs))
        .slice(0, 256)
        .toSorted((left, right) => left.pid - right.pid);
      if (
        selected.length === externalProcesses.length &&
        selected.every(
          (entry, index) =>
            entry.pid === externalProcesses[index]?.pid &&
            entry.startTimeMs === externalProcesses[index]?.startTimeMs,
        )
      )
        return;
      cachedSample = undefined;
      samplePromise = undefined;
      sampleGeneration += 1;
      externalProcesses = selected;
      if (health.status === "healthy") {
        try {
          send({ type: "setExternalProcesses", processes: externalProcesses });
        } catch {
          stop("Resource monitor command failed.");
        }
      }
    },
    setHostPowerState(power: NativeHostPowerState | null) {
      hostPower = power;
      updateInterval();
    },
    sampleIntervalMs: () => appliedIntervalMs,
    retry() {
      stop();
      retryAfter = 0;
      health = { status: "stopped", restartCount: health.restartCount + 1 };
    },
    close: () => stop(),
    health: (): NativeResourceHealth => ({ ...health }),
  };
}

export const nativeResourceMonitor = makeNativeResourceMonitor();
