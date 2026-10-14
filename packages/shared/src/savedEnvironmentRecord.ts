import type { PersistedSavedEnvironmentRecord, SavedEnvironmentHubLink } from "@ryco/contracts";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored `hubLink` read back from disk or browser storage. */
export function isSavedEnvironmentHubLink(value: unknown): value is SavedEnvironmentHubLink {
  return (
    isObject(value) &&
    typeof value.hubEnvironmentId === "string" &&
    value.hubEnvironmentId.length > 0 &&
    typeof value.linkedAt === "string" &&
    Number.isFinite(Date.parse(value.linkedAt))
  );
}

/**
 * Exactly the persisted fields of a saved environment, with every optional one
 * kept only when present. Each store adds its own credential fields beside
 * these, so a new record field is added here once rather than in each store.
 */
export function persistedSavedEnvironmentRecordFields(
  record: Readonly<Omit<PersistedSavedEnvironmentRecord, "desktopSsh" | "hubLink">> & {
    readonly desktopSsh?: PersistedSavedEnvironmentRecord["desktopSsh"] | undefined;
    readonly hubLink?: PersistedSavedEnvironmentRecord["hubLink"] | undefined;
  },
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
    ...(record.hubLink ? { hubLink: record.hubLink } : {}),
  };
}
