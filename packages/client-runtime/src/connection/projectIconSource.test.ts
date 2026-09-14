import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentApi, ProjectId } from "@ryco/contracts";
import {
  clearProjectIconCache,
  projectIconCacheBytes,
  readProjectIconSource,
} from "./projectIconSource";

const project = "project" as ProjectId;
function api(readIcon = vi.fn(async () => ({ mimeType: "image/png", dataBase64: "aW1hZ2U=" }))) {
  return { projects: { readIcon } } as unknown as EnvironmentApi;
}
describe("per-device project artwork cache", () => {
  it("clears only the selected connection and measures retained payloads", async () => {
    const a = api(),
      b = api();
    await readProjectIconSource(a, project, null);
    await readProjectIconSource(b, project, null);
    expect(projectIconCacheBytes(a)).toBeGreaterThan(0);
    clearProjectIconCache(a);
    expect(projectIconCacheBytes(a)).toBe(0);
    expect(projectIconCacheBytes(b)).toBeGreaterThan(0);
  });
  it("does not publish or re-cache an old request after a clear", async () => {
    let resolve!: (value: { mimeType: string; dataBase64: string }) => void;
    const a = api(
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
