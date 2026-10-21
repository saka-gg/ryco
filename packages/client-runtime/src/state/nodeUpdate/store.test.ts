import { EnvironmentId, type NodeUpdateInput, type NodeUpdateState } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { nodeUpdateState as nodeState } from "../../../test/nodeUpdateFixtures.ts";
import {
  createNodeUpdateStore,
  NODE_UPDATE_OUTCOME_TIMEOUT_MS,
  NodeUpdateNotAttachedError,
  readNodeUpdateOutcome,
  type NodeUpdateClient,
} from "./store.ts";

const ENV = EnvironmentId.make("env-node-update");
const OTHER = EnvironmentId.make("env-node-update-other");

interface FakeSubscription {
  readonly listener: (state: NodeUpdateState) => void;
  readonly options: {
    readonly onError?: (kind?: "unsupported" | "response-too-large" | "failed") => void;
    readonly classifyFailure?: (error: unknown) => "unsupported" | "response-too-large" | "failed";
    readonly onResubscribe?: () => void;
  };
  active: boolean;
}

function fakeClient() {
  const subscriptions: FakeSubscription[] = [];
  const checkNodeUpdate = vi.fn(async (): Promise<NodeUpdateState> => nodeState());
  const updateNode = vi.fn(async (input: NodeUpdateInput): Promise<NodeUpdateState> =>
    nodeState({
      run: { status: "preparing", requestId: input.requestId, targetVersion: input.targetVersion },
    }),
  );
  const client = {
    server: {
      subscribeNodeUpdate: (
        listener: FakeSubscription["listener"],
        options: FakeSubscription["options"] = {},
      ) => {
        const subscription: FakeSubscription = { listener, options, active: true };
        subscriptions.push(subscription);
        return () => {
          subscription.active = false;
        };
      },
      checkNodeUpdate,
      updateNode,
    },
  } as unknown as NodeUpdateClient;
  const latest = () => subscriptions.at(-1)!;
  /** What the transport does when a stream fails for good. */
  const fail = (error: unknown) => {
    const subscription = latest();
    subscription.active = false;
    const kind = subscription.options.classifyFailure?.(error);
    subscription.options.onError?.(kind);
  };
  return {
    client,
    subscriptions,
    checkNodeUpdate,
    updateNode,
    latest,
    emit: (state: NodeUpdateState) => latest().listener(state),
    fail,
  };
}

