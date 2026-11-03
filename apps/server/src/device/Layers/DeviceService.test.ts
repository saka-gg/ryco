import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeviceService } from "../Services/DeviceService.ts";
import { makeDeviceServiceLayer } from "./DeviceService.ts";

const ssh = vi.hoisted(() => ({ loaded: false, configs: [] as unknown[] }));

vi.mock("../SshDeviceBackend.ts", () => {
  ssh.loaded = true;
  class SshDeviceBackend {
    readonly platform = "ios-simulator" as const;
    constructor(config: unknown) {
      ssh.configs.push(config);
    }
    suspendTesting() {
      return () => {};
    }
    async dispose() {}
  }
  return { SshDeviceBackend };
});

const host = {
  name: "Studio Mac",
  target: "studio.local",
  executable: "/usr/local/bin/ryco",
};

describe("DeviceServiceLive SSH device hosts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ryco-device-service-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const supported = (hostsFile: string | undefined) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* DeviceService;
        return service.supported;
      }).pipe(
        Effect.provide(
          makeDeviceServiceLayer({
            // No local simulators or emulators, so only SSH hosts can make devices supported.
            platform: "freebsd",
            ...(hostsFile ? { hostsFile } : {}),
            bootOwnershipPath: path.join(dir, "device-boot-ownership.json"),
          }),
        ),
      ),
    );

  it("never loads the SSH backend when no host is configured", async () => {
    expect(await supported(undefined)).toBe(false);
    expect(ssh.loaded).toBe(false);
    expect(ssh.configs).toEqual([]);
  });

  it("loads the SSH backend and builds one per configured host", async () => {
    const hostsFile = path.join(dir, "hosts.json");
    await writeFile(hostsFile, JSON.stringify([host]));

    expect(await supported(hostsFile)).toBe(true);
    expect(ssh.loaded).toBe(true);
    expect(ssh.configs).toEqual([host]);
  });
});
