import { isProjectCopyLeaseLostError, isProjectCopyNodeUnavailableError } from "./index.ts";
import { NodeLeaseLostError, type AcquiredNode } from "../state/nodes/index.ts";
import { EnvironmentId, type EnvironmentApi, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  callNodeWithLease,
  createProjectCopyNodeIo,
  type ProjectCopyNodeAcquire,
} from "./nodeIo.ts";

const MINI = EnvironmentId.make("env-mini");
const LAPTOP = EnvironmentId.make("env-laptop");

interface FakeNode {
  readonly node: AcquiredNode;
  readonly api: EnvironmentApi;
  readonly release: ReturnType<typeof vi.fn>;
  setLeaseCurrent(current: boolean): void;
  setConnected(connected: boolean): void;
}

function fakeNode(
  environmentId: EnvironmentId,
  options: { readonly transport?: "direct" | "relay"; readonly config?: ServerConfig } = {},
): FakeNode {
  let leaseCurrent = true;
  let connected = true;
  let released = false;
  const api = {
    server: { getConfig: vi.fn(async () => options.config ?? ({} as ServerConfig)) },
  } as unknown as EnvironmentApi;
  const release = vi.fn(() => {
    released = true;
  });
  const isConnected = () => !released && connected;
  const isCurrent = () => isConnected() && leaseCurrent;
  const node: AcquiredNode = {
    environmentId,
    api,
    transport: options.transport ?? "direct",
    isCurrent,
    isConnected,
    withLease: (call) =>
      isCurrent() ? call(api) : Promise.reject(new NodeLeaseLostError(environmentId, "Mac mini")),
    release,
  };
  return {
    node,
    api,
    release,
    setLeaseCurrent: (current) => {
      leaseCurrent = current;
    },
    setConnected: (value) => {
      connected = value;
    },
  };
}

/** An acquire that hands out the given nodes in order and records each request. */
function acquireFrom(...nodes: FakeNode[]) {
  const queue = [...nodes];
  const requests: Array<{ environmentId: EnvironmentId; copyId: string; purpose: string }> = [];
  const acquire: ProjectCopyNodeAcquire = async (environmentId, options) => {
    requests.push({ environmentId, copyId: options.copyId, purpose: options.purpose });
    const next = queue.shift();
    if (!next) throw new Error("No node to hand out.");
    return next.node;
  };
  return { acquire, requests };
}

const signal = () => new AbortController().signal;

/** The app's connection registry: listeners hear every registration, replacement or removal. */
function connectionRegistry() {
  const listeners = new Set<() => void>();
  return {
    subscribeConnections: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changed: () => {
      for (const listener of Array.from(listeners)) listener();
    },
    listeners,
  };
}