const flushMicrotasks = () => Promise.resolve().then(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("readNodeUpdateOutcome", () => {
  const request = { requestId: "req-1", targetVersion: "0.1.36" };

  it("reads the matching run's terminal status", () => {
    expect(
      readNodeUpdateOutcome(
        nodeState({ run: { status: "succeeded", requestId: "req-1", message: "Done" } }),
        request,
      ),
    ).toEqual({ outcome: "succeeded", message: "Done" });
    expect(
      readNodeUpdateOutcome(
        nodeState({ run: { status: "failed", requestId: "req-1", message: "npm exited 1" } }),
        request,
      ),
    ).toEqual({ outcome: "failed", message: "npm exited 1" });
    expect(
      readNodeUpdateOutcome(
        nodeState({ run: { status: "postponed", requestId: "req-1" } }),
        request,
      )?.outcome,
    ).toBe("postponed");
  });

  it("counts a node back on the target release as succeeded and ignores other requests", () => {
    expect(readNodeUpdateOutcome(nodeState({ currentVersion: "0.1.36" }), request)).toEqual({
      outcome: "succeeded",
      message: null,
    });
    expect(
      readNodeUpdateOutcome(nodeState({ run: { status: "failed", requestId: "other" } }), request),
    ).toBeNull();
    expect(
      readNodeUpdateOutcome(
        nodeState({ run: { status: "restarting", requestId: "req-1" } }),
        request,
      ),
    ).toBeNull();
  });
});

describe("createNodeUpdateStore", () => {
  it("publishes streamed states with a snapshot that changes identity only on change", () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    const listener = vi.fn();
    store.subscribe(listener);
    const empty = store.snapshot();
    expect(store.read(ENV)).toBeNull();

    store.attach(ENV, fake.client);
    expect(fake.subscriptions).toHaveLength(1);
    fake.emit(nodeState());
    const first = store.snapshot();
    expect(first).not.toBe(empty);
    expect(store.read(ENV)?.currentVersion).toBe("0.1.35");
    expect(listener).toHaveBeenCalledTimes(1);

    // An equal state (a fresh object) changes nothing.
    fake.emit(nodeState());
    expect(store.snapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    fake.emit(nodeState({ availability: "current", latestVersion: "0.1.35" }));
    expect(store.snapshot()).not.toBe(first);
    expect(store.snapshot().get(ENV)?.availability).toBe("current");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("shares one subscription per client and tears it down after the last detach", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    const detachFirst = store.attach(ENV, fake.client);
    const detachSecond = store.attach(ENV, fake.client);
    expect(fake.subscriptions).toHaveLength(1);
    fake.emit(nodeState());

    detachFirst();
    detachFirst();
    await flushMicrotasks();
    expect(fake.latest().active).toBe(true);
    expect(store.read(ENV)).not.toBeNull();

    detachSecond();
    await flushMicrotasks();
    expect(fake.latest().active).toBe(false);
    expect(store.read(ENV)).toBeNull();
  });

  it("hands the stream over when an effect re-runs (detach, then attach)", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    const detach = store.attach(ENV, fake.client);
    fake.emit(nodeState());
    detach();
    store.attach(ENV, fake.client);
    await flushMicrotasks();
    expect(fake.subscriptions).toHaveLength(1);
    expect(fake.latest().active).toBe(true);
    expect(store.read(ENV)).not.toBeNull();
  });

  it("replaces the subscription for a new client and keeps the last state until it reports", () => {
    const store = createNodeUpdateStore();
    const first = fakeClient();
    const second = fakeClient();
    store.attach(ENV, first.client);
    first.emit(nodeState());
    const staleListener = first.latest().listener;

    store.attach(ENV, second.client);
    expect(first.latest().active).toBe(false);
    expect(second.subscriptions).toHaveLength(1);
    expect(store.read(ENV)?.currentVersion).toBe("0.1.35");

    // A late value from the old connection is ignored.
    staleListener(nodeState({ currentVersion: "0.0.1" }));
    expect(store.read(ENV)?.currentVersion).toBe("0.1.35");

    second.emit(nodeState({ currentVersion: "0.1.36", availability: "current" }));
    expect(store.read(ENV)?.currentVersion).toBe("0.1.36");
  });

  it("keeps the last state across a dropped stream and follows the restarted node", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    fake.emit(nodeState());
    const outcome = store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" });
    fake.emit(nodeState({ run: { status: "restarting", requestId: "req-1" } }));

    // The node goes down: the transport keeps the same subscription and resubscribes
    // once the restarted node accepts the connection. Nothing is cleared meanwhile.
    expect(store.read(ENV)?.run.status).toBe("restarting");
    fake.latest().options.onResubscribe?.();
    fake.emit(
      nodeState({
        currentVersion: "0.1.36",
        availability: "current",
        run: { status: "succeeded", requestId: "req-1", message: "Updated to 0.1.36." },
      }),
    );
    await expect(outcome).resolves.toEqual({ outcome: "succeeded", message: "Updated to 0.1.36." });
    expect(fake.subscriptions).toHaveLength(1);
  });

  it("follows again after a stream failed for good, with backoff", async () => {
    vi.useFakeTimers();
    const store = createNodeUpdateStore({ resubscribeDelayMs: 1_000 });
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    fake.emit(nodeState());
    const outcome = store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" });

    fake.fail(new Error("Node update service crashed"));
    expect(store.read(ENV)).not.toBeNull();
    vi.advanceTimersByTime(999);
    expect(fake.subscriptions).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(fake.subscriptions).toHaveLength(2);

    // A second failure in a row waits twice as long.
    fake.fail(new Error("still down"));
    vi.advanceTimersByTime(1_999);
    expect(fake.subscriptions).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(fake.subscriptions).toHaveLength(3);

    fake.emit(nodeState({ currentVersion: "0.1.36", availability: "current" }));
    await expect(outcome).resolves.toEqual({ outcome: "succeeded", message: null });
  });

  it("clears the state without retrying when the node lacks the stream or refuses the session", () => {
    vi.useFakeTimers();
    for (const error of [
      new Error("Unknown request tag: server.subscribeNodeUpdate"),
      { _tag: "AuthRpcError", message: "owner only" },
    ]) {
      const store = createNodeUpdateStore({ resubscribeDelayMs: 10 });
      const fake = fakeClient();
      store.attach(ENV, fake.client);
      fake.emit(nodeState());
      fake.fail(error);
      expect(store.read(ENV)).toBeNull();
      vi.advanceTimersByTime(60_000);
      expect(fake.subscriptions).toHaveLength(1);
    }
  });

  it("stops a pending resubscribe on detach", async () => {
    vi.useFakeTimers();
    const store = createNodeUpdateStore({ resubscribeDelayMs: 10 });
    const fake = fakeClient();
    const detach = store.attach(ENV, fake.client);
    fake.fail(new Error("boom"));
    detach();
    await flushMicrotasks();
    vi.advanceTimersByTime(60_000);
    expect(fake.subscriptions).toHaveLength(1);
  });

  it("resolves the matching run's failure and postponement", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    store.attach(OTHER, fakeClient().client);
    fake.emit(nodeState());
    const failed = store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" });
    const postponed = store.waitForOutcome(ENV, { requestId: "req-2", targetVersion: "0.1.36" });
    fake.emit(
      nodeState({ run: { status: "failed", requestId: "req-1", message: "npm exited 1" } }),
    );
    await expect(failed).resolves.toEqual({ outcome: "failed", message: "npm exited 1" });
    fake.emit(nodeState({ run: { status: "postponed", requestId: "req-2" } }));
    await expect(postponed).resolves.toMatchObject({ outcome: "postponed" });
  });

  it("resolves at once from a state already showing the outcome", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    fake.emit(nodeState({ currentVersion: "0.1.36", availability: "current" }));
    await expect(
      store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" }),
    ).resolves.toEqual({ outcome: "succeeded", message: null });
  });

  it("reports unknown on timeout (10 minutes by default) and on abort", async () => {
    vi.useFakeTimers();
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    fake.emit(nodeState());

    const timedOut = store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" });
    let settled = false;
    void timedOut.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(NODE_UPDATE_OUTCOME_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(timedOut).resolves.toMatchObject({ outcome: "unknown" });

    const short = store.waitForOutcome(ENV, {
      requestId: "req-2",
      targetVersion: "0.1.36",
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(short).resolves.toMatchObject({ outcome: "unknown" });

    const abort = new AbortController();
    const aborted = store.waitForOutcome(ENV, {
      requestId: "req-3",
      targetVersion: "0.1.36",
      signal: abort.signal,
    });
    abort.abort();
    await expect(aborted).resolves.toMatchObject({ outcome: "unknown" });
    // A late success no longer matters.
    fake.emit(nodeState({ run: { status: "succeeded", requestId: "req-3" } }));
    await expect(aborted).resolves.toMatchObject({ outcome: "unknown" });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      store.waitForOutcome(ENV, {
        requestId: "req-4",
        targetVersion: "0.1.36",
        signal: preAborted.signal,
      }),
    ).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("keeps waiting while detached and resolves once a re-attached client reports", async () => {
    const store = createNodeUpdateStore();
    const first = fakeClient();
    const detach = store.attach(ENV, first.client);
    first.emit(nodeState());
    const outcome = store.waitForOutcome(ENV, { requestId: "req-1", targetVersion: "0.1.36" });
    detach();
    await flushMicrotasks();
    expect(store.read(ENV)).toBeNull();

    const second = fakeClient();
    store.attach(ENV, second.client);
    second.emit(nodeState({ run: { status: "succeeded", requestId: "req-1" } }));
    await expect(outcome).resolves.toMatchObject({ outcome: "succeeded" });
  });

  it("publishes check and update answers only when the stream was quiet meanwhile", async () => {
    const store = createNodeUpdateStore();
    const fake = fakeClient();
    store.attach(ENV, fake.client);
    fake.emit(nodeState());

    fake.checkNodeUpdate.mockResolvedValueOnce(
      nodeState({ checkedAt: "2026-10-21T01:00:00.000Z" }),
    );
    await store.check(ENV);
    expect(store.read(ENV)?.checkedAt).toBe("2026-10-21T01:00:00.000Z");

    const input = { targetVersion: "0.1.36", requestId: "req-1" };
    let answer!: (state: NodeUpdateState) => void;
    fake.updateNode.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const update = store.update(ENV, input);
    // The stream already moved past what the answer will say.
    fake.emit(nodeState({ run: { status: "verifying", requestId: "req-1" } }));
    answer(nodeState({ run: { status: "preparing", requestId: "req-1" } }));
    await expect(update).resolves.toMatchObject({ run: { status: "preparing" } });
    expect(fake.updateNode).toHaveBeenCalledWith(input);
    expect(store.read(ENV)?.run.status).toBe("verifying");
  });

  it("rejects check and update for an environment nothing attached", async () => {
    const store = createNodeUpdateStore();
    await expect(store.check(ENV)).rejects.toBeInstanceOf(NodeUpdateNotAttachedError);
    await expect(
      store.update(ENV, { targetVersion: "0.1.36", requestId: "req-1" }),
    ).rejects.toBeInstanceOf(NodeUpdateNotAttachedError);
  });
});
