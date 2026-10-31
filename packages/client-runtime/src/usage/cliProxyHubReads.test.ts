import { AuthRpcError, EnvironmentId } from "@ryco/contracts";
import type {
  CliProxyHubSnapshot,
  CliProxyReadHubsInput,
  CliProxyReadHubsResult,
  ServerConfig,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLI_PROXY_HUB_READ_REUSE_MS,
  CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
  CliProxyHubReads,
  cliProxyHubsSupported,
  isCliProxyHubReadRefused,
  readCliProxyHubsOutcome,
} from "./cliProxyHubReads.ts";

const MAC = EnvironmentId.make("mac");
const MINI = EnvironmentId.make("mini");

function hub(label: string): CliProxyHubSnapshot {
  return {
    hubId: label as CliProxyHubSnapshot["hubId"],
    label,
    url: "https://hub.example.test",
    checkedAt: "2026-10-31T10:00:00.000Z",
    status: "ok",
    accounts: [],
    apiKeys: [],
    routedInstanceIds: [],
  };
}

/** A node whose hub reads the test answers one by one. */
function node() {
  const answers: Array<{
    readonly environmentId: EnvironmentId;
    readonly input: CliProxyReadHubsInput;
    readonly resolve: (result: CliProxyReadHubsResult) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  const readHubs = vi.fn(
    (environmentId: EnvironmentId, input: CliProxyReadHubsInput) =>
      new Promise<CliProxyReadHubsResult>((resolve, reject) => {
        answers.push({ environmentId, input, resolve, reject });
      }),
  );
  return { readHubs, answers };
}

const config = (cliProxyHubs: boolean | undefined) =>
  ({
    environment: { capabilities: cliProxyHubs === undefined ? {} : { cliProxyHubs } },
  }) as unknown as Pick<ServerConfig, "environment">;

describe("cliProxyHubsSupported", () => {
  it("asks a node whose config is unknown or reports hubs, never one that predates them", () => {
    expect(cliProxyHubsSupported(null)).toBe(true);
    expect(cliProxyHubsSupported(undefined)).toBe(true);
    expect(cliProxyHubsSupported(config(true))).toBe(true);
    expect(cliProxyHubsSupported(config(false))).toBe(false);
    expect(cliProxyHubsSupported(config(undefined))).toBe(false);
  });
});

describe("readCliProxyHubsOutcome", () => {
  const now = () => 42;

  it("reads a session the node refuses hub reads as having none", async () => {
    const refusal = new AuthRpcError({ message: "Owner access required.", status: 403 });
    expect(isCliProxyHubReadRefused(refusal)).toBe(true);
    expect(isCliProxyHubReadRefused(new Error("AuthRpcError"))).toBe(false);
    await expect(readCliProxyHubsOutcome(() => Promise.reject(refusal), now)).resolves.toEqual({
      status: "ok",
      hubs: [],
      receivedAtMs: 42,
    });
  });

  it("calls a node that does not know the call unsupported, and reports other failures", async () => {
    await expect(
      readCliProxyHubsOutcome(
        () => Promise.reject(new Error("Unknown request tag: server.readCliProxyHubs")),
        now,
      ),
    ).resolves.toEqual({
      status: "unsupported",
      hubs: [],
      message: CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
      receivedAtMs: 42,
    });
    await expect(
      readCliProxyHubsOutcome(() => Promise.reject(new Error("Hub unreachable")), now),
    ).resolves.toMatchObject({ status: "failed", hubs: [], message: "Hub unreachable" });
  });
});

describe("CliProxyHubReads", () => {
  it("answers a successful read again for 30 s, then asks the node again", async () => {
    let now = 1_000;
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs }, { now: () => now });

    const first = reads.read(MAC);
    answers[0]!.resolve({ hubs: [hub("Home")] });
    expect(await first).toMatchObject({ status: "ok", hubs: [hub("Home")], receivedAtMs: 1_000 });

    now += CLI_PROXY_HUB_READ_REUSE_MS;
    expect(await reads.read(MAC)).toBe(await first);
    expect(readHubs).toHaveBeenCalledTimes(1);

    now += 1;
    const later = reads.read(MAC);
    expect(readHubs).toHaveBeenCalledTimes(2);
    answers[1]!.resolve({ hubs: [] });
    expect((await later).hubs).toEqual([]);
  });

  it("joins identical reads in flight, per node", async () => {
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs });

    const first = reads.read(MAC);
    const second = reads.read(MAC);
    const other = reads.read(MINI);
    expect(second).toBe(first);
    expect(readHubs).toHaveBeenCalledTimes(2);
    expect(answers.map((answer) => answer.environmentId)).toEqual([MAC, MINI]);
    answers[0]!.resolve({ hubs: [hub("Home")] });
    answers[1]!.resolve({ hubs: [hub("Office")] });
    expect((await first).hubs).toEqual([hub("Home")]);
    expect((await other).hubs).toEqual([hub("Office")]);
  });

  it("asks the node to bypass its caches on a refresh, never reusing an earlier answer", async () => {
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs });

    const first = reads.read(MAC);
    answers[0]!.resolve({ hubs: [hub("Home")] });
    await first;
    const refreshed = reads.read(MAC, { refresh: true });
    expect(answers[1]?.input).toEqual({ refresh: true });
    answers[1]!.resolve({ hubs: [hub("Home"), hub("Office")] });
    expect((await refreshed).hubs).toHaveLength(2);
    // The refreshed answer is the one reused next.
    expect((await reads.read(MAC)).hubs).toHaveLength(2);
    expect(readHubs).toHaveBeenCalledTimes(2);
    expect(answers[0]?.input).toEqual({});
  });

  it("does not ask a node that predates hubs", async () => {
    const { readHubs } = node();
    const reads = new CliProxyHubReads({ readHubs, supportsHubs: (id) => id !== MINI });

    expect(await reads.read(MINI)).toMatchObject({
      status: "unsupported",
      hubs: [],
      message: CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
    });
    expect(readHubs).not.toHaveBeenCalled();
  });

  it("asks again after a failure, and keeps the last good answer readable", async () => {
    let now = 0;
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs }, { now: () => now });

    const good = reads.read(MAC);
    answers[0]!.resolve({ hubs: [hub("Home")] });
    await good;
    now += CLI_PROXY_HUB_READ_REUSE_MS + 1;
    const failed = reads.read(MAC);
    answers[1]!.reject(new Error("Hub unreachable"));
    expect(await failed).toMatchObject({ status: "failed", message: "Hub unreachable" });
    expect(reads.snapshot().get(MAC)?.hubs).toEqual([hub("Home")]);

    void reads.read(MAC);
    expect(readHubs).toHaveBeenCalledTimes(3);
  });

  it("caches a refused read like any other, as no hubs", async () => {
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs });

    const refused = reads.read(MAC);
    answers[0]!.reject(new AuthRpcError({ message: "Owner access required.", status: 403 }));
    expect(await refused).toMatchObject({ status: "ok", hubs: [] });
    expect(await reads.read(MAC)).toMatchObject({ status: "ok", hubs: [] });
    expect(readHubs).toHaveBeenCalledTimes(1);
  });

  it("publishes each node's last successful read to subscribers", async () => {
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs });
    const listener = vi.fn();
    const unsubscribe = reads.subscribe(listener);
    const before = reads.snapshot();

    const read = reads.read(MAC);
    answers[0]!.resolve({ hubs: [hub("Home")] });
    await read;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reads.snapshot()).not.toBe(before);
    expect([...reads.snapshot().keys()]).toEqual([MAC]);

    unsubscribe();
    reads.forget(MAC);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reads.snapshot().size).toBe(0);
  });

  it("keeps a read started before forget or clear from coming back", async () => {
    const { readHubs, answers } = node();
    const reads = new CliProxyHubReads({ readHubs });

    const forgotten = reads.read(MAC);
    reads.forget(MAC);
    // A read after forget asks again instead of joining the forgotten one.
    void reads.read(MAC);
    expect(readHubs).toHaveBeenCalledTimes(2);
    answers[0]!.resolve({ hubs: [hub("Old")] });
    await forgotten;
    expect(reads.snapshot().has(MAC)).toBe(false);

    const cleared = reads.read(MINI);
    reads.clear();
    answers[2]!.resolve({ hubs: [hub("Old")] });
    await cleared;
    expect(reads.snapshot().size).toBe(0);
  });
});
