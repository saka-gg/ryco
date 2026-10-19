import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type EnvironmentApi } from "@ryco/contracts";
import {
  clearAllProjectIconCaches,
  clearProjectIconCache,
  peekProjectIconSource,
  projectIconCacheBytes,
  projectIconRequestKey,
  PROJECT_ICON_TTL_MS,
  readProjectIconSource,
} from "./projectIconSource.ts";

const project = ProjectId.make("project");
const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const icon = { mimeType: "image/png", dataBase64: "aWNvbg==" };
function makeApi(
  readIcon: unknown = vi.fn(async () => ({ mimeType: "image/png", dataBase64: "aW1hZ2U=" })),
) {
  return { projects: { readIcon } } as unknown as EnvironmentApi;
}

afterEach(() => {
  vi.useRealTimers();
  clearAllProjectIconCaches();
});

describe("per-device project artwork cache", () => {
  it("clears only the selected environment and measures retained payloads", async () => {
    await readProjectIconSource(makeApi(), environmentA, project, null);
    await readProjectIconSource(makeApi(), environmentB, project, null);
    expect(projectIconCacheBytes(environmentA)).toBeGreaterThan(0);
    clearProjectIconCache(environmentA);
    expect(projectIconCacheBytes(environmentA)).toBe(0);
    expect(projectIconCacheBytes(environmentB)).toBeGreaterThan(0);
  });
  it("drops every environment's artwork on an account teardown", async () => {
    await readProjectIconSource(makeApi(), environmentA, project, null);
    await readProjectIconSource(makeApi(), environmentB, project, null);
    clearAllProjectIconCaches();
    expect(projectIconCacheBytes(environmentA)).toBe(0);
    expect(projectIconCacheBytes(environmentB)).toBe(0);
    expect(peekProjectIconSource(environmentA, project, null)).toBeUndefined();
  });
  it("does not publish or re-cache an old request after a clear", async () => {
    let resolve!: (value: { mimeType: string; dataBase64: string }) => void;
    const api = makeApi(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = readProjectIconSource(api, environmentA, project, null);
    clearProjectIconCache(environmentA);
    resolve({ mimeType: "image/png", dataBase64: "b2xk" });
    expect(await pending).toBeNull();
    expect(projectIconCacheBytes(environmentA)).toBe(0);
    expect(peekProjectIconSource(environmentA, project, null)).toBeUndefined();
  });
});

describe("project icon cache", () => {
  it("deduplicates simultaneous project rows", async () => {
    const read = vi.fn(async () => icon);
    const api = makeApi(read);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => readProjectIconSource(api, environmentA, project, null)),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(results.every((src) => src === "data:image/png;base64,aWNvbg==")).toBe(true);
  });
  it("keeps artwork across reconnects: a new connection to the same node reuses it", async () => {
    const read = vi.fn(async () => icon);
    await readProjectIconSource(makeApi(read), environmentA, project, null);
    // A reconnect builds a new client and API object for the same environment.
    expect(await readProjectIconSource(makeApi(read), environmentA, project, null)).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("never serves one environment's artwork for another", async () => {
    const read = vi.fn(async () => icon);
    await readProjectIconSource(makeApi(read), environmentA, project, null);
    expect(peekProjectIconSource(environmentB, project, null)).toBeUndefined();
    await readProjectIconSource(makeApi(read), environmentB, project, null);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("refreshes after avatar changes and retries failed reads", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(icon);
    const api = makeApi(read);
    await expect(readProjectIconSource(api, environmentA, project, null)).rejects.toThrow(
      "disconnected",
    );
    await readProjectIconSource(api, environmentA, project, null);
    await readProjectIconSource(api, environmentA, project, "new-avatar");
    await readProjectIconSource(api, environmentA, project, "new-avatar");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("peeks the last read artwork past the TTL, while a read after the TTL asks again", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => icon);
    expect(peekProjectIconSource(environmentA, project, null)).toBeUndefined();
    await readProjectIconSource(makeApi(read), environmentA, project, null);
    expect(peekProjectIconSource(environmentA, project, null)).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    expect(peekProjectIconSource(environmentA, project, "other-revision")).toBeUndefined();
    vi.advanceTimersByTime(PROJECT_ICON_TTL_MS + 1);
    // A row whose node is not connected still shows what it last read.
    expect(peekProjectIconSource(environmentA, project, null)).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    await readProjectIconSource(makeApi(read), environmentA, project, null);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("distinguishes request keys by environment, project and revision", () => {
    expect(projectIconRequestKey(environmentA, project, null)).not.toBe(
      projectIconRequestKey(environmentA, project, ""),
    );
    expect(projectIconRequestKey(environmentA, project, null)).not.toBe(
      projectIconRequestKey(environmentB, project, null),
    );
    expect(projectIconRequestKey(environmentA, project, "a")).toBe(
      projectIconRequestKey(environmentA, project, "a"),
    );
  });
  it("caches missing artwork briefly without repeated RPCs", async () => {
    const read = vi.fn(async () => null);
    const api = makeApi(read);
    expect(await readProjectIconSource(api, environmentA, project, null)).toBeNull();
    expect(await readProjectIconSource(api, environmentA, project, null)).toBeNull();
    expect(peekProjectIconSource(environmentA, project, null)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("bounds the number of environments it keeps and still answers an evicted one", async () => {
    let resolve!: (value: typeof icon) => void;
    const slow = vi.fn(
      () =>
        new Promise<typeof icon>((done) => {
          resolve = done;
        }),
    );
    const first = EnvironmentId.make("environment-0");
    const pending = readProjectIconSource(makeApi(slow), first, project, null);
    for (let index = 1; index < 20; index += 1) {
      await readProjectIconSource(
        makeApi(),
        EnvironmentId.make(`environment-${index}`),
        project,
        null,
      );
    }
    resolve(icon);
    // Dropped for capacity, not cleared: the waiting row still gets its icon.
    expect(await pending).toBe("data:image/png;base64,aWNvbg==");
    expect(projectIconCacheBytes(first)).toBe(0);
    expect(projectIconCacheBytes(EnvironmentId.make("environment-19"))).toBeGreaterThan(0);
  });
});
