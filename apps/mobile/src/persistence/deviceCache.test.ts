import { beforeEach, expect, it, vi } from "vitest";
import type { EnvironmentId } from "@ryco/contracts";
const mocks = vi.hoisted(() => ({
  snapshots: vi.fn(),
  purge: vi.fn(),
  files: vi.fn(),
  clearFiles: vi.fn(),
  diffs: vi.fn(),
  clearDiffs: vi.fn(),
  api: vi.fn(),
  icons: vi.fn(),
  clearIcons: vi.fn(),
}));
vi.mock("./environmentSnapshotPersistence", () => ({
  listEnvironmentCacheStorage: mocks.snapshots,
  clearEnvironmentSnapshotCache: mocks.purge,
}));
vi.mock("../rpc/projectFilesAtoms", () => ({
  projectFilesCacheStats: mocks.files,
  clearProjectFileCache: mocks.clearFiles,
}));
vi.mock("../rpc/checkpointDiffAtoms", () => ({
  checkpointDiffCacheBytes: mocks.diffs,
  clearCheckpointDiffCacheForEnvironment: mocks.clearDiffs,
}));
vi.mock("../connection/environmentApi", () => ({ readEnvironmentApi: mocks.api }));
vi.mock("@ryco/client-runtime/connection", () => ({
  projectIconCacheBytes: mocks.icons,
  clearProjectIconCache: mocks.clearIcons,
}));
import { clearDeviceCache, readDeviceCacheUsage } from "./deviceCache";
const device = "device-a" as EnvironmentId;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshots.mockResolvedValue([]);
  mocks.files.mockReturnValue({ images: 20, files: 30 });
  mocks.diffs.mockReturnValue(40);
  mocks.icons.mockReturnValue(10);
});
it("accounts for each category and includes snapshots from devices no longer in the catalog", async () => {
  mocks.snapshots.mockResolvedValue([
    { environmentId: device, payloadBytes: 100, threads: 2, projects: 1 },
  ]);
  mocks.api.mockReturnValue({});
  expect(await readDeviceCacheUsage([])).toEqual([
    {
      environmentId: device,
      label: "Cached device",
      snapshotBytes: 100,
      imageBytes: 30,
      fileBytes: 70,
      threads: 2,
      projects: 1,
      totalBytes: 200,
    },
  ]);
});
it("clears only the selected device and its own image source cache", async () => {
  const api = {};
  mocks.api.mockReturnValue(api);
  await clearDeviceCache(device);
  for (const clear of [mocks.purge, mocks.clearFiles, mocks.clearDiffs]) {
    expect(clear).toHaveBeenCalledExactlyOnceWith(device);
  }
  expect(mocks.clearIcons).toHaveBeenCalledExactlyOnceWith(api);
});
it("reports a disk failure without claiming the device was cleared", async () => {
  mocks.purge.mockRejectedValue(new Error("Storage unavailable"));
  await expect(clearDeviceCache(device)).rejects.toThrow("Storage unavailable");
  expect(mocks.clearFiles).not.toHaveBeenCalled();
});
