import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";
import { RpcRequestRefusedError } from "@ryco/client-runtime/rpc";

import { QueryClient, type QueryKey } from "./queryClient.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryClient retention", () => {
  it("evicts inactive payloads after gcTime", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultGcTime: 20 });
    await client.fetchQuery({
      queryKey: ["preview", "file-a"],
      queryFn: () => Promise.resolve("large payload"),
      gcTime: 20,
    });

    expect(client.getCacheSize()).toBe(1);
    await vi.advanceTimersByTimeAsync(21);
    expect(client.getCacheSize()).toBe(0);
    expect(client.getQueryData(["preview", "file-a"])).toBeUndefined();
  });

  it("pins subscribed and in-flight entries", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultGcTime: 10 });
    const key = ["details", "one"] as const;
    const unsubscribe = client.subscribe(key, () => undefined);
    client.setQueryData(key, "subscribed");
    await vi.advanceTimersByTimeAsync(50);
    expect(client.getCacheSize()).toBe(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(11);
    expect(client.getCacheSize()).toBe(0);

    let resolveFetch: ((value: string) => void) | undefined;
    const promise = client.fetch(
      ["details", "pending"],
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(client.getCacheSize()).toBe(1);
    resolveFetch?.("done");
    await promise;
    await vi.advanceTimersByTimeAsync(11);
    expect(client.getCacheSize()).toBe(0);
  });

  it("uses prefix-indexed invalidation and refetches only matching observers", async () => {
    const client = new QueryClient();
    const calls: string[] = [];
    const removeIssues = client.addObserver(["source-control", "issues", "a"], {
      refetch: () => calls.push("issues"),
    });
    const removeWorkflows = client.addObserver(["source-control", "workflows", "a"], {
      refetch: () => calls.push("workflows"),
    });
    client.setQueryData(["source-control", "issues", "a"], [1]);
    client.setQueryData(["source-control", "workflows", "a"], [2]);

    await client.invalidateQueries({ queryKey: ["source-control", "issues"] });
    expect(calls).toEqual(["issues"]);
    expect(client.isStale(["source-control", "issues", "a"], 60_000)).toBe(true);
    expect(client.isStale(["source-control", "workflows", "a"], 60_000)).toBe(false);

    removeIssues();
    removeWorkflows();
    client.clear();
  });

  it("evicts least-recent inactive entries before active entries at capacity", () => {
    const client = new QueryClient({ maxEntries: 2, defaultGcTime: 60_000 });
    client.setQueryData(["item", "old"], "old");
    const unsubscribe = client.subscribe(["item", "active"], () => undefined);
    client.setQueryData(["item", "active"], "active");
    client.setQueryData(["item", "new"], "new");

    expect(client.getQueryData(["item", "old"])).toBeUndefined();
    expect(client.getQueryData(["item", "active"])).toBe("active");
    expect(client.getQueryData(["item", "new"])).toBe("new");

    unsubscribe();
    client.clear();
  });
});

describe("QueryClient reconnect refresh", () => {
  const environmentId = EnvironmentId.make("environment-query-client-test");

  it("retries each active failed query once and deduplicates shared observers", async () => {
    const client = new QueryClient();
    const key = ["query", environmentId] as const;
    const run = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ready");
    await expect(client.fetch(key, run, { retry: false })).rejects.toThrow("offline");

    const refetch = () => client.fetch(key, run, { retry: false, force: true });
    const removeFirst = client.addObserver(key, {
      environmentId,
      staleTime: Infinity,
      refetch,
    });
    const removeSecond = client.addObserver(key, {
      environmentId,
      staleTime: Infinity,
      refetch,
    });

    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("ready");
    removeFirst();
    removeSecond();
  });

  it("leaves a read refused until the session is ready to the post-ready refresh", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const key = ["query", environmentId, "awaiting-session"] as const;
    const run = vi
      .fn()
      .mockRejectedValueOnce(new RpcRequestRefusedError("awaiting-session"))
      .mockResolvedValue("ready");
    const refetch = () => client.fetch(key, run, { force: true });
    const remove = client.addObserver(key, { environmentId, staleTime: Infinity, refetch });

    // The default retries do not apply: the refusal settles at once.
    await expect(client.fetch(key, run)).rejects.toBeInstanceOf(RpcRequestRefusedError);
    expect(run).toHaveBeenCalledTimes(1);

    // The session became ready: the refresh runs it again without a backoff.
    await client.refreshActiveQueriesForEnvironment(environmentId);
    expect(run).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("ready");
    remove();
  });

  it("re-runs a refused read when the post-ready refresh joined it in flight", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const key = ["query", environmentId, "refused-in-flight"] as const;
    let refuse!: (error: unknown) => void;
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            refuse = reject;
          }),
      )
      .mockResolvedValue("ready");
    const refetch = () => client.fetch(key, run, { force: true });
    const remove = client.addObserver(key, { environmentId, staleTime: Infinity, refetch });

    // The read was issued before the session was ready; its refusal is still pending
    // when the session becomes ready and the refresh joins the attempt.
    const first = client.fetch(key, run);
    const refresh = client.refreshActiveQueriesForEnvironment(environmentId);
    refuse(new RpcRequestRefusedError("awaiting-session"));

    await expect(first).resolves.toBe("ready");
    await refresh;
    expect(run).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("ready");
    remove();
  });

  it("still retries a read that failed for another reason", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const key = ["query", environmentId, "transient"] as const;
    const run = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ready");

    const result = client.fetch(key, run, { retry: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe("ready");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refreshes stale active data without touching an inactive query", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const activeKey = ["query", environmentId, "active"] as const;
    const inactiveKey = ["query", environmentId, "inactive"] as const;
    client.setQueryData(activeKey, "cached-active");
    client.setQueryData(inactiveKey, "cached-inactive");
    const refetch = vi.fn(() => client.fetch(activeKey, () => Promise.resolve("fresh")));
    const remove = client.addObserver(activeKey, { environmentId, staleTime: 1_000, refetch });

    await client.refreshActiveQueriesForEnvironment(environmentId);
    expect(refetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(activeKey)).toBe("fresh");
    expect(client.getQueryData(inactiveKey)).toBe("cached-inactive");
    remove();
  });

  it("fences a late result from the superseded transport generation", async () => {
    const client = new QueryClient();
    const key = ["query", environmentId, "generation"] as const;
    let resolveStale: ((value: string) => void) | undefined;
    const stale = client.fetch(
      key,
      () =>
        new Promise<string>((resolve) => {
          resolveStale = resolve;
        }),
      { retry: false },
    );
    const refetch = vi.fn(() => client.fetch(key, () => Promise.resolve("current")));
    const remove = client.addObserver(key, { environmentId, staleTime: 0, refetch });

    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.refreshActiveQueriesForEnvironment(environmentId);
    resolveStale?.("stale");
    await stale;

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe("current");
    remove();
  });
});

