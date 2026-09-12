import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readDeviceHostConfig } from "./deviceHostConfig.ts";

describe("node-owned device host configuration", () => {
  it("defaults to local-only and validates configured host identities", async () => {
    expect(await readDeviceHostConfig(undefined)).toEqual([]);
    const directory = await mkdtemp(path.join(tmpdir(), "ryco-device-host-config-"));
    const file = path.join(directory, "hosts.json");
    const host = { name: "Mac", target: "build-mac", executable: "/opt/ryco/bin/ryco" };
    try {
      await writeFile(file, JSON.stringify([host]));
      expect(await readDeviceHostConfig(file)).toEqual([host]);
      for (const hosts of [
        [host, { ...host, name: "Duplicate" }],
        [{ ...host, port: 0 }],
        [{ ...host, executable: "ryco; other-command" }],
        Array.from({ length: 17 }, (_, n) => ({ ...host, target: `mac-${n}` })),
      ]) {
        await writeFile(file, JSON.stringify(hosts));
        await expect(readDeviceHostConfig(file)).rejects.toThrow("Invalid RYCO_DEVICE_HOSTS_FILE");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
