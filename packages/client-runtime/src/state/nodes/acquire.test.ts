import { EnvironmentId, type EnvironmentApi } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireNodeConnection,
  isNodeLeaseLostError,
  NODE_ACQUIRE_TIMEOUT_MESSAGE,
  NODE_ACQUIRE_TIMEOUT_MS,
  NODE_SCOPE_RENEW_INTERVAL_MS,
  NodeAcquireError,
  projectCopyNodeRefusal,
  type NodeAcquireConnection,
  type NodeAcquirePorts,
  type ProjectCopyConnectionScope,
} from "./acquire.js";

const environmentId = EnvironmentId.make("env-target");
const api = { marker: "api" } as unknown as EnvironmentApi;

interface FakeHold {
  readonly scopes: ProjectCopyConnectionScope[];
  readonly release: ReturnType<typeof vi.fn>;
  readonly renew: ReturnType<typeof vi.fn>;
}

function fakeHold(): FakeHold & { readonly retain: NodeAcquirePorts["retain"] } {
  const scopes: ProjectCopyConnectionScope[] = [];
  const release = vi.fn();
  const renew = vi.fn();
  return {
    scopes,
    release,
    renew,
    retain: (scope) => {
      scopes.push(scope);
      return { release, renew };
    },
  };
}

function connection(current: () => boolean = () => true): NodeAcquireConnection {
  return { api, isCurrent: current };
}

