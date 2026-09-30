import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, type EnvironmentApi } from "@ryco/contracts";
import {
  clearProjectIconCache,
  projectIconCacheBytes,
  readProjectIconSource,
} from "./projectIconSource";

const project = ProjectId.make("project");
const icon = { mimeType: "image/png", dataBase64: "aWNvbg==" };
function makeApi(
  readIcon: unknown = vi.fn(async () => ({ mimeType: "image/png", dataBase64: "aW1hZ2U=" })),
) {
  return { projects: { readIcon } } as unknown as EnvironmentApi;
}
describe("per-device project artwork cache", () => {
  it("clears only the selected connection and measures retained payloads", async () => {
    const a = makeApi(),
      b = makeApi();
    await readProjectIconSource(a, project, null);
    await readProjectIconSource(b, project, null);
    expect(projectIconCacheBytes(a)).toBeGreaterThan(0);
    clearProjectIconCache(a);
    expect(projectIconCacheBytes(a)).toBe(0);
    expect(projectIconCacheBytes(b)).toBeGreaterThan(0);
  });
  it("does not publish or re-cache an old request after a clear", async () => {
    let resolve!: (value: { mimeType: string; dataBase64: string }) => void;
    const a = makeApi(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = readProjectIconSource(a, project, null);
    clearProjectIconCache(a);
    resolve({ mimeType: "image/png", dataBase64: "b2xk" });
    expect(await pending).toBeNull();
    expect(projectIconCacheBytes(a)).toBe(0);
  });
});

describe("project icon connection cache", () => {
  it("deduplicates simultaneous project rows and scopes bytes to the connection", async () => {
    const read = vi.fn(async () => icon);
    const api = makeApi(read);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => readProjectIconSource(api, project, null)),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(results.every((src) => src === "data:image/png;base64,aWNvbg==")).toBe(true);
    await readProjectIconSource(makeApi(read), project, null);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("refreshes after avatar changes and reconnects, and retries failed reads", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(icon);
    const api = makeApi(read);
    await expect(readProjectIconSource(api, project, null, "first")).rejects.toThrow(
      "disconnected",
    );
    await readProjectIconSource(api, project, null, "first");
    await readProjectIconSource(api, project, "new-avatar", "first");
    await readProjectIconSource(api, project, "new-avatar", "second");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("caches missing artwork briefly without repeated RPCs", async () => {
    const read = vi.fn(async () => null);
    const api = makeApi(read);
    expect(await readProjectIconSource(api, project, null)).toBeNull();
    expect(await readProjectIconSource(api, project, null)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
