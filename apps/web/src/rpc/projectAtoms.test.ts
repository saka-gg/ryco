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

import { hostedHubStore } from "~/hostedHub/state";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  canResolveProjectSearchEntriesLocally,
  clearProjectAtomStateForEnvironment,
  EMPTY_FILESYSTEM_BROWSE_STATE,
  EMPTY_PROJECT_SEARCH_ENTRIES_STATE,
  FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT,
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
  watchFilesystemBrowse,
} from "./projectAtoms";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");
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

function snapshot(query: string, environmentId: EnvironmentId = ENVIRONMENT_ID) {
  return getProjectSearchEntriesSnapshot({
    environmentId,
    cwd: CWD,
    query,
    limit: 80,
  });
}

function browseInput(partialPath: string, environmentId: EnvironmentId = ENVIRONMENT_ID) {
  return { environmentId, partialPath };
}

function browseState(partialPath: string, environmentId: EnvironmentId = ENVIRONMENT_ID) {
  const key = resolveFilesystemBrowseKey(browseInput(partialPath, environmentId));
  if (key === null) throw new Error("expected filesystem browse key");
  return appAtomRegistry.get(getFilesystemBrowseStateAtom(key));
}

function browseResult(parentPath: string): FilesystemBrowseResult {
  return { parentPath, entries: [] };
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

describe("environment-scoped clear", () => {
  it("resets only the given environment's search and browse state", async () => {
    const searchA = result("a.ts");
    const searchB = result("b.ts");
    searchEntries.mockResolvedValueOnce(searchA).mockResolvedValueOnce(searchB);
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) =>
      browseResult(partialPath),
    );
    readEnvironmentApi.mockReturnValue({ filesystem: { browse } });

    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    requestProjectSearchEntries({ environmentId: OTHER_ENVIRONMENT_ID, cwd: CWD, query: "b" });
    requestFilesystemBrowse(browseInput("/workspace/"));
    requestFilesystemBrowse(browseInput("/workspace/", OTHER_ENVIRONMENT_ID));
    await flush();
    expect(snapshot("a").data).toBe(searchA);
    expect(snapshot("b", OTHER_ENVIRONMENT_ID).data).toBe(searchB);
    expect(browseState("/workspace/").data).not.toBeNull();

    clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);

    expect(snapshot("a")).toEqual(EMPTY_PROJECT_SEARCH_ENTRIES_STATE);
    expect(browseState("/workspace/")).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    expect(snapshot("b", OTHER_ENVIRONMENT_ID).data).toBe(searchB);
    expect(browseState("/workspace/", OTHER_ENVIRONMENT_ID).data).toEqual(
      browseResult("/workspace/"),
    );

    // The cleared environment refetches; the other one still answers from cache.
    searchEntries.mockResolvedValueOnce(result("a2.ts"));
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    requestProjectSearchEntries({ environmentId: OTHER_ENVIRONMENT_ID, cwd: CWD, query: "b" });
    requestFilesystemBrowse(browseInput("/workspace/"));
    requestFilesystemBrowse(browseInput("/workspace/", OTHER_ENVIRONMENT_ID));
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(3);
    expect(browse).toHaveBeenCalledTimes(3);
  });

  it("fences responses still in flight for the cleared environment", async () => {
    const search = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(search.promise);
    const pendingBrowse = createDeferred<FilesystemBrowseResult>();
    readEnvironmentApi.mockReturnValue({
      filesystem: { browse: vi.fn(() => pendingBrowse.promise) },
    });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
    const release = watchFilesystemBrowse(browseInput("/workspace/"));
    await flush();

    clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);
    search.resolve(result("a.ts"));
    pendingBrowse.resolve(browseResult("/workspace/"));
    await flush();

    expect(snapshot("a")).toEqual(EMPTY_PROJECT_SEARCH_ENTRIES_STATE);
    expect(browseState("/workspace/")).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    release();
  });

  it("leaves the requests of an environment whose id extends the cleared one untouched", async () => {
    const nestedEnvironmentId = EnvironmentId.make(`${ENVIRONMENT_ID}::nested`);
    const nested = result("nested.ts");
    const search = createDeferred<ProjectSearchEntriesResult>();
    searchEntries.mockReturnValueOnce(search.promise);
    requestProjectSearchEntries({ environmentId: nestedEnvironmentId, cwd: CWD, query: "n" });
    await flush();

    clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);
    search.resolve(nested);
    await flush();

    expect(snapshot("n", nestedEnvironmentId).data).toBe(nested);
  });

  it("stops a rebuilding search from re-asking after its environment was cleared", async () => {
    retainProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
    searchEntries.mockResolvedValue({ ...result("src/old.ts"), refreshing: true });
    requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "src" });
    await flush();
    expect(searchEntries).toHaveBeenCalledTimes(1);

    clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(searchEntries).toHaveBeenCalledTimes(1);
    releaseProjectSearchEntriesScope({ environmentId: ENVIRONMENT_ID, cwd: CWD, limit: 80 });
  });

  it("resets a key that was reused after an earlier clear", async () => {
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) =>
      browseResult(partialPath),
    );
    readEnvironmentApi.mockReturnValue({ filesystem: { browse } });
    searchEntries.mockResolvedValue(result("a.ts"));

    for (let round = 0; round < 2; round += 1) {
      requestProjectSearchEntries({ environmentId: ENVIRONMENT_ID, cwd: CWD, query: "a" });
      requestFilesystemBrowse(browseInput("/workspace/"));
      await flush();
      expect(snapshot("a").data).not.toBeNull();
      expect(browseState("/workspace/").data).not.toBeNull();

      clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);
      expect(snapshot("a")).toEqual(EMPTY_PROJECT_SEARCH_ENTRIES_STATE);
      expect(browseState("/workspace/")).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    }
  });
});