describe("createProjectCopyNodeIo", () => {
  it("holds a node for the copy with its id and purpose, and reports the transport", async () => {
    const mini = fakeNode(MINI, { transport: "relay" });
    const { acquire, requests } = acquireFrom(mini);
    const io = createProjectCopyNodeIo({ acquire, ...connectionRegistry() });

    const handle = await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });

    expect(requests).toEqual([{ environmentId: MINI, copyId: "copy-1", purpose: "copy" }]);
    expect(handle).toMatchObject({ environmentId: MINI, transport: "relay" });
    handle.release();
    handle.release();
    expect(mini.release).toHaveBeenCalledTimes(1);
  });

  it("writes under the held node's lease and fails a stale lease before anything is sent", async () => {
    const mini = fakeNode(MINI);
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom(mini).acquire,
      ...connectionRegistry(),
    });
    await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });

    const call = vi.fn(async (api: unknown) => api);
    await expect(io.withLease(MINI, call)).resolves.toBe(mini.api);

    mini.setLeaseCurrent(false);
    const error = await io.withLease(MINI, call).catch((reason: unknown) => reason);
    expect(isProjectCopyLeaseLostError(error)).toBe(true);
    expect(error).toMatchObject({ environmentId: MINI, message: "Reconnecting to Mac mini" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("treats a write to a node it does not hold as a lost lease, so the copy acquires it", async () => {
    const io = createProjectCopyNodeIo({ acquire: acquireFrom().acquire, ...connectionRegistry() });
    const call = vi.fn(async () => "sent");
    const error = await io.withLease(MINI, call).catch((reason: unknown) => reason);
    expect(isProjectCopyLeaseLostError(error)).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("reads through the acquired connection whatever its lease, until it is replaced", async () => {
    const mini = fakeNode(MINI);
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom(mini).acquire,
      ...connectionRegistry(),
    });
    await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });

    // A relay renewal revokes the lease; the import subscription keeps going.
    mini.setLeaseCurrent(false);
    await expect(io.withNode(MINI, async (api) => api)).resolves.toBe(mini.api);

    mini.setConnected(false);
    const call = vi.fn(async () => "read");
    const error = await io.withNode(MINI, call).catch((reason: unknown) => reason);
    expect(isProjectCopyNodeUnavailableError(error)).toBe(true);
    expect(call).not.toHaveBeenCalled();
    await expect(io.withNode(LAPTOP, call)).rejects.toSatisfy(isProjectCopyNodeUnavailableError);
  });

  it("signals a read's connection going, so a subscription on it is not waited on forever", async () => {
    const mini = fakeNode(MINI);
    const registry = connectionRegistry();
    const io = createProjectCopyNodeIo({ acquire: acquireFrom(mini).acquire, ...registry });
    await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "follow",
      signal: signal(),
    });
    const lost = await io.withNode(MINI, async (_api, connectionLost) => connectionLost);
    expect(lost.aborted).toBe(false);

    // Another node's connection changing leaves this one alone.
    registry.changed();
    expect(lost.aborted).toBe(false);

    // The node's connection is replaced: its transport ends the subscription without an error.
    mini.setConnected(false);
    registry.changed();
    expect(lost.aborted).toBe(true);
    expect(registry.listeners.size).toBe(0);
  });

  it("signals the connection gone when the hold is released or the IO disposed", async () => {
    const registry = connectionRegistry();
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom(fakeNode(MINI), fakeNode(LAPTOP)).acquire,
      ...registry,
    });
    const mini = await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "follow",
      signal: signal(),
    });
    await io.acquireNode({
      environmentId: LAPTOP,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });
    const miniLost = await io.withNode(MINI, async (_api, connectionLost) => connectionLost);
    const laptopLost = await io.withNode(LAPTOP, async (_api, connectionLost) => connectionLost);
    expect(registry.listeners.size).toBe(2);

    mini.release();
    expect(miniLost.aborted).toBe(true);
    expect(laptopLost.aborted).toBe(false);

    io.dispose();
    expect(laptopLost.aborted).toBe(true);
    expect(registry.listeners.size).toBe(0);
  });

  it("keeps the newer hold when the copy lets go of an earlier one", async () => {
    const copyHold = fakeNode(MINI);
    const followHold = fakeNode(MINI);
    const { acquire, requests } = acquireFrom(copyHold, followHold);
    const io = createProjectCopyNodeIo({ acquire, ...connectionRegistry() });
    const copyHandle = await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });
    // The import was accepted: the target drops to following it.
    const followHandle = await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "follow",
      signal: signal(),
    });
    copyHandle.release();

    expect(requests.map((request) => request.purpose)).toEqual(["copy", "follow"]);
    expect(copyHold.release).toHaveBeenCalledTimes(1);
    await expect(io.withNode(MINI, async (api) => api)).resolves.toBe(followHold.api);

    followHandle.release();
    await expect(io.withNode(MINI, async (api) => api)).rejects.toSatisfy(
      isProjectCopyNodeUnavailableError,
    );
  });

  it("sleeps until the delay passes or the copy stops, and never rejects", async () => {
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom().acquire,
      ...connectionRegistry(),
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    });

    let slept = false;
    const sleeping = io.sleep(500, signal()).then(() => {
      slept = true;
    });
    expect(timers[0]?.ms).toBe(500);
    await Promise.resolve();
    expect(slept).toBe(false);
    timers[0]!.callback();
    await sleeping;
    expect(slept).toBe(true);

    const stop = new AbortController();
    const aborted = io.sleep(30_000, stop.signal);
    stop.abort();
    await expect(aborted).resolves.toBeUndefined();
    expect(timers[1]?.cleared).toBe(true);

    await expect(io.sleep(10, stop.signal)).resolves.toBeUndefined();
    expect(timers).toHaveLength(2);
  });

  it("reads a node's config from its connection's report, else from the node", async () => {
    const reported = { cwd: "/reported" } as unknown as ServerConfig;
    const fetched = { cwd: "/fetched" } as unknown as ServerConfig;
    const mini = fakeNode(MINI, { config: fetched });
    const readApi = vi.fn(() => undefined);
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom(mini).acquire,
      ...connectionRegistry(),
      readCachedConfig: (environmentId) => (environmentId === LAPTOP ? reported : null),
      readApi,
    });

    await expect(io.readServerConfig(LAPTOP)).resolves.toBe(reported);
    // Not held and not connected here: nothing to ask.
    await expect(io.readServerConfig(MINI)).resolves.toBeNull();
    expect(readApi).toHaveBeenCalledWith(MINI);

    await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });
    await expect(io.readServerConfig(MINI)).resolves.toBe(fetched);
  });

  it("releases every hold it still has when disposed", async () => {
    const mini = fakeNode(MINI);
    const laptop = fakeNode(LAPTOP);
    const io = createProjectCopyNodeIo({
      acquire: acquireFrom(mini, laptop).acquire,
      ...connectionRegistry(),
    });
    await io.acquireNode({
      environmentId: MINI,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });
    await io.acquireNode({
      environmentId: LAPTOP,
      copyId: "copy-1",
      purpose: "copy",
      signal: signal(),
    });

    io.dispose();
    expect(mini.release).toHaveBeenCalledTimes(1);
    expect(laptop.release).toHaveBeenCalledTimes(1);
    await expect(io.withLease(MINI, async () => "sent")).rejects.toSatisfy(
      isProjectCopyLeaseLostError,
    );
  });
});

