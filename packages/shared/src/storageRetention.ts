import type { ServerSettings, StorageRetentionPolicy } from "@ryco/contracts";

/** Cleanup-only integration seam: Feature 4 may supply its resolved project value here. */
export function resolveStorageRetentionPolicy(
  settings: Pick<ServerSettings, "storageRetention" | "projectStorageRetention">,
  projectId: string | null,
): StorageRetentionPolicy {
  return (
    (projectId ? settings.projectStorageRetention[projectId] : null) ?? settings.storageRetention
  );
}

export function retentionDue(
  policy: StorageRetentionPolicy,
  category: "worktree" | "temporary",
  completedAt: string,
  now: number,
): boolean {
  const days = category === "worktree" ? policy.completedWorktreeDays : policy.temporaryDataDays;
  const time = Date.parse(completedAt);
  return (
    policy.automatic && days !== null && Number.isFinite(time) && now - time >= days * 86_400_000
  );
}

export function formatStorageSize(
  bytes: number | null,
  status: "complete" | "bounded" | "unknown",
): string {
  if (bytes === null || status === "unknown") return "Size unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log2(Math.max(1, bytes)) / 10), units.length - 1);
  return `${status === "bounded" ? "At least " : ""}${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
