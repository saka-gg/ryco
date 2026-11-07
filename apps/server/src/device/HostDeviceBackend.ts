import type {
  DeviceAvailability,
  DeviceDescriptor,
  DeviceGeometry,
  DeviceHostSummary,
  DevicePlatformAvailability,
} from "@ryco/contracts";
import {
  DeviceBackendError,
  type DeviceBackend,
  type DeviceBackendDetail,
  type DeviceDiscovery,
  type DeviceFrameListener,
  type DeviceLogQuery,
  type DeviceLogResult,
} from "./DeviceBackend.ts";
import {
  ForwardingDeviceBackend,
  type DeviceArgs,
  type DeviceCall,
  type DeviceResult,
} from "./ForwardingDeviceBackend.ts";

export interface DeviceHostBackend {
  readonly host: DeviceHostSummary;
  readonly backend: DeviceBackend;
  /** Native helpers have one binding; isolate that binding per device. */
  readonly createDeviceBackend?: () => DeviceBackend;
}

export function hostDeviceId(hostId: string, nativeUdid: string): string {
  const id = hostId === "local" ? nativeUdid : `ssh:${hostId}:${nativeUdid}`;
  if (id.length > 255) throw new DeviceBackendError("Host-qualified device identity is too long");
  return id;
}

interface DiscoveryVersion {
  readonly generation: number;
  readonly epoch: number;
  readonly completeFor: (nativeUdid: string) => boolean;
}

/** Bound unrelated host latency without cancelling its shared refresh. */
async function boundedHostWait<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Server-side routing only. Browser/agent requests still pass through DeviceManager policy. */
export class HostDeviceBackend extends ForwardingDeviceBackend {
  private readonly devices = new Map<string, { host: DeviceHostBackend; nativeUdid: string }>();
  private readonly backends = new Map<string, DeviceBackend>();
  private readonly listeners = new Set<(udids: readonly string[]) => void>();
  private disposed = false;
  private testingSuspensions = 0;
  private readonly deviceTestingSuspensions = new Map<string, number>();
  private readonly summaries = new Map<string, DeviceHostSummary>();
  private readonly inventories = new Map<
    DeviceHostBackend,
    readonly (DeviceDescriptor & { nativeUdid: string; host: DeviceHostBackend["host"] })[]
  >();
  private readonly discoveries = new Map<
    DeviceHostBackend,
    Promise<DiscoveryVersion | undefined>
  >();
  private readonly probes = new Map<DeviceHostBackend, Promise<DeviceAvailability>>();
  private readonly mutationEpochs = new Map<DeviceHostBackend, number>();
  private readonly mutations = new Map<DeviceHostBackend, number>();
  private readonly generations = new Map<DeviceHostBackend, number>();
  /** Each host's last answer, so a slow probe reports it rather than an outage. */
  private readonly lastAvailability = new Map<DeviceHostBackend, DeviceAvailability>();
  private readonly hostUnsubscribes = new Map<DeviceHostBackend, () => void>();

  private hosts: readonly DeviceHostBackend[];
  constructor(hosts: readonly DeviceHostBackend[]) {
    super();
    this.hosts = hosts;
    if (new Set(hosts.map(({ host }) => host.id)).size !== hosts.length) {
      throw new DeviceBackendError("Duplicate device host identity");
    }
    for (const entry of hosts) this.register(entry);
  }

  private register(entry: DeviceHostBackend): void {
    this.summaries.set(entry.host.id, { ...entry.host, status: "unknown" });
    const stop = entry.backend.onDisconnect?.(() => this.invalidate(entry, "disconnected"));
    if (stop) this.hostUnsubscribes.set(entry, stop);
  }

  /**
   * Drop a host's routes and cached answers under a new generation, and tell
   * the manager which devices went with it (their attachments and boots end).
   */
  private invalidate(entry: DeviceHostBackend, reason: "disconnected" | "removed"): void {
    if (reason === "disconnected") {
      this.summaries.set(entry.host.id, {
        ...entry.host,
        status: "disconnected",
        availability: "SSH device host disconnected. Refresh to reconnect.",
      });
    } else {
      this.summaries.delete(entry.host.id);
    }
    this.inventories.delete(entry);
    this.discoveries.delete(entry);
    this.probes.delete(entry);
    this.lastAvailability.delete(entry);
    this.generations.set(entry, (this.generations.get(entry) ?? 0) + 1);
    const ids = [...this.devices].filter(([, value]) => value.host === entry).map(([id]) => id);
    for (const id of ids) this.devices.delete(id);
    for (const listener of this.listeners) listener(ids);
  }

