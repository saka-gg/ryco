import { DeviceTestingInput } from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { HostDeviceBackend } from "./HostDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";
import { planIosTestingAction } from "./iosTestingActions.ts";
import type { runProcess } from "../processRunner.ts";

const udid = "AAAA-1111";
const input = (action: DeviceTestingInput["action"]): DeviceTestingInput => ({ udid, action });

describe("iOS simulator testing", () => {
  it("validates coordinates, explicit targets, service allowlist and bundle IDs", () => {
    const valid = Schema.is(DeviceTestingInput);
    expect(valid(input({ type: "location", latitude: -90, longitude: 180 }))).toBe(true);
    for (const latitude of [91, -91, NaN, Infinity]) {
      expect(valid(input({ type: "location", latitude, longitude: 0 }))).toBe(false);
    }
    expect(valid(input({ type: "location", latitude: 0, longitude: 181 }))).toBe(false);
    for (const target of ["booted", "all", "ALL", "a b"]) {
      expect(valid({ udid: target, action: { type: "clear-location" } })).toBe(false);
    }
    for (const service of ["all", "camera", "notifications"]) {
      expect(
        valid({
          udid,
          action: { type: "permission", service, decision: "grant", bundleId: "com.example.app" },
        }),
      ).toBe(false);
    }
    expect(valid(input({ type: "push", bundleId: "--help", payload: "{}" }))).toBe(false);
  });

  it("rejects malformed and oversized UTF-8 push payloads before executing", () => {
    for (const payload of [
      "bad",
      "[]",
      "null",
      "{}",
      '{"aps":[]}',
      '{"aps":null}',
      JSON.stringify({ aps: { alert: "🦊".repeat(1100) } }),
    ]) {
      expect(() =>
        planIosTestingAction(input({ type: "push", bundleId: "com.example.app", payload })),
      ).toThrow();
    }
    const payload = JSON.stringify({ aps: { alert: "Hello" }, custom: "$(touch /tmp/nope)" });
    expect(
      planIosTestingAction(input({ type: "push", bundleId: "com.example.app", payload })),
    ).toEqual([{ label: "push", args: ["push", udid, "com.example.app", "-"], stdin: payload }]);
  });

  it("plans isolated permission, location and reusable preset commands", () => {
    expect(
      planIosTestingAction(
        input({
          type: "permission",
          bundleId: "com.example.app",
          decision: "reset",
          service: "photos",
        }),
      )[0]?.args,
    ).toEqual(["privacy", udid, "reset", "photos", "com.example.app"]);
    expect(
      planIosTestingAction(input({ type: "location", latitude: 0, longitude: -122.5 }))[0]?.args,
    ).toEqual(["location", udid, "set", "0,-122.5"]);
    expect(planIosTestingAction(input({ type: "clear-location" }))[0]?.args).toEqual([
      "location",
      udid,
      "clear",
    ]);
    expect(
      planIosTestingAction(input({ type: "preset", value: "dark-large-text" })).map((c) => c.args),
    ).toEqual([
      ["ui", udid, "appearance", "dark"],
      ["ui", udid, "content_size", "accessibility-large"],
    ]);
    expect(
      planIosTestingAction(input({ type: "preset", value: "standard" })).map((c) => c.args),
    ).toEqual([
      ["ui", udid, "appearance", "light"],
      ["ui", udid, "content_size", "large"],
    ]);
  });

  function backend(state: "Booted" | "Shutdown" = "Booted", fail = false) {
    const run = vi.fn<typeof runProcess>(async (_command, args) => ({
      code: fail && args[1] === "ui" ? 1 : 0,
      signal: null,
      timedOut: false,
      stderr: fail ? "private payload should never be echoed" : "",
      stdout:
        args[1] === "list"
          ? JSON.stringify({
              devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                  { udid, name: "iPhone", state, isAvailable: true },
                ],
              },
            })
          : "",
    }));
    return {
      run,
      backend: new IosSimulatorBackend({
        platform: "darwin",
        processEnv: { DEVELOPER_DIR: "/Applications/Xcode-test.app/Contents/Developer" },
        run,
      }),
    };
  }

  it("uses the pinned toolchain and stdin without booting or attaching", async () => {
    const test = backend();
    const payload = '{"aps":{"alert":"test"}}';
    await test.backend.testing(input({ type: "push", bundleId: "com.example.app", payload }));
    expect(test.run).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "push", udid, "com.example.app", "-"],
      expect.objectContaining({
        stdin: payload,
        env: { DEVELOPER_DIR: "/Applications/Xcode-test.app/Contents/Developer" },
      }),
    );
    expect(
      test.run.mock.calls.some(([, args]) => args.includes("boot") || args.includes("bootstatus")),
    ).toBe(false);
  });

  it("does not report a timed-out action as successful even if the process exits zero", async () => {
    const test = backend();
    const run = test.run.getMockImplementation()!;
    test.run.mockImplementation(async (command, args, options) => ({
      ...(await run(command, args, options)),
      timedOut: args[1] === "ui",
    }));
    await expect(
      test.backend.testing(input({ type: "appearance", value: "dark" })),
    ).rejects.toThrow("appearance failed");
  });

  it("refuses shutdown devices and stops presets on first failure", async () => {
    const stopped = backend("Shutdown");
    await expect(
      stopped.backend.testing(input({ type: "preset", value: "dark-large-text" })),
    ).rejects.toThrow("booted");
    expect(stopped.run.mock.calls.some(([, args]) => args[1] === "ui")).toBe(false);
    const failed = backend("Booted", true);
    await expect(
      failed.backend.testing(input({ type: "preset", value: "dark-large-text" })),
    ).rejects.toThrow("Earlier preset steps may already have applied");
    expect(failed.run.mock.calls.filter(([, args]) => args[1] === "ui")).toHaveLength(1);
  });
  it.each(["shutdown", "dispose", "boot", "reboot"] as const)(
    "invalidates a deferred preset before its next step on %s",
    async (lifecycle) => {
      const test = backend();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const run = test.run.getMockImplementation()!;
      test.run.mockImplementation(async (command, args, options) => {
        if (args[1] === "ui") {
          started.resolve();
          await finish.promise;
        }
        return run(command, args, options);
      });
      const result = test.backend
        .testing(input({ type: "preset", value: "dark-large-text" }))
        .catch((error: unknown) => error);
      await started.promise;
      if (lifecycle === "shutdown" || lifecycle === "reboot") await test.backend.shutdown(udid);
      if (lifecycle === "boot" || lifecycle === "reboot") await test.backend.boot(udid);
      if (lifecycle === "dispose") await test.backend.dispose();
      finish.resolve();
      expect(await result).toMatchObject({ message: expect.stringContaining("superseded") });
      expect(test.run.mock.calls.filter(([, args]) => args[1] === "ui")).toHaveLength(1);
    },
  );

  it("invalidates a deferred discovery before the first command", async () => {
    const test = backend();
    const discovery =
      Promise.withResolvers<Awaited<ReturnType<IosSimulatorBackend["listDevices"]>>>();
    vi.spyOn(test.backend, "listDevices").mockReturnValueOnce(discovery.promise);
    const result = test.backend
      .testing(input({ type: "preset", value: "dark-large-text" }))
      .catch((error: unknown) => error);
    await test.backend.shutdown(udid);
    discovery.resolve([
      {
        udid,
        name: "iPhone",
        platform: "ios-simulator",
        runtime: "iOS",
        state: "booted",
        bootSource: "user",
      },
    ]);
    expect(await result).toMatchObject({ message: expect.stringContaining("superseded") });
    expect(test.run.mock.calls.some(([, args]) => args[1] === "ui")).toBe(false);
  });

  it("checks invalidation after asynchronous toolchain resolution and before spawning", async () => {
    const toolchain = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const run = vi.fn<typeof runProcess>(async () => {
      started.resolve();
      await toolchain.promise;
      return {
        code: 0,
        signal: null,
        timedOut: false,
        stdout: "/Applications/Xcode.app/Contents/Developer",
        stderr: "",
      };
    });
    const target = new IosSimulatorBackend({ platform: "darwin", processEnv: {}, run });
    vi.spyOn(target, "listDevices").mockResolvedValue([
      {
        udid,
        name: "iPhone",
        platform: "ios-simulator",
        runtime: "iOS",
        state: "booted",
        bootSource: "user",
      },
    ]);
    const result = target
      .testing(input({ type: "preset", value: "dark-large-text" }))
      .catch((error: unknown) => error);
    await started.promise;
    await target.dispose();
    toolchain.resolve();
    expect(await result).toMatchObject({ message: expect.stringContaining("superseded") });
    expect(run.mock.calls.some(([command]) => command === "xcrun")).toBe(false);
  });

  it.each([
    ["shutdown", false],
    ["dispose", false],
    ["shutdown", true],
    ["dispose", true],
  ] as const)(
    "fences testing at manager %s entry while stream cleanup is pending (host factory: %s)",
    async (lifecycle, factory) => {
      const test = backend();
      vi.spyOn(test.backend, "availability").mockResolvedValue({ kind: "available" });
      const attach = vi.spyOn(test.backend, "attachStream").mockResolvedValue(undefined);
      const target = factory
        ? new HostDeviceBackend([
            {
              host: { id: "local", name: "Local", transport: "local" },
              backend: backend().backend,
              createDeviceBackend: () => test.backend,
            },
          ])
        : test.backend;
      await target.listDevices({ includeShutdown: true });
      const manager = new DeviceManager({ backend: target });
      await manager.attach("testing-thread", udid);
      await vi.waitFor(() => expect(attach).toHaveBeenCalled());
      // Wait until stream reconciliation has finished, not merely entered the adapter.
      await vi.waitFor(async () =>
        expect((await manager.getThreadState("testing-thread")).attachPhase).toBeNull(),
      );
      const cleanupStarted = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      vi.spyOn(test.backend, "detachStream").mockImplementation(async () => {
        cleanupStarted.resolve();
        await cleanup.promise;
      });
      const commandStarted = Promise.withResolvers<void>();
      const command = Promise.withResolvers<void>();
      const run = test.run.getMockImplementation()!;
      test.run.mockImplementation(async (name, args, options) => {
        if (args[1] === "ui") {
          commandStarted.resolve();
          await command.promise;
        }
        return run(name, args, options);
      });
      const result = manager
        .testing(input({ type: "preset", value: "dark-large-text" }))
        .catch((error: unknown) => error);
      await commandStarted.promise;
      const ending = lifecycle === "shutdown" ? manager.shutdown(udid) : manager.dispose();
      await cleanupStarted.promise;
      command.resolve();
      expect(await result).toMatchObject({ message: expect.stringContaining("superseded") });
      // New attempts are also refused throughout cleanup, even with a booted snapshot.
      await expect(manager.testing(input({ type: "appearance", value: "dark" }))).rejects.toThrow(
        "superseded",
      );
      expect(test.run.mock.calls.filter(([, args]) => args[1] === "ui")).toHaveLength(1);
      cleanup.resolve();
      await ending;
      await manager.dispose();
    },
  );
});