/** A connect port that resolves only when told to, and honours its signal. */
function pendingConnect() {
  let resolve: (value: NodeAcquireConnection) => void = () => undefined;
  const signals: AbortSignal[] = [];
  const connect = vi.fn(
    (signal: AbortSignal) =>
      new Promise<NodeAcquireConnection>((res, reject) => {
        signals.push(signal);
        resolve = res;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  return { connect, signals, resolve: (value: NodeAcquireConnection) => resolve(value) };
}

describe("acquireNodeConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the copy's scope and hands out calls through the acquired connection", async () => {
    const hold = fakeHold();
    const acquired = await acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: {
        transport: "direct",
        retain: hold.retain,
        connect: async () => connection(),
      },
    });
    expect(hold.scopes).toEqual([{ type: "project-copy", copyId: "copy-1" }]);
    expect(acquired).toMatchObject({ environmentId, api, transport: "direct" });
    expect(acquired.isCurrent()).toBe(true);
    await expect(acquired.withLease(async (received) => received)).resolves.toBe(api);

    acquired.release();
    acquired.release();
    expect(hold.release).toHaveBeenCalledTimes(1);
    expect(acquired.isCurrent()).toBe(false);
    const call = vi.fn(async () => "sent");
    await expect(acquired.withLease(call)).rejects.toSatisfy(isNodeLeaseLostError);
    expect(call).not.toHaveBeenCalled();
  });

  it("renews the held scope at half its lease until released", async () => {
    const hold = fakeHold();
    const acquired = await acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: { transport: "relay", retain: hold.retain, connect: async () => connection() },
    });
    await vi.advanceTimersByTimeAsync(NODE_SCOPE_RENEW_INTERVAL_MS - 1);
    expect(hold.renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hold.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(NODE_SCOPE_RENEW_INTERVAL_MS);
    expect(hold.renew).toHaveBeenCalledTimes(2);
    acquired.release();
    await vi.advanceTimersByTimeAsync(NODE_SCOPE_RENEW_INTERVAL_MS * 3);
    expect(hold.renew).toHaveBeenCalledTimes(2);
  });

  it("gives up after 30 s with the platform's message and releases the scope", async () => {
    const hold = fakeHold();
    const pending = pendingConnect();
    const acquiring = acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: {
        transport: "relay",
        retain: hold.retain,
        connect: pending.connect,
        timeoutMessage: () => "Mac mini is offline",
      },
    });
    const outcome = acquiring.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(NODE_ACQUIRE_TIMEOUT_MS - 1);
    expect(hold.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(NodeAcquireError);
    expect(error).toMatchObject({ failure: "timeout", message: "Mac mini is offline" });
    expect(pending.signals[0]?.aborted).toBe(true);
    expect(hold.release).toHaveBeenCalledTimes(1);
    // Renewal stops with the hold.
    await vi.advanceTimersByTimeAsync(NODE_SCOPE_RENEW_INTERVAL_MS * 2);
    expect(hold.renew).toHaveBeenCalledTimes(1);
  });

  it("uses the slot message when the platform has no better one", async () => {
    const pending = pendingConnect();
    const outcome = acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: { transport: "relay", retain: fakeHold().retain, connect: pending.connect },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(NODE_ACQUIRE_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ message: NODE_ACQUIRE_TIMEOUT_MESSAGE });
  });

  it("stops when the caller cancels", async () => {
    const hold = fakeHold();
    const controller = new AbortController();
    const pending = pendingConnect();
    const outcome = acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: { transport: "direct", retain: hold.retain, connect: pending.connect },
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await outcome).toMatchObject({ name: "NodeAcquireError", failure: "cancelled" });
    expect(hold.release).toHaveBeenCalledTimes(1);
  });

  it("passes a definite connection failure through and releases the scope", async () => {
    const hold = fakeHold();
    const refused = new Error("The saved credential was refused.");
    await expect(
      acquireNodeConnection({
        environmentId,
        copyId: "copy-1",
        label: "Mac mini",
        ports: {
          transport: "direct",
          retain: hold.retain,
          connect: async () => {
            throw refused;
          },
        },
      }),
    ).rejects.toBe(refused);
    expect(hold.release).toHaveBeenCalledTimes(1);
  });

  it("waits for the mutation lease and refuses calls once it is no longer current", async () => {
    let leaseCurrent = true;
    let grantLease: (check: () => boolean) => void = () => undefined;
    const acquiring = acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: {
        transport: "relay",
        retain: fakeHold().retain,
        connect: async () => connection(),
        awaitMutationLease: () =>
          new Promise((resolve) => {
            grantLease = resolve;
          }),
      },
    });
    let settled = false;
    void acquiring.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    grantLease(() => leaseCurrent);
    const acquired = await acquiring;

    const call = vi.fn(async () => "imported");
    await expect(acquired.withLease(call)).resolves.toBe("imported");
    leaseCurrent = false;
    const error = await acquired.withLease(call).catch((reason: unknown) => reason);
    expect(isNodeLeaseLostError(error)).toBe(true);
    expect(error).toMatchObject({ environmentId, message: "Reconnecting to Mac mini" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(acquired.isCurrent()).toBe(false);
    // Reads need no lease: the connection itself is still the acquired one.
    expect(acquired.isConnected()).toBe(true);
    acquired.release();
    expect(acquired.isConnected()).toBe(false);
  });

  it("never calls through a connection that was replaced", async () => {
    let current = true;
    const acquired = await acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: {
        transport: "direct",
        retain: fakeHold().retain,
        connect: async () => connection(() => current),
      },
    });
    expect(acquired.isConnected()).toBe(true);
    current = false;
    expect(acquired.isConnected()).toBe(false);
    const call = vi.fn(async () => "sent");
    await expect(acquired.withLease(call)).rejects.toSatisfy(isNodeLeaseLostError);
    expect(call).not.toHaveBeenCalled();
  });

  it("tries again when the connection was replaced while the lease was awaited", async () => {
    let attempt = 0;
    const connect = vi.fn(async () => {
      attempt += 1;
      const stale = attempt === 1;
      return connection(() => !stale);
    });
    const acquiring = acquireNodeConnection({
      environmentId,
      copyId: "copy-1",
      label: "Mac mini",
      ports: {
        transport: "relay",
        retain: fakeHold().retain,
        connect,
        awaitMutationLease: async () => () => true,
      },
    });
    await vi.advanceTimersByTimeAsync(250);
    const acquired = await acquiring;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(acquired.isCurrent()).toBe(true);
  });

  it("refuses a copy id the scope keys and Desktop's preload would not carry", async () => {
    const hold = fakeHold();
    await expect(
      acquireNodeConnection({
        environmentId,
        copyId: "../copy",
        label: "Mac mini",
        ports: { transport: "direct", retain: hold.retain, connect: async () => connection() },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(hold.scopes).toEqual([]);
  });
});

describe("projectCopyNodeRefusal", () => {
  const node = {
    label: "Mac mini",
    canMutate: true,
    presence: "online",
    mutateBlockedReason: null,
  } as const;

  it("refuses a reachable node that takes no changes, and the Hub without owner access", () => {
    expect(projectCopyNodeRefusal(node, { hosted: false, owner: false })).toBeNull();
    expect(
      projectCopyNodeRefusal(
        { ...node, canMutate: false, mutateBlockedReason: "Update Ryco on Mac mini" },
        { hosted: false, owner: false },
      ),
    ).toBe("Update Ryco on Mac mini");
    expect(
      projectCopyNodeRefusal({ ...node, canMutate: false }, { hosted: false, owner: false }),
    ).toBe("Mac mini is not available right now");
    expect(projectCopyNodeRefusal(node, { hosted: true, owner: false })).toBe(
      "Copying projects with Mac mini needs owner access to it",
    );
    expect(projectCopyNodeRefusal(node, { hosted: true, owner: true })).toBeNull();
  });

  it("lets an offline or connecting node be tried", () => {
    for (const presence of ["offline", "connecting"] as const) {
      expect(
        projectCopyNodeRefusal(
          { ...node, presence, canMutate: false },
          { hosted: false, owner: false },
        ),
      ).toBeNull();
    }
  });
});
