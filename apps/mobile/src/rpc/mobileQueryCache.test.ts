import type { EnvironmentId } from "@ryco/contracts";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createMobileQueryCache } from "./mobileQueryCache";
import {
  resetSavedQueryStoreForTests,
  setSavedQueryStore,
  type SavedQueryCodec,
} from "./savedQueries";
import { createMemorySavedQueryStore } from "./savedQueries.testSupport";

const ENV = "env-1" as EnvironmentId;

const codec: SavedQueryCodec<{ readonly value: number }> = {
  version: 1,
  encode: (data) => JSON.stringify(data),
  decode: (payload) => JSON.parse(payload) as { value: number },
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const cache = createMobileQueryCache("test-cache");
let answer = deferred<{ value: number }>();
const query = cache.defineQuery<{ readonly id: string }, { readonly value: number }>({
  label: "value",
  staleTime: 60_000,
  retainedKeyLimit: 4,
  isEnabled: () => true,
  buildKey: (input) => `${ENV}${KEY_SEP}${input.id}`,
  resolveEnvironmentId: () => ENV,
  run: () => answer.promise,
  persist: codec,
});
const mirror = cache.defineSavedMirror<{ readonly id: string }, { readonly value: number }>({
  label: "mirror",
  retainedKeyLimit: 4,
  isEnabled: () => true,
  buildKey: (input) => `${ENV}${KEY_SEP}${input.id}`,
  resolveEnvironmentId: () => ENV,
  persist: codec,
});

beforeEach(() => {
  cache.resetForTests();
  resetSavedQueryStoreForTests();
  answer = deferred();
});

describe("saved answers", () => {
  it("shows the saved answer while the live read runs, then the live one", async () => {
    const store = createMemorySavedQueryStore({ now: () => 5 });
    setSavedQueryStore(store);
    const key = query.keyOf({ id: "a" });
    store.save(ENV, `test-cache${KEY_SEP}${key}`, 1, () => '{"value":1}');
    const release = query.watch({ id: "a" });
    await flush();
    expect(query.getSnapshot(key)).toMatchObject({
      data: { value: 1 },
      savedAt: 5,
      isLoading: false,
      isFetching: true,
    });
    answer.resolve({ value: 2 });
    await flush();
    expect(query.getSnapshot(key)).toMatchObject({ data: { value: 2 }, savedAt: null });
    await store.flush();
    expect(store.rows.get(`${ENV}|test-cache${KEY_SEP}${key}`)?.payload).toBe('{"value":2}');
    release();
  });

  it("never lets a late saved answer replace a live one", async () => {
    const store = createMemorySavedQueryStore();
    store.save(ENV, `test-cache${KEY_SEP}${query.keyOf({ id: "b" })}`, 1, () => '{"value":1}');
    const release = query.watch({ id: "b" });
    answer.resolve({ value: 3 });
    await flush();
    // The store is installed only after the live answer landed.
    setSavedQueryStore(store);
    await flush();
    expect(query.getSnapshot(query.keyOf({ id: "b" })).data).toEqual({ value: 3 });
    release();
  });

  it("drops a saved answer that arrives after the environment was torn down", async () => {
    const store = createMemorySavedQueryStore();
    const key = query.keyOf({ id: "c" });
    store.save(ENV, `test-cache${KEY_SEP}${key}`, 1, () => '{"value":1}');
    const release = query.watch({ id: "c" });
    cache.clearEnvironment(ENV);
    setSavedQueryStore(store);
    await flush();
    expect(query.getSnapshot(key).data).toBeNull();
    release();
  });

  it("keeps an optimistic write until a live answer, and never saves it", async () => {
    const store = createMemorySavedQueryStore();
    setSavedQueryStore(store);
    const key = query.keyOf({ id: "d" });
    const release = query.watch({ id: "d" });
    query.writeData(key, () => ({ value: 9 }));
    // The read issued before the write must not publish over it.
    answer.resolve({ value: 1 });
    await flush();
    expect(query.getSnapshot(key).data).toEqual({ value: 9 });
    await store.flush();
    expect(store.rows.size).toBe(0);
    release();
  });
});

describe("saved mirrors", () => {
  it("never reads by itself, saves what its screen writes, and survives a refresh", async () => {
    const store = createMemorySavedQueryStore();
    setSavedQueryStore(store);
    const key = mirror.keyOf({ id: "m" });
    const release = mirror.watch({ id: "m" });
    await flush();
    expect(mirror.getSnapshot(key)).toMatchObject({ data: null, isFetching: false, error: null });
    mirror.writeData(key, () => ({ value: 4 }), { live: true });
    cache.invalidate();
    await flush();
    expect(mirror.getSnapshot(key)).toMatchObject({ data: { value: 4 }, error: null });
    await store.flush();
    expect(store.rows.size).toBe(1);
    release();
  });
});
