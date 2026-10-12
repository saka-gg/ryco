import {
  EnvironmentId,
  type FilesystemBrowseResult,
  type ProjectSearchEntriesResult,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readEnvironmentApi, searchEntries } = vi.hoisted(() => ({
  readEnvironmentApi: vi.fn(),
  searchEntries: vi.fn(),
}));

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(() => ({ projects: { searchEntries } })),
  readEnvironmentApi,
}));

import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  canResolveProjectSearchEntriesLocally,
  getFilesystemBrowseStateAtom,
  getProjectSearchEntriesSnapshot,
  invalidateProjectSearchEntries,
  releaseProjectSearchEntriesScope,
  requestFilesystemBrowse,
  requestProjectSearchEntries,
  resolveFilesystemBrowseKey,
  resetProjectAtomsForTests,
  retainProjectSearchEntriesScope,
  retryProjectSearchEntries,
} from "./projectAtoms";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CWD = "/tmp/workspace";

/** A server result that is cut by its limit, so it cannot be narrowed locally. */
function result(...paths: ReadonlyArray<string>): ProjectSearchEntriesResult {
  return {
    entries: paths.map((path) => ({ kind: "file", path })),
    truncated: true,
  } as unknown as ProjectSearchEntriesResult;
}

/** A server result holding every match for its query. */
function completeResult(...paths: ReadonlyArray<string>): ProjectSearchEntriesResult {
  return { ...result(...paths), truncated: false };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function snapshot(query: string) {
  return getProjectSearchEntriesSnapshot({
    environmentId: ENVIRONMENT_ID,
    cwd: CWD,
    query,
    limit: 80,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  resetProjectAtomsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetProjectAtomsForTests();
});

describe("projectAtoms", () => {
  it("keeps a missing environment API retryable instead of caching an empty browse", async () => {
    const browse = vi.fn<() => Promise<FilesystemBrowseResult>>().mockResolvedValue({
      parentPath: "/workspace",
      entries: [],
    });
    const input = {
      environmentId: ENVIRONMENT_ID,
      partialPath: "/workspace/",
    };
    const key = resolveFilesystemBrowseKey(input);
    if (key === null) throw new Error("expected filesystem browse key");

    readEnvironmentApi.mockReturnValueOnce(undefined);
    requestFilesystemBrowse(input);
    await flush();

    expect(appAtomRegistry.get(getFilesystemBrowseStateAtom(key))).toMatchObject({
      data: null,
      isFetching: false,
      isPending: false,
      error: expect.objectContaining({
        message: expect.stringContaining("temporarily unavailable"),
      }),
    });

    readEnvironmentApi.mockReturnValue({ filesystem: { browse } });
    requestFilesystemBrowse(input);
    await flush();

    expect(browse).toHaveBeenCalledWith({ partialPath: "/workspace/" });
    expect(appAtomRegistry.get(getFilesystemBrowseStateAtom(key))).toMatchObject({
      data: { parentPath: "/workspace", entries: [] },
      isFetching: false,
      isPending: false,
      error: null,
    });
  });

  it("does not fetch when gating is disabled or the scope is incomplete", () => {
    requestProjectSearchEntries({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      query: "src",
      enabled: false,
    });
    requestProjectSearchEntries({ environmentId: null, cwd: CWD, query: "src" });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: null, query: "src" });

    expect(searchEntries).not.toHaveBeenCalled();
  });

  it("requests the top-level listing for an empty query", async () => {
    searchEntries.mockResolvedValueOnce(result("src"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "" });
    await flush();

    expect(searchEntries).toHaveBeenCalledWith({ cwd: CWD, query: "", limit: 80 });
    expect(snapshot("").dataQuery).toBe("");
  });

  it("marks the first request as loading and commits the resolved result", async () => {
    const deferred = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(deferred.promise);

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();

    expect(searchEntries).toHaveBeenCalledWith({ cwd: CWD, query: "src", limit: 80 });
    expect(snapshot("src")).toEqual({
      data: null,
      dataQuery: null,
      isLoading: true,
      isFetching: true,
      error: null,
    });

    const entries = result("src/index.ts");
    deferred.resolve(entries);
    await flush();

    expect(snapshot("src")).toEqual({
      data: entries,
      dataQuery: "src",
      isLoading: false,
      isFetching: false,
      error: null,
    });
  });

  it("keeps the previous result visible while a new query loads", async () => {
    const first = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(first.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    await flush();
    const firstResult = result("a.ts");
    first.resolve(firstResult);
    await flush();

    const second = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(second.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "ab" });
    await flush();

    expect(snapshot("ab")).toEqual({
      data: firstResult,
      dataQuery: "a",
      isLoading: false,
      isFetching: true,
      error: null,
    });

    const secondResult = result("ab.ts");
    second.resolve(secondResult);
    await flush();
    expect(snapshot("ab").data).toBe(secondResult);
  });

  it("dedupes an identical in-flight query", async () => {
    searchEntries.mockReturnValue(createDeferred<ProjectSearchEntriesResult>().promise);

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();

    expect(searchEntries).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cached result without refetching within the stale time", async () => {
    const deferred = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(deferred.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    deferred.resolve(result("src/index.ts"));
    await flush();

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20_000);
    searchEntries.mockReturnValueOnce(createDeferred<ProjectSearchEntriesResult>().promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale response that resolves after a newer query", async () => {
    const first = createDeferred<ProjectSearchEntriesResult>();
    const second = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    await flush();
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "ab" });
    await flush();

    const secondResult = result("ab.ts");
    second.resolve(secondResult);
    await flush();
    first.resolve(result("a.ts"));
    await flush();

    expect(snapshot("ab").data).toBe(secondResult);
  });

  it("surfaces fetch errors while keeping the previous data", async () => {
    const first = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(first.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    await flush();
    const firstResult = result("a.ts");
    first.resolve(firstResult);
    await flush();

    const second = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(second.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "ab" });
    await flush();
    second.reject(new Error("boom"));
    await flush();

    const state = snapshot("ab");
    expect(state.data).toBe(firstResult);
    expect(state.isFetching).toBe(false);
    expect(state.error).toEqual(new Error("boom"));
  });

  it("refetches retained scopes and only clears the cache for idle scopes on invalidation", async () => {
    // Idle scope: resolves once, then invalidation clears cache without refetch.
    const idle = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(idle.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    idle.resolve(result("src/index.ts"));
    await flush();

    invalidateProjectSearchEntries();
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(1);

    // After invalidation the cache is empty, so the next request refetches.
    searchEntries.mockReturnValueOnce(createDeferred<ProjectSearchEntriesResult>().promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);
  });

  it("refetches a retained scope's last query when invalidated", async () => {
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });

    const initial = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(initial.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    initial.resolve(result("src/old.ts"));
    await flush();

    const refreshed = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(refreshed.promise);
    invalidateProjectSearchEntries();
    await flush();

    expect(searchEntries).toHaveBeenCalledTimes(2);
    const refreshedResult = result("src/new.ts");
    refreshed.resolve(refreshedResult);
    await flush();
    expect(snapshot("src").data).toBe(refreshedResult);

    releaseProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
  });

  it("scopes invalidation by cwd", async () => {
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    const other = "/tmp/other";
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: other, limit: 80 });

    searchEntries
      .mockReturnValueOnce(Promise.resolve(result("a.ts")))
      .mockReturnValueOnce(Promise.resolve(result("b.ts")));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: other, query: "b" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);

    searchEntries.mockReturnValueOnce(createDeferred<ProjectSearchEntriesResult>().promise);
    invalidateProjectSearchEntries({ cwd: other });
    await flush();

    expect(searchEntries).toHaveBeenCalledTimes(3);
    expect(searchEntries).toHaveBeenLastCalledWith({ cwd: other, query: "b", limit: 80 });
  });

  it("narrows a complete prefix result locally instead of asking the server", async () => {
    searchEntries.mockResolvedValueOnce(
      completeResult("src/components/Composer.tsx", "src/compose.ts", "docs/notes.md"),
    );
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "co" });
    await flush();

    const input = { environmentId: ENVIRONMENT_ID, cwd: CWD, query: "comp", limit: 80 };
    expect(canResolveProjectSearchEntriesLocally(input)).toBe(true);
    requestProjectSearchEntries(input);
    await flush();

    expect(searchEntries).toHaveBeenCalledTimes(1);
    const state = snapshot("comp");
    expect(state.dataQuery).toBe("comp");
    expect(state.isFetching).toBe(false);
    expect(state.data?.truncated).toBe(false);
    expect(state.data?.entries.map((entry) => entry.path)).toEqual([
      "src/compose.ts",
      "src/components/Composer.tsx",
    ]);
  });

  it("asks the server when the prefix result was cut by its limit or is partial", async () => {
    searchEntries.mockResolvedValueOnce(result("src/a.ts"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "s" });
    await flush();
    expect(
      canResolveProjectSearchEntriesLocally({
        environmentId: ENVIRONMENT_ID,
        cwd: CWD,
        query: "sr",
      }),
    ).toBe(false);

    searchEntries.mockResolvedValueOnce({ ...completeResult("src/a.ts"), partial: true });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "x" });
    await flush();
    expect(
      canResolveProjectSearchEntriesLocally({
        environmentId: ENVIRONMENT_ID,
        cwd: CWD,
        query: "xy",
      }),
    ).toBe(false);
  });

  it("never reuses a result from an index that is being rebuilt", async () => {
    searchEntries.mockResolvedValueOnce({ ...completeResult("src/old.ts"), refreshing: true });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(snapshot("src").data?.entries.map((entry) => entry.path)).toEqual(["src/old.ts"]);

    expect(
      canResolveProjectSearchEntriesLocally({
        environmentId: ENVIRONMENT_ID,
        cwd: CWD,
        query: "src/",
      }),
    ).toBe(false);
    searchEntries.mockResolvedValueOnce(completeResult("src/old.ts", "src/new.ts"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);
  });

  it("asks again while an open menu shows a result from an index being rebuilt", async () => {
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    searchEntries.mockResolvedValueOnce({ ...result("src/old.ts"), refreshing: true });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(snapshot("src").data?.entries.map((entry) => entry.path)).toEqual(["src/old.ts"]);

    const rebuilt = result("src/old.ts", "src/new.ts");
    searchEntries.mockResolvedValueOnce(rebuilt);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);
    expect(searchEntries).toHaveBeenLastCalledWith({ cwd: CWD, query: "src", limit: 80 });
    expect(snapshot("src").data).toBe(rebuilt);

    // Settled: nothing further is scheduled.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(searchEntries).toHaveBeenCalledTimes(2);

    releaseProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
  });

  it("does not re-ask for a rebuilding result once the menu closed or the query moved on", async () => {
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    searchEntries.mockResolvedValue({ ...result("src/old.ts"), refreshing: true });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "srv" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(2);

    releaseProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(searchEntries).toHaveBeenCalledTimes(2);
  });

  it("shares cached results between queries that normalize alike", async () => {
    searchEntries.mockResolvedValueOnce(result("src/index.ts"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "@./SRC" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(1);
  });

  it("does not let an older in-flight response overwrite a cached answer", async () => {
    const cached = result("a.ts");
    searchEntries.mockResolvedValueOnce(cached);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    await flush();

    const slow = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(slow.promise);
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "ab" });
    await flush();
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    slow.resolve(result("ab.ts"));
    await flush();

    expect(snapshot("a").data).toBe(cached);
    expect(snapshot("a").dataQuery).toBe("a");
  });

  it("bounds the cached queries per scope", async () => {
    searchEntries.mockImplementation(async ({ query }: { query: string }) => result(`${query}.ts`));
    for (let index = 0; index <= 64; index += 1) {
      requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: `q${index}` });
      await flush();
    }
    expect(searchEntries).toHaveBeenCalledTimes(65);

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "q64" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(65);
    // The least recently used query was evicted.
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "q0" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(66);
  });

  it("retries the scope's last request past the cache", async () => {
    searchEntries.mockRejectedValueOnce(new Error("offline"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(snapshot("src").error).toEqual(new Error("offline"));

    const recovered = result("src/index.ts");
    searchEntries.mockResolvedValueOnce(recovered);
    retryProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    await flush();

    expect(searchEntries).toHaveBeenCalledTimes(2);
    expect(snapshot("src")).toMatchObject({ data: recovered, error: null });
  });
});
