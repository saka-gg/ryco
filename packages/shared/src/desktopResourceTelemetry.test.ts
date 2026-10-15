import { describe, expect, it } from "vite-plus/test";
import {
  createTelemetryLineReader,
  DESKTOP_TELEMETRY_MAX_BYTES,
  parseDesktopBackendLifecycleFrame,
  parseDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.ts";

describe("private desktop telemetry protocol", () => {
  it("accepts finite host metrics and rejects malformed or oversized process sets", () => {
    const value = {
      sampledAt: "2026-09-07T12:00:00.000Z",
      electronPid: 12,
      processSample: true,
      power: {
        idleState: "active",
        idleSeconds: 0,
        onBattery: false,
        thermalState: "nominal",
        speedLimitPercent: null,
        suspended: false,
        locked: null,
        lowPowerMode: null,
        updatedAt: "2026-09-07T12:00:00.000Z",
        stale: false,
      },
      processes: [
        {
          pid: 12,
          startTimeMs: 100,
          type: "Browser",
          cpuPercent: 150,
          cpuTimeMs: 30,
          residentBytes: 100,
          privateBytes: 90,
          idleWakeupsPerSecond: 5,
        },
      ],
    };
    expect(parseDesktopResourceTelemetry(value)).toEqual(value);
    const fractional = {
      ...value,
      processes: [
        { ...value.processes[0], startTimeMs: 100.75, cpuTimeMs: 30.25, cpuPercent: 12.5 },
      ],
    };
    expect(parseDesktopResourceTelemetry(fractional)?.processes[0]).toEqual({
      ...fractional.processes[0],
      startTimeMs: 100,
      cpuTimeMs: 30,
    });
    expect(fractional.processes[0]?.startTimeMs).toBe(100.75);
    expect(
      parseDesktopResourceTelemetry({
        ...value,
        processes: [{ ...value.processes[0], cpuPercent: Infinity }],
      }),
    ).toBeNull();
    expect(
      parseDesktopResourceTelemetry({
        ...value,
        processes: Array.from({ length: 513 }, () => value.processes[0]),
      }),
    ).toBeNull();
    expect(parseDesktopResourceTelemetry({ ...value, sampledAt: "invalid" })).toBeNull();
  });

  it("handles split frames and stops after oversized input", () => {
    const values: unknown[] = [];
    let invalid = 0;
    const read = createTelemetryLineReader(
      (value) => values.push(value),
      () => {
        invalid++;
      },
    );
    read('{"type":');
    read('"sample"}\n');
    expect(values).toEqual([{ type: "sample" }]);
    read("x".repeat(DESKTOP_TELEMETRY_MAX_BYTES + 1));
    read('{"type":"sample"}\n');
    expect(invalid).toBe(1);
    expect(values).toHaveLength(1);
  });

  it("parses backend lifecycle frames and rejects malformed ones", () => {
    expect(parseDesktopBackendLifecycleFrame({ type: "http-bound", port: 3773 })).toEqual({
      type: "http-bound",
      port: 3773,
    });
    expect(parseDesktopBackendLifecycleFrame({ type: "http-serving", port: 3773 })).toEqual({
      type: "http-serving",
      port: 3773,
    });
    expect(parseDesktopBackendLifecycleFrame({ type: "startup-ready" })).toEqual({
      type: "startup-ready",
    });
    expect(
      parseDesktopBackendLifecycleFrame({ type: "startup-phase", name: "runtime", ms: 12.5 }),
    ).toEqual({ type: "startup-phase", name: "runtime", ms: 12.5 });
    expect(
      parseDesktopBackendLifecycleFrame({
        type: "startup-phase",
        name: "persistence.migrations",
        ms: 900,
        durationMs: 640,
      }),
    ).toEqual({ type: "startup-phase", name: "persistence.migrations", ms: 900, durationMs: 640 });
    expect(
      parseDesktopBackendLifecycleFrame({
        type: "startup-phase",
        name: "runtime",
        ms: 12,
        durationMs: -3,
      }),
    ).toEqual({ type: "startup-phase", name: "runtime", ms: 12 });
    expect(
      parseDesktopBackendLifecycleFrame({
        type: "fatal",
        code: "database-schema-newer",
        message: "x".repeat(10_000),
      }),
    ).toEqual({ type: "fatal", code: "database-schema-newer", message: "x".repeat(4_096) });

    expect(parseDesktopBackendLifecycleFrame({ type: "http-bound", port: 0 })).toBeNull();
    expect(parseDesktopBackendLifecycleFrame({ type: "http-serving", port: "1" })).toBeNull();
    expect(
      parseDesktopBackendLifecycleFrame({ type: "startup-phase", name: "", ms: 1 }),
    ).toBeNull();
    expect(
      parseDesktopBackendLifecycleFrame({ type: "startup-phase", name: "x", ms: -1 }),
    ).toBeNull();
    expect(parseDesktopBackendLifecycleFrame({ type: "fatal", message: "no code" })).toBeNull();
    expect(parseDesktopBackendLifecycleFrame({ type: "sample" })).toBeNull();
    expect(parseDesktopBackendLifecycleFrame(null)).toBeNull();
  });
});
