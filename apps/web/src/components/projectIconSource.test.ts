import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, type EnvironmentApi } from "@ryco/contracts";
import { readProjectIconSource } from "./projectIconSource";
const id = ProjectId.make("project");
const icon = { mimeType: "image/png", dataBase64: "aWNvbg==" };
const apiFor = (readIcon: unknown) => ({ projects: { readIcon } }) as EnvironmentApi;

describe("project icon connection cache", () => {
  it("deduplicates simultaneous project rows and scopes bytes to the connection", async () => {
    const read = vi.fn(async () => icon);
    const api = apiFor(read);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => readProjectIconSource(api, id, null)),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(results.every((src) => src === "data:image/png;base64,aWNvbg==")).toBe(true);
    await readProjectIconSource(apiFor(read), id, null);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("refreshes after avatar changes and reconnects, and retries failed reads", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(icon);
    const api = apiFor(read);
    await expect(readProjectIconSource(api, id, null, "first")).rejects.toThrow("disconnected");
    await readProjectIconSource(api, id, null, "first");
    await readProjectIconSource(api, id, "new-avatar", "first");
    await readProjectIconSource(api, id, "new-avatar", "second");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("caches missing artwork briefly without repeated RPCs", async () => {
    const read = vi.fn(async () => null);
    const api = apiFor(read);
    expect(await readProjectIconSource(api, id, null)).toBeNull();
    expect(await readProjectIconSource(api, id, null)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
