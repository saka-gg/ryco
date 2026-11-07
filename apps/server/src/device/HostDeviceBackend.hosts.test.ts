import { describe, expect, it, vi } from "vitest";
import type { DeviceAvailability } from "@ryco/contracts";

import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { HostDeviceBackend, type DeviceHostBackend } from "./HostDeviceBackend.ts";

const local = (backend = new FakeDeviceBackend()): DeviceHostBackend => ({
  host: { id: "local", name: "This node", transport: "local" },
  backend,
});
const ssh = (id: string, name: string, backend = new FakeDeviceBackend()): DeviceHostBackend => ({
  host: { id, name, transport: "ssh", source: "settings" },
  backend,
});

describe("SSH hosts applied without a restart", () => {
  it("adds a host, keeps an unchanged one through a rename, and removes one like a disconnect", async () => {
    const backend = new HostDeviceBackend([local()]);
    const mac = new FakeDeviceBackend();
    await backend.setRemoteHosts([ssh("mac", "Build Mac", mac)]);
    const added = await backend.discoverDevices();
    const remoteIds = added.devices.filter((d) => d.udid.startsWith("ssh:mac:")).map((d) => d.udid);
    expect(remoteIds.length).toBeGreaterThan(0);
    expect(backend.hostSummaries().map((host) => host.name)).toEqual(["This node", "Build Mac"]);

    // Same identity under a new name: the connection and its routes stay.
    const unused = new FakeDeviceBackend();
    const disposeUnused = vi.spyOn(unused, "dispose");
    const disposeMac = vi.spyOn(mac, "dispose");
    await backend.setRemoteHosts([ssh("mac", "Renamed Mac", unused)]);
    expect(disposeUnused).toHaveBeenCalled();
    expect(disposeMac).not.toHaveBeenCalled();
    expect(backend.hostSummaries().find((host) => host.id === "mac")?.name).toBe("Renamed Mac");
    await expect(backend.boot(remoteIds[0]!)).resolves.toMatchObject({ udid: remoteIds[0] });

    // Removal tells the manager which devices went, then closes the host.
    const lost: string[][] = [];
    backend.onDisconnect((udids) => lost.push([...udids]));
    await backend.setRemoteHosts([]);
    expect(lost).toEqual([remoteIds]);
    expect(disposeMac).toHaveBeenCalled();
    expect(backend.hostSummaries().map((host) => host.id)).toEqual(["local"]);
    await expect(backend.boot(remoteIds[0]!)).rejects.toThrow(/Unknown or disconnected/);
  });

  it("rejects duplicate identities and never replaces the local host", async () => {
    const backend = new HostDeviceBackend([local()]);
    await expect(backend.setRemoteHosts([ssh("mac", "A"), ssh("mac", "B")])).rejects.toThrow(
      /Duplicate/,
    );
    await backend.setRemoteHosts([]);
    expect(backend.hostSummaries().map((host) => host.id)).toEqual(["local"]);
  });
});

describe("availability while a probe is slow", () => {
  it("waits for this node's first answer instead of reporting the helper unavailable", async () => {
    const fake = new FakeDeviceBackend();
    let answer!: (value: DeviceAvailability) => void;
    fake.availability = () => new Promise((resolve) => (answer = resolve));
    const backend = new HostDeviceBackend([local(fake)]);
    vi.useFakeTimers();
    try {
      const pending = backend.availability();
      // Past the 250 ms other hosts are given.
      await vi.advanceTimersByTimeAsync(300);
      answer({ kind: "available" });
      expect((await pending).kind).toBe("available");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the last answer when a later probe is slow (a simulator booting)", async () => {
    const fake = new FakeDeviceBackend();
    const backend = new HostDeviceBackend([local(fake)]);
    expect((await backend.availability()).kind).toBe("available");
    fake.availability = () => new Promise(() => undefined);
    expect((await backend.availability()).kind).toBe("available");
  });
});