describe("filesystem browse retention", () => {
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) =>
    browseResult(partialPath),
  );

  function path(index: number): string {
    return `/workspace/${index}/`;
  }

  async function visit(partialPath: string): Promise<void> {
    const release = watchFilesystemBrowse(browseInput(partialPath));
    await flush();
    release();
  }

  beforeEach(() => {
    readEnvironmentApi.mockReturnValue({ filesystem: { browse } });
  });

  it("keeps the released limit warm and evicts the oldest beyond it", async () => {
    for (let index = 0; index < FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      await visit(path(index));
    }
    for (let index = 0; index < FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      expect(browseState(path(index)).data).not.toBeNull();
    }

    await visit(path(FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT));

    expect(browseState(path(0))).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    expect(browseState(path(1)).data).not.toBeNull();
    expect(browseState(path(FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT)).data).not.toBeNull();
  });

  it("evicts in release order, not visit order", async () => {
    const releaseFirst = watchFilesystemBrowse(browseInput(path(0)));
    await flush();
    for (let index = 1; index <= FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      await visit(path(index));
    }
    expect(browseState(path(0)).data).not.toBeNull();

    // The first path is the most recently released, so the second one goes.
    releaseFirst();
    expect(browseState(path(1))).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    expect(browseState(path(0)).data).not.toBeNull();
  });

  it("never evicts a key that is observed again after its release", async () => {
    await visit(path(0));
    const release = watchFilesystemBrowse(browseInput(path(0)));
    await flush();
    for (let index = 1; index <= FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT + 4; index += 1) {
      await visit(path(index));
    }

    expect(browseState(path(0)).data).not.toBeNull();
    release();
  });

  it("counts an unobserved request toward the limit", async () => {
    for (let index = 0; index <= FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      requestFilesystemBrowse(browseInput(path(index)));
      await flush();
    }

    expect(browseState(path(0))).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
    expect(browseState(path(1)).data).not.toBeNull();
  });

  it("fences a response that settles after its key was evicted", async () => {
    const pending = createDeferred<FilesystemBrowseResult>();
    browse.mockReturnValueOnce(pending.promise);
    requestFilesystemBrowse(browseInput(path(0)));
    await flush();
    for (let index = 1; index <= FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      await visit(path(index));
    }

    pending.resolve(browseResult(path(0)));
    await flush();

    expect(browseState(path(0))).toEqual(EMPTY_FILESYSTEM_BROWSE_STATE);
  });

  it("ignores a release that outlived a reset of its key", async () => {
    const releaseStale = watchFilesystemBrowse(browseInput(path(0)));
    await flush();
    resetProjectAtomsForTests();
    const releaseCurrent = watchFilesystemBrowse(browseInput(path(0)));
    await flush();

    // A miscounted release would make the observed key evictable.
    releaseStale();
    for (let index = 1; index <= FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT; index += 1) {
      await visit(path(index));
    }

    expect(browseState(path(0)).data).not.toBeNull();
    releaseCurrent();
  });

  it("stops counting a cleared environment's released keys toward the limit", async () => {
    const other = watchFilesystemBrowse(browseInput(path(0), OTHER_ENVIRONMENT_ID));
    await flush();
    other();
    const room = FILESYSTEM_BROWSE_RETAINED_KEY_LIMIT - 1;
    for (let index = 1; index <= room; index += 1) {
      await visit(path(index));
    }
    clearProjectAtomStateForEnvironment(ENVIRONMENT_ID);
    for (let index = 1; index <= room; index += 1) {
      await visit(path(room + index));
    }

    // The other environment's key and the fifteen released since the clear fit the limit.
    expect(browseState(path(0), OTHER_ENVIRONMENT_ID).data).not.toBeNull();
  });
});

