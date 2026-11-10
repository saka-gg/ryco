import type { EnvironmentId } from "@ryco/contracts";
import { clearProjectIconCache, projectIconCacheBytes } from "@ryco/client-runtime/connection";
import { cachedPayloadBytes } from "./cacheSize";
import { clearProjectFileCache, projectFilesCacheStats } from "../rpc/projectFilesAtoms";
import {
  checkpointDiffCacheBytes,
  clearCheckpointDiffCacheForEnvironment,
} from "../rpc/checkpointDiffAtoms";
import { clearProjectExplorerCache, projectExplorerCacheBytes } from "../rpc/projectExplorerAtoms";
import { clearPullRequestCache, pullRequestCacheBytes } from "../rpc/pullRequestAtoms";
import { clearScreenCaches, screenCachesBytes } from "../rpc/mobileQueryCache";
import { readTaskCacheBytes } from "../features/tasks/taskCacheKeys";
import {
  clearEnvironmentSnapshotCache,
  listEnvironmentCacheStorage,
  savedScreenAnswerBytes,
} from "./environmentSnapshotPersistence";

export interface DeviceCacheUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly snapshotBytes: number;
  readonly imageBytes: number;
  readonly fileBytes: number;
  readonly threads: number;
  readonly projects: number;
  readonly totalBytes: number;
}
export async function readDeviceCacheUsage(
  devices: readonly { environmentId: EnvironmentId; label: string }[],
): Promise<DeviceCacheUsage[]> {
  const snapshots = await listEnvironmentCacheStorage();
  const byId = new Map(devices.map((device) => [device.environmentId, device.label]));
  for (const snapshot of snapshots)
    if (!byId.has(snapshot.environmentId as EnvironmentId))
      byId.set(snapshot.environmentId as EnvironmentId, "Cached device");
  const savedAnswers = new Map(
    await Promise.all(
      [...byId.keys()].map(
        async (environmentId) =>
          [environmentId, await savedScreenAnswerBytes(environmentId)] as const,
      ),
    ),
  );
  const taskBytes = new Map(
    await Promise.all(
      [...byId.keys()].map(
        async (environmentId) => [environmentId, await readTaskCacheBytes(environmentId)] as const,
      ),
    ),
  );
  return [...byId]
    .map(([environmentId, label]) => {
      const snapshot = snapshots.find((item) => item.environmentId === environmentId);
      const previews = projectFilesCacheStats(environmentId);
      const imageBytes = previews.images + projectIconCacheBytes(environmentId);
      const fileBytes =
        previews.files +
        checkpointDiffCacheBytes(environmentId) +
        pullRequestCacheBytes(environmentId) +
        screenCachesBytes(environmentId, cachedPayloadBytes) +
        projectExplorerCacheBytes(environmentId);
      // Saved screen answers and the machine's task list copy live beside the
      // snapshot and are cleared with it.
      const snapshotBytes =
        (snapshot?.payloadBytes ?? 0) +
        (savedAnswers.get(environmentId) ?? 0) +
        (taskBytes.get(environmentId) ?? 0);
      return {
        environmentId,
        label,
        snapshotBytes,
        imageBytes,
        fileBytes,
        threads: snapshot?.threads ?? 0,
        projects: snapshot?.projects ?? 0,
        totalBytes: snapshotBytes + imageBytes + fileBytes,
      };
    })
    .toSorted((a, b) => b.totalBytes - a.totalBytes || a.label.localeCompare(b.label));
}
/** Local cache eviction only. No disconnect, credential removal, outbox edit, or server mutation. */
export async function clearDeviceCache(environmentId: EnvironmentId): Promise<void> {
  await clearEnvironmentSnapshotCache(environmentId);
  clearProjectFileCache(environmentId);
  clearCheckpointDiffCacheForEnvironment(environmentId);
  clearPullRequestCache(environmentId);
  clearScreenCaches(environmentId);
  clearProjectExplorerCache(environmentId);
  clearProjectIconCache(environmentId);
}
