import { OrchestrationShellSnapshot } from "@ryco/contracts";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { startThreadReadCacheSync } from "./ThreadReadCacheSync.ts";

const origin = "https://hub.example.test";
const nodeId = `node_${"a".repeat(22)}`;
const time = "2026-10-04T00:00:00.000Z";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stops: Array<() => Promise<void>> = [];

function harness() {
  let online = true;
  let proofIndex = 0;
  const shell = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
    snapshotSequence: 1,
    updatedAt: time,
    projects: [],
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: time,
        updatedAt: time,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
  });
  const proof = vi.fn(async () => ({
    nodeId,
    protocolMajor: 1,
    protocolMinor: 3,
    nonce: new Uint8Array(32).fill(++proofIndex),
    signature: new Uint8Array(64).fill(1),
  }));
  const identity = {
    readState: vi.fn(async () => ({ activeNode: { nodeId, hubOrigin: origin } })),
    createRelayAuthenticationFrame: proof,
  };
  const owner = vi.fn(async (operation: () => Promise<unknown>) => operation());
  const connector = {
    status: () => ({ state: online ? "online" : "disconnected" }),
    asIdentityOwner: owner,
  };
  const getSequence = vi.fn(() => Effect.succeed({ snapshotSequence: 1 }));
  const getShell = vi.fn(() => Effect.succeed(shell));
  const getWindow = vi.fn(() => Effect.succeed({ snapshotSequence: 1, thread: { messages: [] } }));
  const query = {
    getSnapshotSequence: getSequence,
    getShellSnapshot: getShell,
    getThreadWindow: getWindow,
  };
  const http = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith("/begin") ? json({ protocolVersion: 1, generation: 1 }) : json({ ok: true }),
  );
  vi.stubGlobal("fetch", http);
  const reportFailure = vi.fn();
  const stop = startThreadReadCacheSync({
    hubOrigin: origin,
    identity: identity as unknown as HubIdentityRuntimeShape,
    connector: connector as unknown as HubConnector,
    query: query as unknown as ProjectionSnapshotQueryShape,
    reportFailure,
  });
  stops.push(stop);
  return {
    stop,
    notifyChanged: stop.notifyChanged,
    shell,
    identity,
    proof,
    owner,
    http,
    getSequence,
    getShell,
    getWindow,
    reportFailure,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

function body(call: [string, (RequestInit | undefined)?]) {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cloud thread history sync adapter", () => {
  it("coalesces domain changes and limits sustained streams to one read per second", async () => {
    const h = harness();
    for (let index = 0; index < 100; index++) h.notifyChanged();
    await vi.advanceTimersByTimeAsync(249);
    expect(h.http).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.getSequence).toHaveBeenCalledOnce();
    expect(h.http).toHaveBeenCalledTimes(2);
    h.getSequence.mockReturnValue(Effect.succeed({ snapshotSequence: 2 }));
    h.getShell.mockReturnValue(Effect.succeed({ ...h.shell, snapshotSequence: 2 }));
    for (let index = 0; index < 9; index++) {
      h.notifyChanged();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.getSequence).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.getSequence).toHaveBeenCalledTimes(2);
    expect(h.http).toHaveBeenCalledTimes(3);
    await h.stop();
    h.notifyChanged();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("remembers changes during an upload without overlapping it", async () => {
    const h = harness();
    let complete!: (value: Response) => void;
    h.http.mockImplementationOnce(async () => json({ protocolVersion: 1, generation: 1 }));
    h.http.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    h.notifyChanged();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.http).toHaveBeenCalledTimes(2);
    h.getSequence.mockReturnValue(Effect.succeed({ snapshotSequence: 2 }));
    h.getShell.mockReturnValue(Effect.succeed({ ...h.shell, snapshotSequence: 2 }));
    for (let index = 0; index < 100; index++) h.notifyChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.getSequence).toHaveBeenCalledOnce();
    complete(json({ ok: true }));
    await vi.advanceTimersByTimeAsync(250);
    expect(h.getSequence).toHaveBeenCalledTimes(2);
    expect(h.http).toHaveBeenCalledTimes(3);
  });

  it("does not let domain changes bypass upload failure backoff", async () => {
    const h = harness();
    h.http.mockResolvedValue(json({ error: "not_found" }, 404));
    h.notifyChanged();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.http).toHaveBeenCalledOnce();
    for (let index = 0; index < 59; index++) {
      h.notifyChanged();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.http).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.http).toHaveBeenCalledTimes(2);
  });

  it("does no identity, query, or HTTP work while the relay owner is offline", async () => {
    const h = harness();
    h.setOnline(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.owner).not.toHaveBeenCalled();
    expect(h.getSequence).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
    await h.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses fresh owned proofs per request, reads bounded windows, and leaves unchanged content alone", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.http).toHaveBeenCalledTimes(2);
    expect(h.owner).toHaveBeenCalledTimes(2);
    expect(body(h.http.mock.calls[0]!).proof).not.toEqual(body(h.http.mock.calls[1]!).proof);
    expect(h.getWindow).toHaveBeenCalledWith({
      threadId: "thread-1",
      limits: { messages: 150, proposedPlans: 1, activities: 1, checkpoints: 1 },
    });
    expect(h.http.mock.calls.every((call) => call[1]?.redirect === "error")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.http).toHaveBeenCalledTimes(2);
    expect(h.reportFailure).not.toHaveBeenCalled();
  });

  it("retries an ambiguous batch with the same generation and revisions but a new proof", async () => {
    const h = harness();
    h.http.mockResolvedValueOnce(json({ protocolVersion: 1, generation: 1 }));
    h.http.mockRejectedValueOnce(new Error("response lost"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.http).toHaveBeenCalledTimes(3);
    const { proof: firstProof, ...first } = body(h.http.mock.calls[1]!);
    const { proof: retryProof, ...retry } = body(h.http.mock.calls[2]!);
    expect(retry).toEqual(first);
    expect(retryProof).not.toEqual(firstProof);
  });

  it("does not send a proof that completed after shutdown", async () => {
    const h = harness();
    let complete!: (value: Awaited<ReturnType<typeof h.proof>>) => void;
    h.proof.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.proof).toHaveBeenCalledOnce();
    await h.stop();
    expect(h.http).not.toHaveBeenCalled();
    complete({
      nodeId,
      protocolMajor: 1,
      protocolMinor: 3,
      nonce: new Uint8Array(32),
      signature: new Uint8Array(64),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.http).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops while identity storage is stalled and ignores its late completion", async () => {
    const h = harness();
    let complete!: (value: Awaited<ReturnType<typeof h.identity.readState>>) => void;
    h.identity.readState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.identity.readState).toHaveBeenCalledOnce();
    await h.stop();
    complete({ activeNode: { nodeId, hubOrigin: origin } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.proof).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue a proof when identity ownership arrives after shutdown", async () => {
    const h = harness();
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.owner.mockImplementationOnce(async (operation) => {
      await acquired;
      return operation();
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.owner).toHaveBeenCalledOnce();
    await h.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.proof).not.toHaveBeenCalled();
    expect(h.http).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an outstanding HTTP request on shutdown without scheduling more work", async () => {
    const h = harness();
    let signal: AbortSignal | null = null;
    h.http.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal!;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal).not.toBeNull();
    await h.stop();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("interrupts an outstanding projection read on shutdown", async () => {
    const h = harness();
    h.getSequence.mockReturnValueOnce(Effect.never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.getSequence).toHaveBeenCalledOnce();
    await h.stop();
    expect(h.http).toHaveBeenCalledOnce();
    expect(h.reportFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains diagnostic failures and continues its retry schedule", async () => {
    const h = harness();
    h.http.mockRejectedValueOnce(new Error("offline"));
    h.reportFailure.mockImplementationOnce(() => {
      throw new Error("logging unavailable");
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.http).toHaveBeenCalledTimes(3);
  });

  it("begins a fresh generation after a generation conflict", async () => {
    const h = harness();
    h.http.mockResolvedValueOnce(json({ protocolVersion: 1, generation: 1 }));
    h.http.mockResolvedValueOnce(json({ error: "conflict" }, 409));
    h.http.mockResolvedValueOnce(json({ protocolVersion: 1, generation: 2 }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.http.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
      "begin",
      "snapshot",
      "begin",
      "snapshot",
    ]);
    expect(body(h.http.mock.calls[3]!).generation).toBe(2);
  });

  it("backs off unsupported HTML Hub endpoints for a full minute", async () => {
    const h = harness();
    h.http.mockResolvedValue(new Response("Not found", { status: 404 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.http).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.http).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.http).toHaveBeenCalledTimes(2);
  });

  it("does not publish content to an unsupported begin protocol", async () => {
    const h = harness();
    h.http.mockResolvedValueOnce(json({ protocolVersion: 2, generation: 1 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.http).toHaveBeenCalledOnce();
    expect(h.getShell).not.toHaveBeenCalled();
    expect(h.reportFailure).toHaveBeenCalledOnce();
  });
});
