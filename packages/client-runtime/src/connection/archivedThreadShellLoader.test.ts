import {
  EnvironmentId,
  ThreadId,
  type OrchestrationGetThreadShellsInput,
  type OrchestrationGetThreadShellsResult,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createArchivedThreadShellLoader,
  type ArchivedThreadShellSource,
} from "./archivedThreadShellLoader.ts";

const env = EnvironmentId.make("environment-loader");
const id = (value: string) => ThreadId.make(value);
const shellOf = (value: string) => ({ id: id(value) }) as unknown as OrchestrationThreadShell;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness(options: { readonly stubs?: ReadonlySet<string> } = {}) {
  const stubs = new Set(options.stubs ?? ["a", "b", "c"]);
  const requests: Array<{
    readonly input: OrchestrationGetThreadShellsInput;
    readonly answer: ReturnType<typeof deferred<OrchestrationGetThreadShellsResult>>;
  }> = [];
  const getThreadShells = vi.fn((input: OrchestrationGetThreadShellsInput) => {
    const answer = deferred<OrchestrationGetThreadShellsResult>();
    requests.push({ input, answer });
    return answer.promise;
  });
  let source: ArchivedThreadShellSource | null = { token: {}, getThreadShells };
  const applied: Array<ReadonlyArray<string>> = [];
  const errors: unknown[] = [];
  const flushes: Array<() => void> = [];
  const loader = createArchivedThreadShellLoader({
    sourceFor: () => source,
    isArchivedThreadStub: (_environmentId, threadId) => stubs.has(threadId),
    apply: (_environmentId, threads) => {
      applied.push(threads.map((thread) => thread.id));
      for (const thread of threads) stubs.delete(thread.id);
    },
    onError: (_environmentId, _threadIds, error) => errors.push(error),
    schedule: (flush) => flushes.push(flush),
  });
  return {
    loader,
    requests,
    applied,
    errors,
    getThreadShells,
    flush: () => {
      for (const flush of flushes.splice(0)) flush();
    },
    setSource: (next: ArchivedThreadShellSource | null) => {
      source = next;
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe("archived thread shell loader", () => {
  it("loads the stubs one tick asks for in one request, and applies the answer", async () => {
    const h = harness();
    h.loader.ensureFullShell(env, id("a"));
    h.loader.ensureFullShell(env, id("b"));
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.requests.map((request) => request.input.threadIds)).toEqual([["a", "b"]]);
    h.requests[0]!.answer.resolve({
      snapshotSequence: 3,
      threads: [shellOf("a"), shellOf("b")],
      remainingThreadIds: [],
    });
    await h.settle();
    expect(h.applied).toEqual([["a", "b"]]);
  });

  it("does nothing for a thread that is not a stub", () => {
    const h = harness({ stubs: new Set() });
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.getThreadShells).not.toHaveBeenCalled();
  });

  it("does not ask again while the same connection is loading the thread", async () => {
    const h = harness();
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.requests).toHaveLength(1);
    h.requests[0]!.answer.resolve({
      snapshotSequence: 3,
      threads: [],
      remainingThreadIds: [],
    });
    await h.settle();
    // Settled: a later open asks again (it is still a stub).
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.requests).toHaveLength(2);
  });

  it("asks again for the shells a bounded answer left out", async () => {
    const h = harness();
    h.loader.ensureFullShell(env, id("a"));
    h.loader.ensureFullShell(env, id("b"));
    h.flush();
    h.requests[0]!.answer.resolve({
      snapshotSequence: 3,
      threads: [shellOf("a")],
      remainingThreadIds: [id("b")],
    });
    await h.settle();
    expect(h.requests.map((request) => request.input.threadIds)).toEqual([["a", "b"], ["b"]]);
    h.requests[1]!.answer.resolve({
      snapshotSequence: 3,
      threads: [shellOf("b")],
      remainingThreadIds: [],
    });
    await h.settle();
    expect(h.applied).toEqual([["a"], ["b"]]);
  });

  it("drops an answer that arrives after the connection changed (reconnect, node switch)", async () => {
    const h = harness();
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    h.setSource({ token: {}, getThreadShells: h.getThreadShells });
    h.requests[0]!.answer.resolve({
      snapshotSequence: 3,
      threads: [shellOf("a")],
      remainingThreadIds: [],
    });
    await h.settle();
    expect(h.applied).toEqual([]);
    // The new connection loads it afresh.
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.requests).toHaveLength(2);
  });

  it("drops an answer for a cleared environment and leaves stubs on failure", async () => {
    const h = harness();
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    h.loader.clearEnvironment(env);
    h.requests[0]!.answer.resolve({
      snapshotSequence: 3,
      threads: [shellOf("a")],
      remainingThreadIds: [],
    });
    await h.settle();
    expect(h.applied).toEqual([]);

    h.loader.ensureFullShell(env, id("b"));
    h.flush();
    h.requests[1]!.answer.reject(new Error("Unknown request tag"));
    await h.settle();
    expect(h.applied).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });

  it("stays quiet without a connection or on a client without the method", () => {
    const h = harness();
    h.setSource(null);
    h.loader.ensureFullShell(env, id("a"));
    h.setSource({ token: {} });
    h.loader.ensureFullShell(env, id("a"));
    h.flush();
    expect(h.getThreadShells).not.toHaveBeenCalled();
  });
});