describe("filesystem browse unavailable copy", () => {
  const SYNCING_MESSAGE = "Syncing with this node…";
  const UNAVAILABLE_MESSAGE = "The environment is temporarily unavailable. Reconnecting…";

  function node(overrides: Record<string, unknown> = {}) {
    return {
      environmentId: ENVIRONMENT_ID,
      revokedAt: null,
      presence: { online: true, lastHeartbeatAt: null },
      ...overrides,
    } as never;
  }

  function unavailableMessage(): string | undefined {
    readEnvironmentApi.mockReturnValue(undefined);
    requestFilesystemBrowse({ ...browseInput("/workspace/"), staleTime: 0 }, { force: true });
    return browseState("/workspace/").error?.message;
  }

  beforeEach(() => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    hostedHubStore.setState({ nodes: [] });
  });

  it("reports syncing for a known hosted node that is not connected yet", () => {
    hostedHubStore.setState({ nodes: [node()] });

    expect(unavailableMessage()).toBe(SYNCING_MESSAGE);
  });

  it("keeps the unavailable copy for an unknown, revoked, offline or native-only node", () => {
    hostedHubStore.setState({ nodes: [node({ environmentId: OTHER_ENVIRONMENT_ID })] });
    expect(unavailableMessage()).toBe(UNAVAILABLE_MESSAGE);

    hostedHubStore.setState({ nodes: [node({ revokedAt: 1 })] });
    expect(unavailableMessage()).toBe(UNAVAILABLE_MESSAGE);

    hostedHubStore.setState({
      nodes: [node({ presence: { online: false, lastHeartbeatAt: null } })],
    });
    expect(unavailableMessage()).toBe(UNAVAILABLE_MESSAGE);

    hostedHubStore.setState({
      nodes: [node({ capabilities: { repositoryIdentity: true, nativeClientRequired: true } })],
    });
    expect(unavailableMessage()).toBe(UNAVAILABLE_MESSAGE);
  });

  it("keeps the unavailable copy outside hosted mode", () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "standard");
    hostedHubStore.setState({ nodes: [node()] });

    expect(unavailableMessage()).toBe(UNAVAILABLE_MESSAGE);
  });
});
