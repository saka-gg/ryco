import { beforeEach, expect, it, vi } from "vitest";
import type { EnvironmentId } from "@ryco/contracts";
const mocks = vi.hoisted(() => ({
  snapshots: vi.fn(),
  purge: vi.fn(),
  files: vi.fn(),
  clearFiles: vi.fn(),
  diffs: vi.fn(),
  clearDiffs: vi.fn(),
  icons: vi.fn(),
  clearIcons: vi.fn(),
  pullRequests: vi.fn(),
  clearPullRequests: vi.fn(),
  savedPullRequests: vi.fn(),
  taskBytes: vi.fn(),
  explorer: vi.fn(),
  clearExplorer: vi.fn(),
}));
vi.mock("./environmentSnapshotPersistence", () => ({
  listEnvironmentCacheStorage: mocks.snapshots,
  clearEnvironmentSnapshotCache: mocks.purge,
  savedPullRequestBytes: mocks.savedPullRequests,
}));
vi.mock("../rpc/projectFilesAtoms", () => ({
  projectFilesCacheStats: mocks.files,
  clearProjectFileCache: mocks.clearFiles,
}));
vi.mock("../rpc/checkpointDiffAtoms", () => ({
  checkpointDiffCacheBytes: mocks.diffs,
  clearCheckpointDiffCacheForEnvironment: mocks.clearDiffs,
}));
vi.mock("../rpc/pullRequestAtoms", () => ({
  pullRequestCacheBytes: mocks.pullRequests,
  clearPullRequestCache: mocks.clearPullRequests,
}));
vi.mock("../rpc/projectExplorerAtoms", () => ({
  projectExplorerCacheBytes: mocks.explorer,
  clearProjectExplorerCache: mocks.clearExplorer,
}));
vi.mock("@ryco/client-runtime/connection", () => ({
  projectIconCacheBytes: mocks.icons,
  clearProjectIconCache: mocks.clearIcons,
}));
vi.mock("../features/tasks/taskCacheKeys", () => ({
  readTaskCacheBytes: mocks.taskBytes,
}));
import { clearDeviceCache, readDeviceCacheUsage } from "./deviceCache";
const device = "device-a" as EnvironmentId;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshots.mockResolvedValue([]);
  mocks.files.mockReturnValue({ images: 20, files: 30 });
  mocks.diffs.mockReturnValue(40);
  mocks.icons.mockReturnValue(10);
  mocks.pullRequests.mockReturnValue(5);
  mocks.savedPullRequests.mockResolvedValue(0);
  mocks.taskBytes.mockResolvedValue(0);
  mocks.explorer.mockReturnValue(0);
});
it("accounts for each category and includes snapshots from devices no longer in the catalog", async () => {
  mocks.snapshots.mockResolvedValue([
    { environmentId: device, payloadBytes: 60, threads: 2, projects: 1 },
  ]);
  // Saved pull requests are stored beside the snapshot and count with it.
  mocks.savedPullRequests.mockResolvedValue(40);
  expect(await readDeviceCacheUsage([])).toEqual([
    {
      environmentId: device,
      label: "Cached device",
      snapshotBytes: 100,
      imageBytes: 30,
      fileBytes: 75,
      threads: 2,
      projects: 1,
      totalBytes: 205,
    },
  ]);
});
it("counts a device's task list copy with its conversations", async () => {
  mocks.snapshots.mockResolvedValue([
    { environmentId: device, payloadBytes: 100, threads: 2, projects: 1 },
  ]);
  mocks.taskBytes.mockResolvedValue(12);
  expect(await readDeviceCacheUsage([])).toMatchObject([
    { environmentId: device, snapshotBytes: 112, totalBytes: 217 },
  ]);
});
it("clears only the selected device and its own image source cache", async () => {
  // The artwork cache is keyed by device, so a disconnected device clears too.
  await clearDeviceCache(device);
  for (const clear of [
    mocks.purge,
    mocks.clearFiles,
    mocks.clearDiffs,
    mocks.clearPullRequests,
    mocks.clearExplorer,
    mocks.clearIcons,
  ]) {
    expect(clear).toHaveBeenCalledExactlyOnceWith(device);
  }
});
it("reports a disk failure without claiming the device was cleared", async () => {
  mocks.purge.mockRejectedValue(new Error("Storage unavailable"));
  await expect(clearDeviceCache(device)).rejects.toThrow("Storage unavailable");
  expect(mocks.clearFiles).not.toHaveBeenCalled();
});
