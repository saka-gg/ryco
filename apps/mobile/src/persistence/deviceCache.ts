import type { EnvironmentId } from "@ryco/contracts";
import { clearProjectIconCache, projectIconCacheBytes } from "@ryco/client-runtime/connection";
import { readEnvironmentApi } from "../connection/environmentApi";
import { clearProjectFileCache, projectFilesCacheStats } from "../rpc/projectFilesAtoms";
import {
  checkpointDiffCacheBytes,
  clearCheckpointDiffCacheForEnvironment,
} from "../rpc/checkpointDiffAtoms";
import {
  clearEnvironmentSnapshotCache,
  listEnvironmentCacheStorage,
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
  return [...byId]
    .map(([environmentId, label]) => {
      const snapshot = snapshots.find((item) => item.environmentId === environmentId);
      const previews = projectFilesCacheStats(environmentId);
      const api = readEnvironmentApi(environmentId);
      const imageBytes = previews.images + (api ? projectIconCacheBytes(api) : 0);
      const fileBytes = previews.files + checkpointDiffCacheBytes(environmentId);
      const snapshotBytes = snapshot?.payloadBytes ?? 0;
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
  const api = readEnvironmentApi(environmentId);
  if (api) clearProjectIconCache(api);
}
