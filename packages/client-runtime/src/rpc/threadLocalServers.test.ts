import { ThreadId, type ThreadLocalServerList } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  describeThreadLocalServerStopFailure,
  type ThreadLocalServersSubscribe,
  watchThreadLocalServers,
} from "./threadLocalServers.ts";

/** A connection's subscribe: records each subscription and lets the test drive it. */
function fakeConnection() {
  const subscriptions: Array<{
    readonly threadId: string;
    readonly emit: (list: ThreadLocalServerList) => void;
    readonly stop: ReturnType<typeof vi.fn>;
  }> = [];
  const subscribe: ThreadLocalServersSubscribe = (input, listener) => {
    const stop = vi.fn();
    subscriptions.push({ threadId: input.threadId, emit: listener, stop });
    return stop;
  };
  return { subscribe, subscriptions };
}

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const listOf = (threadId: ThreadId, ports: ReadonlyArray<number>): ThreadLocalServerList => ({
  threadId,
  scannedAt: "2026-10-31T00:00:00.000Z",
  servers: ports.map((port) => ({
    pid: 100 + port,
    startTimeMs: 1_000,
    port,
    host: "127.0.0.1",
    url: `http://localhost:${port}/`,
    processName: "node",
    pageTitle: null,
    origin: "agent",
  })),
});

describe("watchThreadLocalServers", () => {
  it("shares one subscription per thread and connection, and closes it with its last listener", async () => {
    const connection = fakeConnection();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watchThreadLocalServers(connection.subscribe, threadA, first);
    connection.subscriptions[0]?.emit(listOf(threadA, [5173]));
    const stopSecond = watchThreadLocalServers(connection.subscribe, threadA, second);
    expect(connection.subscriptions).toHaveLength(1);
    // A later listener gets the latest list without a second subscription.
    await Promise.resolve();
    expect(second).toHaveBeenCalledWith(listOf(threadA, [5173]));

    connection.subscriptions[0]?.emit(listOf(threadA, [5173, 3000]));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    stopFirst();
    expect(connection.subscriptions[0]?.stop).not.toHaveBeenCalled();
    stopSecond();
    expect(connection.subscriptions[0]?.stop).toHaveBeenCalledTimes(1);

    // The next listener starts a fresh subscription.
    watchThreadLocalServers(connection.subscribe, threadA, vi.fn());
    expect(connection.subscriptions).toHaveLength(2);
  });

  it("keeps threads and connections apart", () => {
    const one = fakeConnection();
    const other = fakeConnection();
    watchThreadLocalServers(one.subscribe, threadA, vi.fn());
    watchThreadLocalServers(one.subscribe, threadB, vi.fn());
    watchThreadLocalServers(other.subscribe, threadA, vi.fn());
    expect(one.subscriptions.map((entry) => entry.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(other.subscriptions.map((entry) => entry.threadId)).toEqual(["thread-a"]);
  });

  it("does not replay to a listener that left before the replay", async () => {
    const connection = fakeConnection();
    watchThreadLocalServers(connection.subscribe, threadA, vi.fn());
    connection.subscriptions[0]?.emit(listOf(threadA, [5173]));
    const late = vi.fn();
    const stopLate = watchThreadLocalServers(connection.subscribe, threadA, late);
    stopLate();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
});

describe("describeThreadLocalServerStopFailure", () => {
  it("explains each refusal, and a lost answer", () => {
    expect(
      describeThreadLocalServerStopFailure({
        _tag: "ThreadStopLocalServerError",
        reason: "shared-group",
        message: "x",
      }),
    ).toMatch(/process group/);
    expect(
      describeThreadLocalServerStopFailure({
        _tag: "ThreadStopLocalServerError",
        reason: "not-found",
        message: "x",
      }),
    ).toBe("It is no longer running.");
    expect(describeThreadLocalServerStopFailure(new Error("socket closed"))).toBe(
      "The node did not answer. Try again.",
    );
  });
});
