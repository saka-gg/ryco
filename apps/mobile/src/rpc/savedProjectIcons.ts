import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { registerEnvironmentDevicePurge } from "../persistence/environmentDevicePurge";
import { awaitSavedQueryStore } from "./savedQueries";

/**
 * Project artwork kept on the device, so a project's icon shows on the first
 * frame of a cold start instead of a folder glyph until its node answers.
 * Stored through the saved query store, under its rules (the device setting,
 * the per-environment purge, the byte caps) — which expo-image's own disk cache
 * could not follow: it can only be cleared as a whole, never per node.
 *
 * Keyed by environment, project and avatar revision. A custom avatar's
 * revision names its content, so artwork saved under one never goes stale.
 */

const VERSION = 1;
/** Rows looked up this session, so a remounted row never reads the database again. */
const MAX_REMEMBERED = 256;
const remembered = new Map<string, string | null>();

function rowKey(projectId: ProjectId, revision: string | null): string {
  return `project-icon\u0000${projectId}\u0000${revision ?? ""}`;
}

function memoryKey(environmentId: EnvironmentId, projectId: ProjectId, revision: string | null) {
  return `${environmentId}\u0000${rowKey(projectId, revision)}`;
}

function remember(key: string, source: string | null): void {
  remembered.delete(key);
  remembered.set(key, source);
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

registerEnvironmentDevicePurge((environmentId) => {
  const prefix = `${environmentId}\u0000`;
  for (const key of [...remembered.keys()]) if (key.startsWith(prefix)) remembered.delete(key);
});

/** The artwork remembered this session: a data URL, null for none, undefined when unknown. */
export function peekSavedProjectIcon(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revision: string | null,
): string | null | undefined {
  return remembered.get(memoryKey(environmentId, projectId, revision));
}

/** The artwork saved on the device: a data URL, null for none, undefined when nothing is saved. */
export async function loadSavedProjectIcon(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revision: string | null,
): Promise<string | null | undefined> {
  const key = memoryKey(environmentId, projectId, revision);
  if (remembered.has(key)) return remembered.get(key);
  const store = await awaitSavedQueryStore();
  const saved = await store?.load(environmentId, rowKey(projectId, revision), VERSION);
  if (!saved) return undefined;
  try {
    const parsed = JSON.parse(saved.payload) as { readonly source?: unknown };
    const source = typeof parsed.source === "string" ? parsed.source : null;
    if (source !== null && !source.startsWith("data:image/")) return undefined;
    remember(key, source);
    return source;
  } catch {
    return undefined;
  }
}

/** Keeps a node's answer (artwork or none) for the next launch. */
export function saveProjectIcon(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  revision: string | null,
  source: string | null,
): void {
  const key = memoryKey(environmentId, projectId, revision);
  if (remembered.has(key) && remembered.get(key) === source) return;
  remember(key, source);
  void awaitSavedQueryStore().then((store) =>
    store?.save(environmentId, rowKey(projectId, revision), VERSION, () =>
      JSON.stringify({ source }),
    ),
  );
}