  /**
   * Replace the SSH hosts without a restart. A host whose destination is
   * unchanged (same identity) keeps its connection and devices, renamed if
   * need be; a removed one is invalidated like a disconnect, then closed, so
   * its worker on the Mac releases its boots. The local host never changes.
   */
  async setRemoteHosts(remote: readonly DeviceHostBackend[]): Promise<void> {
    if (this.disposed) throw new DeviceBackendError("Device hosts disposed");
    if (new Set(remote.map(({ host }) => host.id)).size !== remote.length) {
      throw new DeviceBackendError("Duplicate device host identity");
    }
    const next = new Map(remote.map((entry) => [entry.host.id, entry]));
    const kept: DeviceHostBackend[] = [];
    const removed: DeviceHostBackend[] = [];
    for (const entry of this.hosts) {
      if (entry.host.transport === "local") {
        kept.push(entry);
        continue;
      }
      const replacement = next.get(entry.host.id);
      if (!replacement) {
        removed.push(entry);
        continue;
      }
      next.delete(entry.host.id);
      if (replacement.host.name !== entry.host.name) {
        // Same destination under a new name: device selections survive.
        (entry as { host: DeviceHostSummary }).host = {
          ...entry.host,
          name: replacement.host.name,
        };
        const summary = this.summaries.get(entry.host.id);
        if (summary) this.summaries.set(entry.host.id, { ...summary, name: replacement.host.name });
      }
      // The unused replacement was never connected.
      void replacement.backend.dispose().catch(() => undefined);
      kept.push(entry);
    }
    for (const entry of next.values()) {
      this.register(entry);
      kept.push(entry);
    }
    this.hosts = kept;
    for (const entry of removed) {
      this.hostUnsubscribes.get(entry)?.();
      this.hostUnsubscribes.delete(entry);
      this.invalidate(entry, "removed");
      const instances = new Set([entry.backend]);
      for (const [udid, backend] of this.backends) {
        if (udid.startsWith(`ssh:${entry.host.id}:`)) {
          instances.add(backend);
          this.backends.delete(udid);
        }
      }
      await Promise.allSettled([...instances].map((backend) => backend.dispose()));
    }
  }