describe("QueryClient read epochs", () => {
  const environmentId = EnvironmentId.make("environment-read-epoch-test");
  const otherEnvironmentId = EnvironmentId.make("environment-read-epoch-other");

  function observe(client: QueryClient, key: QueryKey, run: () => Promise<string>) {
    return client.addObserver(key, {
      environmentId,
      staleTime: 0,
      refetch: () => client.fetch(key, run, { force: true }),
    });
  }

  it("does not refetch a read that succeeded after the environment's fence", async () => {
    const client = new QueryClient();
    const key = ["read-epoch", environmentId, "current"] as const;
    const run = vi.fn(() => Promise.resolve("current"));
    const remove = observe(client, key, run);

    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.fetch(key, run);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe("current");
    remove();
  });

  it("refetches a read fetched before the fence", async () => {
    const client = new QueryClient();
    const key = ["read-epoch", environmentId, "before-fence"] as const;
    const run = vi.fn().mockResolvedValueOnce("before").mockResolvedValue("after");
    const remove = observe(client, key, run);

    await client.fetch(key, run);
    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("after");
    remove();
  });

  it("a later fence makes the earlier epoch's reads refresh again", async () => {
    const client = new QueryClient();
    const key = ["read-epoch", environmentId, "later-fence"] as const;
    const run = vi.fn(() => Promise.resolve("value"));
    const remove = observe(client, key, run);

    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.fetch(key, run);
    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(2);
    remove();
  });

  it("refetches a read of the current epoch after a local write or invalidation", async () => {
    const client = new QueryClient();
    const writtenKey = ["read-epoch", environmentId, "local-write"] as const;
    const writtenRun = vi.fn(() => Promise.resolve("server"));
    const removeWritten = observe(client, writtenKey, writtenRun);

    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.fetch(writtenKey, writtenRun);
    client.setQueryData(writtenKey, "local");
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(writtenRun).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(writtenKey)).toBe("server");
    removeWritten();

    const invalidatedKey = ["read-epoch", environmentId, "invalidated"] as const;
    const invalidatedRun = vi.fn(() => Promise.resolve("server"));
    client.fenceActiveQueriesForEnvironment(environmentId);
    await client.fetch(invalidatedKey, invalidatedRun);
    await client.invalidateQueries({ queryKey: invalidatedKey });
    const removeInvalidated = observe(client, invalidatedKey, invalidatedRun);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(invalidatedRun).toHaveBeenCalledTimes(2);
    removeInvalidated();
  });

  it("still re-runs a read that failed in the current epoch", async () => {
    const client = new QueryClient();
    const key = ["read-epoch", environmentId, "failed"] as const;
    const run = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ready");
    const remove = observe(client, key, run);

    client.fenceActiveQueriesForEnvironment(environmentId);
    await expect(client.fetch(key, run, { retry: false })).rejects.toThrow("offline");
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(key)).toBe("ready");
    remove();
  });

  it("a fence of another environment does not skip this one", async () => {
    const client = new QueryClient();
    const key = ["read-epoch", environmentId, "other-fence"] as const;
    const run = vi.fn(() => Promise.resolve("value"));
    const remove = observe(client, key, run);

    client.fenceActiveQueriesForEnvironment(otherEnvironmentId);
    await client.fetch(key, run);
    await client.refreshActiveQueriesForEnvironment(environmentId);

    expect(run).toHaveBeenCalledTimes(2);
    remove();
  });
});