describe("callNodeWithLease", () => {
  it("holds the node for one write and lets go of it", async () => {
    const mini = fakeNode(MINI);
    const { acquire, requests } = acquireFrom(mini);
    await expect(
      callNodeWithLease(MINI, async () => "reported", { copyId: "copy-1", acquire }),
    ).resolves.toBe("reported");
    expect(requests).toEqual([{ environmentId: MINI, copyId: "copy-1", purpose: "copy" }]);
    expect(mini.release).toHaveBeenCalledTimes(1);
  });

  it("acquires the node again when its lease went stale before the write", async () => {
    const stale = fakeNode(MINI);
    stale.setLeaseCurrent(false);
    const fresh = fakeNode(MINI);
    const { acquire } = acquireFrom(stale, fresh);
    const call = vi.fn(async (api: EnvironmentApi) => api);

    await expect(callNodeWithLease(MINI, call, { copyId: "copy-1", acquire })).resolves.toBe(
      fresh.api,
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(stale.release).toHaveBeenCalledTimes(1);
    expect(fresh.release).toHaveBeenCalledTimes(1);
  });

  it("gives up after its attempts and does not retry a failed write", async () => {
    const stale = fakeNode(MINI);
    stale.setLeaseCurrent(false);
    await expect(
      callNodeWithLease(MINI, async () => "sent", {
        copyId: "copy-1",
        attempts: 1,
        acquire: acquireFrom(stale).acquire,
      }),
    ).rejects.toBeInstanceOf(NodeLeaseLostError);

    const mini = fakeNode(MINI);
    const { acquire, requests } = acquireFrom(mini, fakeNode(MINI));
    await expect(
      callNodeWithLease(
        MINI,
        async () => {
          throw new Error("refused");
        },
        { copyId: "copy-1", acquire },
      ),
    ).rejects.toThrow("refused");
    expect(requests).toHaveLength(1);
  });
});