  onDisconnect(listener: (udids: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hostSummaries(): readonly DeviceHostSummary[] {
    return [...this.summaries.values()];
  }

  private probe(entry: DeviceHostBackend): Promise<DeviceAvailability> {
    const existing = this.probes.get(entry);
    if (existing) return existing;
    const generation = this.generations.get(entry) ?? 0;
    const work = (async (): Promise<DeviceAvailability> => {
      let availability: DeviceAvailability;
      try {
        availability = await entry.backend.availability();
      } catch {
        availability = {
          kind: "helper-unavailable",
          message: `${entry.host.name}: SSH device host unavailable. Check access and refresh.`,
        };
      }
      if (this.disposed || generation !== (this.generations.get(entry) ?? 0)) {
        return {
          kind: "helper-unavailable",
          message: "Device host generation changed. Refresh devices.",
        };
      }
      this.lastAvailability.set(entry, availability);
      this.summaries.set(entry.host.id, {
        ...entry.host,
        status: availability.kind === "available" ? "available" : "setup-required",
        availability:
          availability.kind === "helper-unavailable" ? availability.message : availability.kind,
      });
      return availability;
    })().finally(() => {
      if (this.probes.get(entry) === work) this.probes.delete(entry);
    });
    this.probes.set(entry, work);
    return work;
  }

  override async availability(): Promise<DeviceAvailability> {
    if (this.disposed) throw new DeviceBackendError("Device hosts disposed");
    const statuses = await Promise.all(
      this.hosts.map(async (entry) => {
        const work = this.probe(entry);
        const known = this.lastAvailability.get(entry);
        // This node's first answer is worth waiting for: cut short, a first
        // open would say the helper is unavailable while it is only checking.
        if (known === undefined && entry.host.transport === "local") return await work;
        // A slow probe (a simulator booting) reports the host's last answer.
        return (await boundedHostWait(work)) ?? known;
      }),
    );
    return (
      statuses.find((s) => s?.kind === "available") ??
      statuses.find((s) => s && s.kind !== "unsupported-platform") ??
      (statuses.some((s) => s === undefined)
        ? {
            kind: "helper-unavailable",
            message: "Device hosts are still responding. Refresh to check again.",
          }
        : { kind: "unsupported-platform", platform: process.platform })
    );
  }

  /** This node's own platforms, each on its own; SSH hosts report through their summaries. */
  async platformAvailability(): Promise<readonly DevicePlatformAvailability[]> {
    const local = this.hosts.find((entry) => entry.host.transport === "local");
    return (await local?.backend.platformAvailability?.()) ?? [];
  }

  async detail(
    udid: string,
    options?: { readonly bundleId?: string | undefined },
  ): Promise<DeviceBackendDetail> {
    const { backend, nativeUdid, host } = this.resolve(udid);
    if (host.host.transport === "ssh" || !backend.detail)
      throw new DeviceBackendError("Device settings cannot be read on SSH hosts.");
    const generation = this.generations.get(host) ?? 0;
    const result = await backend.detail(nativeUdid, options);
    if (this.disposed || generation !== (this.generations.get(host) ?? 0))
      throw new DeviceBackendError("Stale device host operation");
    return result;
  }

  /** Single flight per host; only a complete current-generation result replaces routes. */
  private refreshHost(entry: DeviceHostBackend): Promise<DiscoveryVersion | undefined> {
    const existing = this.discoveries.get(entry);
    if (existing) return existing;
    const generation = this.generations.get(entry) ?? 0;
    const epoch = this.mutationEpochs.get(entry) ?? 0;
    const startedDuringMutation = (this.mutations.get(entry) ?? 0) > 0;
    const work = (async () => {
      try {
        const discovery = entry.backend.discoverDevices
          ? await entry.backend.discoverDevices()
          : {
              devices: await entry.backend.listDevices({ includeShutdown: true }),
              completeFor: () => true,
            };
        const devices = discovery.devices;
        if (
          this.disposed ||
          generation !== (this.generations.get(entry) ?? 0) ||
          startedDuringMutation ||
          epoch !== (this.mutationEpochs.get(entry) ?? 0)
        )
          return undefined;
        const retained = (this.inventories.get(entry) ?? []).filter(
          (device) => !discovery.completeFor(device.nativeUdid ?? device.udid),
        );
        const retainedIds = new Set(retained.map((device) => device.udid));
        const inventory = devices
          .filter((device) => !retainedIds.has(hostDeviceId(entry.host.id, device.udid)))
          .map((device) =>
            Object.assign({}, device, {
              udid: hostDeviceId(entry.host.id, device.udid),
              nativeUdid: device.udid,
              host: this.summaries.get(entry.host.id) ?? entry.host,
              name:
                entry.host.id === "local"
                  ? device.name
                  : `${device.name} · ${entry.host.name}`.slice(0, 256),
            }),
          );
        inventory.push(...retained);
        for (const [id, route] of this.devices) {
          if (route.host === entry) this.devices.delete(id);
        }
        for (const device of inventory)
          this.devices.set(device.udid, { host: entry, nativeUdid: device.nativeUdid });
        this.inventories.set(entry, inventory);
        return { generation, epoch, completeFor: discovery.completeFor };
      } catch {
        return undefined;
      }
    })().finally(() => {
      if (this.discoveries.get(entry) === work) this.discoveries.delete(entry);
    });
    this.discoveries.set(entry, work);
    return work;
  }

  private hostFor(udid: string): DeviceHostBackend | undefined {
    return this.hosts.find(({ host }) =>
      host.id === "local" ? !udid.startsWith("ssh:") : udid.startsWith(`ssh:${host.id}:`),
    );
  }

  async discoverDevices(targetUdid?: string): Promise<DeviceDiscovery> {
    if (this.disposed) throw new DeviceBackendError("Device hosts disposed");
    const complete = new Map<DeviceHostBackend, DiscoveryVersion>();
    const refreshes = new Map(
      this.hosts.map((entry) => {
        const work = this.refreshHost(entry).then((version) => {
          if (version) complete.set(entry, version);
        });
        return [entry, work] as const;
      }),
    );
    const budgetedRefresh = boundedHostWait(Promise.all(refreshes.values()));
    if (targetUdid !== undefined) {
      const target = this.hostFor(targetUdid);
      if (target) await refreshes.get(target);
    }
    await budgetedRefresh;
    const devices = this.hosts.flatMap((entry) => this.inventories.get(entry) ?? []);
    if (devices.length > 256)
      throw new DeviceBackendError("Too many devices across configured hosts (maximum 256).");
    // Capture completeness now: a late result cannot retroactively authorize a boot/release.
    const completed = new Map(complete);
    return {
      devices,
      completeFor: (udid) => {
        const host = this.hostFor(udid);
        return (
          !this.disposed &&
          host !== undefined &&
          completed.has(host) &&
          completed.get(host)?.generation === (this.generations.get(host) ?? 0) &&
          completed.get(host)?.epoch === (this.mutationEpochs.get(host) ?? 0) &&
          completed
            .get(host)!
            .completeFor(
              host.host.id === "local" ? udid : udid.slice(`ssh:${host.host.id}:`.length),
            )
        );
      },
    };
  }

  override async listDevices(
    options?: Parameters<DeviceBackend["listDevices"]>[0],
  ): Promise<readonly DeviceDescriptor[]> {
    const { devices } = await this.discoverDevices();
    return options?.includeShutdown
      ? devices
      : devices.filter((device) => device.state !== "shutdown");
  }

  private resolve(udid: string): {
    backend: DeviceBackend;
    nativeUdid: string;
    host: DeviceHostBackend;
  } {
    if (this.disposed) throw new DeviceBackendError("Device hosts disposed");
    const route = this.devices.get(udid);
    if (!route)
      throw new DeviceBackendError(
        "Unknown or disconnected device. Refresh devices and select it again.",
      );
    let backend = this.backends.get(udid);
    if (!backend) {
      backend = route.host.createDeviceBackend?.() ?? route.host.backend;
      this.backends.set(udid, backend);
    }
    return { ...route, backend };
  }

  suspendTesting(udid?: string): () => void {
    if (udid === undefined) this.testingSuspensions += 1;
    else
      this.deviceTestingSuspensions.set(udid, (this.deviceTestingSuspensions.get(udid) ?? 0) + 1);
    const resumes: (() => void)[] = [];
    if (udid === undefined) {
      // Include cached per-device instances, even if discovery removed their route.
      const instances = new Set([
        ...this.hosts.map((entry) => entry.backend),
        ...this.backends.values(),
      ]);
      for (const backend of instances) resumes.push(backend.suspendTesting());
    } else {
      const host = this.hostFor(udid);
      if (host) {
        const nativeUdid =
          host.host.id === "local" ? udid : udid.slice(`ssh:${host.host.id}:`.length);
        const instances = new Set([host.backend, this.backends.get(udid)]);
        for (const backend of instances)
          if (backend) resumes.push(backend.suspendTesting(nativeUdid));
      }
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      for (const resume of resumes) resume();
      if (udid === undefined) this.testingSuspensions -= 1;
      else {
        const remaining = (this.deviceTestingSuspensions.get(udid) ?? 1) - 1;
        if (remaining === 0) this.deviceTestingSuspensions.delete(udid);
        else this.deviceTestingSuspensions.set(udid, remaining);
      }
    };
  }

  async testing(input: Parameters<DeviceBackend["testing"]>[0]): Promise<void> {
    if (this.testingSuspensions > 0 || (this.deviceTestingSuspensions.get(input.udid) ?? 0) > 0)
      throw new DeviceBackendError("Simulator testing was superseded by a lifecycle change.");
    const { backend, nativeUdid, host } = this.resolve(input.udid);
    if (host.host.transport === "ssh")
      throw new DeviceBackendError("Simulator testing controls are unavailable on SSH hosts.");
    const generation = this.generations.get(host) ?? 0;
    await backend.testing({ ...input, udid: nativeUdid });
    if (this.disposed || generation !== (this.generations.get(host) ?? 0))
      throw new DeviceBackendError("Stale device host operation");
  }

  async readLogs(udid: string, query: DeviceLogQuery): Promise<DeviceLogResult> {
    const { backend, nativeUdid, host } = this.resolve(udid);
    if (host.host.transport === "ssh")
      throw new DeviceBackendError("Device logs are unavailable on SSH hosts.");
    const generation = this.generations.get(host) ?? 0;
    const result = await backend.readLogs(nativeUdid, query);
    if (this.disposed || generation !== (this.generations.get(host) ?? 0))
      throw new DeviceBackendError("Stale device host operation");
    return result;
  }

  async call<K extends DeviceCall>(method: K, args: DeviceArgs<K>): Promise<DeviceResult<K>> {
    // These are dispatched by overrides above, never sent to an arbitrary device.
    if (method === "availability" || method === "listDevices")
      throw new DeviceBackendError("Invalid device route");
    const udid = args[0] as string;
    const { backend, nativeUdid, host } = this.resolve(udid);
    const generation = this.generations.get(host) ?? 0;
    const fn = backend[method] as (...args: unknown[]) => Promise<unknown>;
    const changesInventory = method === "boot" || method === "shutdown";
    if (changesInventory) {
      this.mutationEpochs.set(host, (this.mutationEpochs.get(host) ?? 0) + 1);
      this.mutations.set(host, (this.mutations.get(host) ?? 0) + 1);
    }
    let result: unknown;
    try {
      result = await fn.call(backend, nativeUdid, ...args.slice(1));
    } finally {
      if (changesInventory) {
        this.mutationEpochs.set(host, (this.mutationEpochs.get(host) ?? 0) + 1);
        this.mutations.set(host, (this.mutations.get(host) ?? 1) - 1);
      }
    }
    if (
      this.disposed ||
      generation !== (this.generations.get(host) ?? 0) ||
      !this.devices.has(udid)
    )
      throw new DeviceBackendError("Stale device host operation");
    if (method === "boot" || method === "shutdown") {
      // Factory adapters have separate discovery caches. Keep the host's known
      // state current so a failed SDK refresh cannot replace a successful boot
      // with the root adapter's pre-boot shutdown observation.
      const inventory = this.inventories.get(host) ?? [];
      this.inventories.set(
        host,
        inventory.map((device) =>
          device.udid === udid
            ? { ...device, state: method === "boot" ? "booted" : "shutdown" }
            : device,
        ),
      );
    }
    if (result && typeof result === "object" && "udid" in result) {
      return {
        ...result,
        udid,
        ...(method === "boot" ? { host: host.host, nativeUdid } : {}),
      } as DeviceResult<K>;
    }
    return result as DeviceResult<K>;
  }

  geometry(udid: string): DeviceGeometry | null {
    const route = this.devices.get(udid);
    return route
      ? (this.backends.get(udid) ?? route.host.backend).geometry(route.nativeUdid)
      : null;
  }

  uprightFrames(udid: string): boolean {
    const route = this.devices.get(udid);
    const backend = route ? (this.backends.get(udid) ?? route.host.backend) : null;
    return backend?.uprightFrames?.(route!.nativeUdid) ?? false;
  }

  previewMode(udid: string): "video" | "screenshots" | null {
    const route = this.devices.get(udid);
    const backend = route ? (this.backends.get(udid) ?? route.host.backend) : null;
    return backend?.previewMode?.(route!.nativeUdid) ?? null;
  }

  async requestKeyframe(udid: string): Promise<boolean> {
    const route = this.devices.get(udid);
    const backend = route ? (this.backends.get(udid) ?? route.host.backend) : null;
    return (await backend?.requestKeyframe?.(route!.nativeUdid)) ?? false;
  }

  async attachStream(udid: string, listener: DeviceFrameListener): Promise<void> {
    const route = this.resolve(udid);
    await route.backend.attachStream(route.nativeUdid, (frame) => {
      if (!this.disposed && this.devices.get(udid)?.host === route.host) listener(frame);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const stop of this.hostUnsubscribes.values()) stop();
    this.hostUnsubscribes.clear();
    this.listeners.clear();
    await Promise.allSettled(
      [...new Set([...this.backends.values(), ...this.hosts.map((h) => h.backend)])].map((b) =>
        b.dispose(),
      ),
    );
    this.backends.clear();
    this.devices.clear();
    this.inventories.clear();
  }
}
