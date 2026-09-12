import { describe, expect, it, vi } from "vitest";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";
import { HostDeviceBackend, hostDeviceId } from "./HostDeviceBackend.ts";
import { PlatformDeviceBackend } from "./PlatformDeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";

function fixture() {
  const local = new FakeDeviceBackend();
  const remote = new FakeDeviceBackend();
  let disconnect: () => void = () => undefined;
  const remoteBackend = Object.assign(remote, {
    onDisconnect: (listener: (udids: readonly string[]) => void) => {
      disconnect = () => listener([]);
      return () => undefined;
    },
  });
  const backend = new HostDeviceBackend([
    { host: { id: "local", name: "Local", transport: "local" }, backend: local },
    { host: { id: "mac", name: "Build Mac", transport: "ssh" }, backend: remoteBackend },
  ]);
  return { local, remote, backend, disconnect: () => disconnect() };
}

describe("device host routing", () => {
  it("retains factory boots and routes when the root platform SDK cache is stale", async () => {
    const ios = new FakeDeviceBackend();
    const android = new FakeDeviceBackend();
    const list = android.listDevices.bind(android);
    android.listDevices = async (options) =>
      (await list(options)).map((d) => ({
        ...d,
        udid: `android:${d.udid}`,
        platform: "android-emulator" as const,
      }));
    const boot = android.boot.bind(android);
    android.boot = async (udid) => ({
      ...(await boot(udid.slice(8))),
      udid,
      platform: "android-emulator",
    });
    const tap = vi.spyOn(android, "tap").mockResolvedValue(undefined);
    vi.spyOn(android, "shutdown").mockResolvedValue(undefined);
    const backend = new HostDeviceBackend([
      {
        host: { id: "local", name: "Local", transport: "local" },
        backend: new PlatformDeviceBackend(ios, android),
        createDeviceBackend: () => new PlatformDeviceBackend(new FakeDeviceBackend(), android),
      },
    ]);
    const manager = new DeviceManager({ backend, bootLimit: 1 });
    const udid = "android:FAKE-0001";
    try {
      expect((await manager.boot(udid)).kind).toBe("booted");
      android.listDevices = async () => {
        throw new Error("SDK temporarily unavailable");
      };
      const inventory = await backend.discoverDevices();
      expect(inventory.completeFor(udid)).toBe(false);
      expect(inventory.devices.find((d) => d.udid === udid)?.state).toBe("booted");
      expect((await manager.rycoBootedDevices()).map((d) => d.udid)).toEqual([udid]);
      await backend.tap(udid, 1, 2);
      expect(tap).toHaveBeenCalledWith(udid, 1, 2);
      expect((await manager.boot("FAKE-0002")).kind).toBe("boot-limit-reached");
    } finally {
      await manager.dispose();
    }
  });

  it("routes object-target testing and suspends per-device factory instances independently", async () => {
    const discovery = new FakeDeviceBackend();
    const instances: FakeDeviceBackend[] = [];
    const backend = new HostDeviceBackend([
      {
        host: { id: "local", name: "Local", transport: "local" },
        backend: discovery,
        createDeviceBackend: () => {
          const instance = new FakeDeviceBackend();
          vi.spyOn(instance, "testing").mockResolvedValue(undefined);
          vi.spyOn(instance, "suspendTesting");
          instances.push(instance);
          return instance;
        },
      },
    ]);
    const a = { udid: "FAKE-0001", action: { type: "appearance", value: "dark" } } as const;
    const b = { ...a, udid: "FAKE-0002" };
    try {
      await backend.listDevices({ includeShutdown: true });
      await backend.testing(a);
      await backend.testing(b);
      expect(instances[0]!.testing).toHaveBeenCalledWith(a);
      expect(instances[1]!.testing).toHaveBeenCalledWith(b);
      const resumeA = backend.suspendTesting(a.udid);
      expect(instances[0]!.suspendTesting).toHaveBeenCalledWith(a.udid);
      expect(instances[1]!.suspendTesting).not.toHaveBeenCalled();
      await expect(backend.testing(a)).rejects.toThrow("superseded");
      await backend.testing(b);
      const resumeAll = backend.suspendTesting();
      expect(instances[1]!.suspendTesting).toHaveBeenCalledWith();
      resumeA();
      await expect(backend.testing(a)).rejects.toThrow("superseded");
      await expect(backend.testing({ ...a, udid: "FAKE-0003" })).rejects.toThrow("superseded");
      expect(instances).toHaveLength(2);
      resumeAll();
      await backend.testing(a);
    } finally {
      await backend.dispose();
    }
  });

  it("rejects SSH testing without dispatching to either native host", async () => {
    const { backend, local, remote } = fixture();
    const localTesting = vi.spyOn(local, "testing");
    const remoteTesting = vi.spyOn(remote, "testing");
    try {
      await backend.listDevices({ includeShutdown: true });
      await expect(
        backend.testing({
          udid: hostDeviceId("mac", "FAKE-0001"),
          action: { type: "appearance", value: "dark" },
        }),
      ).rejects.toThrow("unavailable on SSH");
      expect(localTesting).not.toHaveBeenCalled();
      expect(remoteTesting).not.toHaveBeenCalled();
      await backend.boot(hostDeviceId("mac", "FAKE-0001"));
      await backend.tap(hostDeviceId("mac", "FAKE-0001"), 1, 2);
      expect(remote.callsOfKind("tap")).toHaveLength(1);
    } finally {
      await backend.dispose();
    }
  });

  it("retains a cold incomplete orphan inventory and reclaims it after discovery completes", async () => {
    const { backend, local } = fixture();
    local.bootExternally("FAKE-0001");
    local.bootExternally("FAKE-0002");
    let saved = ["FAKE-0001"];
    const manager = new DeviceManager({
      backend,
      bootLimit: 1,
      bootOwnership: {
        read: async () => ({ pid: 4242, udids: saved }),
        write: async (udids) => {
          saved = [...udids];
        },
        clear: async () => {
          saved = [];
        },
      },
    });
    const list = local.listDevices.bind(local);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    local.listDevices = async (options) => {
      await gate;
      return list(options);
    };
    try {
      expect(await manager.reclaimOrphanedBoots(() => false)).toEqual([]);
      expect(saved).toEqual(["FAKE-0001"]);
      expect(local.callsOfKind("shutdown")).toEqual([]);
      release();
      // The scheduled retry consumes a fresh complete inventory without a restart.
      await expect.poll(() => saved, { timeout: 3000 }).toEqual([]);
      expect(local.callsOfKind("shutdown").map((call) => call.udid)).toEqual(["FAKE-0001"]);
      expect((await list()).find((d) => d.udid === "FAKE-0002")?.state).toBe("booted");
    } finally {
      release();
      await manager.dispose();
    }
  });

  it("releases a confirmed deletion but retains ownership on failed host discovery", async () => {
    const { backend, remote } = fixture();
    const manager = new DeviceManager({ backend, bootLimit: 1 });
    const native = "FAKE-0001";
    const remoteId = hostDeviceId("mac", native);
    const localId = "FAKE-0002";
    const list = remote.listDevices.bind(remote);
    try {
      await manager.boot(remoteId);
      // The router's last inventory still says shutdown; a failed refresh must
      // not treat either this cached state or an empty result as authoritative.
      remote.listDevices = async () => {
        throw new Error("temporary discovery failure");
      };
      expect((await manager.boot(localId)).kind).toBe("boot-limit-reached");
      remote.listDevices = async (options) =>
        (await list(options)).filter((d) => d.udid !== native);
      expect((await manager.boot(localId)).kind).toBe("booted");
      await expect(backend.tap(remoteId, 1, 2)).rejects.toThrow("Unknown");
    } finally {
      await manager.dispose();
    }
  });

  it("finishes a local boot and publication while remote discovery and probes stay pending", async () => {
    const { backend, local, remote } = fixture();
    const manager = new DeviceManager({ backend });
    local.bootExternally("FAKE-0001");
    await manager.attach("watching-local", "FAKE-0001");
    const list = remote.listDevices.bind(remote);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    remote.listDevices = vi.fn(async (options) => {
      await gate;
      completed = true;
      return list(options);
    });
    remote.availability = async () => {
      await gate;
      return { kind: "available" };
    };
    let result: Awaited<ReturnType<DeviceManager["boot"]>> | undefined;
    const boot = manager.boot("FAKE-0002").then((value) => {
      result = value;
    });
    try {
      await expect.poll(() => result?.kind, { timeout: 2000 }).toBe("booted");
      expect(completed).toBe(false);
      expect(remote.listDevices).toHaveBeenCalledTimes(1);
      // A bounded response is explicitly incomplete for the pending host.
      const discovery = await backend.discoverDevices();
      expect(discovery.completeFor(hostDeviceId("mac", "FAKE-0001"))).toBe(false);
      release();
      await gate;
      await backend.listDevices({ includeShutdown: true });
      expect(discovery.completeFor(hostDeviceId("mac", "FAKE-0001"))).toBe(false);
    } finally {
      release();
      await boot;
      await manager.dispose();
    }
  });

  it("counts a remote cold-boot reservation while its discovery is queued", async () => {
    const { backend, remote } = fixture();
    const manager = new DeviceManager({ backend, bootLimit: 1 });
    const boot = remote.boot.bind(remote);
    const list = remote.listDevices.bind(remote);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    remote.boot = async (udid) => {
      started = true;
      await gate;
      return boot(udid);
    };
    const remoteBoot = manager.boot(hostDeviceId("mac", "FAKE-0001"));
    try {
      await expect.poll(() => started).toBe(true);
      remote.listDevices = async (options) => {
        await gate;
        return list(options);
      };
      let result: Awaited<ReturnType<DeviceManager["boot"]>> | undefined;
      const localBoot = manager.boot("FAKE-0002").then((value) => {
        result = value;
      });
      await expect.poll(() => result?.kind, { timeout: 1000 }).toBe("boot-limit-reached");
      await localBoot;
    } finally {
      release();
      await remoteBoot;
      await manager.dispose();
    }
  });

  it("rejects inventory started during a boot even when a later caller joins after boot completion", async () => {
    const { backend, remote } = fixture();
    const manager = new DeviceManager({ backend, bootLimit: 1 });
    const originalBoot = remote.boot.bind(remote);
    const originalList = remote.listDevices.bind(remote);
    let finishBoot!: () => void;
    const bootGate = new Promise<void>((resolve) => {
      finishBoot = resolve;
    });
    let finishList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      finishList = resolve;
    });
    let bootStarted = false;
    let listStarted = false;
    remote.boot = async (udid) => {
      bootStarted = true;
      await bootGate;
      return originalBoot(udid);
    };
    const bootA = manager.boot(hostDeviceId("mac", "FAKE-0001"));
    try {
      await expect.poll(() => bootStarted).toBe(true);
      remote.listDevices = vi.fn(async (options) => {
        const oldInventory = await originalList(options);
        listStarted = true;
        await listGate;
        return oldInventory;
      });
      const oldDiscovery = backend.discoverDevices();
      await expect.poll(() => listStarted).toBe(true);
      finishBoot();
      expect((await bootA).kind).toBe("booted");
      // This caller starts after boot completion but joins the old refresh.
      const bootB = manager.boot("FAKE-0002");
      finishList();
      expect((await bootB).kind).toBe("boot-limit-reached");
      expect((await oldDiscovery).completeFor(hostDeviceId("mac", "FAKE-0001"))).toBe(false);
      expect(remote.listDevices).toHaveBeenCalledTimes(1);
    } finally {
      finishBoot();
      finishList();
      await bootA;
      await manager.dispose();
    }
  });

  it("routes identical native IDs to their selected host and rewrites results", async () => {
    const { backend, local, remote } = fixture();
    const devices = await backend.listDevices({ includeShutdown: true });
    const native = devices[0]!.udid;
    const id = hostDeviceId("mac", native);
    expect(devices.find((d) => d.udid === id)?.host?.name).toBe("Build Mac");
    await backend.boot(id);
    await backend.tap(id, 10, 20);
    const screenshot = await backend.screenshot(id);
    expect(screenshot.udid).toBe(id);
    expect(remote.callsOfKind("tap")[0]?.udid).toBe(native);
    expect(local.callsOfKind("tap")).toHaveLength(0);
    await expect(backend.tap(`ssh:unknown:${native}`, 1, 2)).rejects.toThrow("Unknown");
    await backend.dispose();
  });

  it("rejects stale discovery and operations after host disconnect, even after rediscovery", async () => {
    const { backend, remote, disconnect } = fixture();
    const devices = await backend.listDevices({ includeShutdown: true });
    const native = devices[0]!.udid;
    const id = hostDeviceId("mac", native);
    await backend.boot(id);
    let finish!: () => void;
    remote.tap = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const tap = backend.tap(id, 1, 2);
    disconnect();
    await backend.listDevices({ includeShutdown: true });
    finish();
    await expect(tap).rejects.toThrow("Stale");
    const list = remote.listDevices.bind(remote);
    let finishList!: () => void;
    remote.listDevices = async (options) => {
      await new Promise<void>((resolve) => {
        finishList = resolve;
      });
      return list(options);
    };
    const pending = backend.listDevices({ includeShutdown: true });
    disconnect();
    finishList();
    expect((await pending).every((d) => d.host?.id === "local")).toBe(true);
    await backend.dispose();
  });

  it("clears only the disconnected host's thread and preserves user boots", async () => {
    const { backend, local, remote, disconnect } = fixture();
    const native = (await backend.listDevices({ includeShutdown: true }))[0]!.udid;
    local.bootExternally(native);
    remote.bootExternally(native);
    const manager = new DeviceManager({ backend });
    await manager.attach("local-thread", native);
    await manager.attach("remote-thread", hostDeviceId("mac", native));
    disconnect();
    expect((await manager.getThreadState("remote-thread")).attachedDeviceUdid).toBeNull();
    expect((await manager.getThreadState("local-thread")).attachedDeviceUdid).toBe(native);
    await manager.dispose();
    expect(local.callsOfKind("shutdown")).toHaveLength(0);
    expect(remote.callsOfKind("shutdown")).toHaveLength(0);
  });

  it("keeps local discovery usable when a remote host fails", async () => {
    const { backend, remote } = fixture();
    remote.listDevices = async () => {
      throw new Error("offline");
    };
    remote.availability = async () => {
      throw new Error("offline");
    };
    expect((await backend.availability()).kind).toBe("available");
    expect(
      (await backend.listDevices({ includeShutdown: true })).every((d) => d.host?.id === "local"),
    ).toBe(true);
    await backend.dispose();
  });
});
