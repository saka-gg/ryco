// FILE: copyProjectPrefetch.ts
// Purpose: Warms what the copy dialog reads first, while a "Copy to another
//          node…" entry point is hovered or focused: the source's export
//          inspection and the path hints of the source and its likely
//          destinations (the one asked for, the one last copied to, else the
//          connected nodes that can take a copy). Only nodes that are already
//          connected are read; none is woken for it.
// Layer: Web UI, loaded on intent through `preloadCopyProject` (never at boot).
//        The reads land in the query client the dialog reads through.

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { readNodeCatalogSnapshot } from "../../environments/nodeCatalog";
import { readRememberedCopyDestination } from "./copyDestinationMemory";
import { prefetchExportInspection, prefetchNodePathHints } from "./nodePathQueries";

/** Destinations warmed when neither one was asked for nor one is remembered. */
const MAX_GUESSED_DESTINATIONS = 3;

function readable(environmentId: EnvironmentId): boolean {
  const node = readNodeCatalogSnapshot().nodes.find(
    (entry) => entry.environmentId === environmentId,
  );
  return (
    node !== undefined &&
    node.presence === "online" &&
    node.projectCopySupport === "yes" &&
    readEnvironmentApi(environmentId)?.projects.pathHints !== undefined
  );
}

/** The destinations to warm, best guess first. */
function likelyDestinations(
  source: ScopedProjectRef,
  targetEnvironmentId: EnvironmentId | null,
): EnvironmentId[] {
  const preferred =
    targetEnvironmentId ?? readRememberedCopyDestination(source)?.targetEnvironmentId;
  if (preferred && preferred !== source.environmentId)
    return readable(preferred) ? [preferred] : [];
  return readNodeCatalogSnapshot()
    .nodes.filter(
      (node) =>
        node.environmentId !== source.environmentId &&
        node.canMutate &&
        readable(node.environmentId),
    )
    .slice(0, MAX_GUESSED_DESTINATIONS)
    .map((node) => node.environmentId);
}

/** Starts the dialog's first reads for copying `source` (fresh answers are kept). */
export function prefetchCopyProject(
  source: ScopedProjectRef,
  targetEnvironmentId: EnvironmentId | null = null,
): void {
  if (readable(source.environmentId)) {
    if (readEnvironmentApi(source.environmentId)?.projects.exportInspect) {
      void prefetchExportInspection(source.environmentId, source.projectId);
    }
    void prefetchNodePathHints(source.environmentId);
  }
  for (const environmentId of likelyDestinations(source, targetEnvironmentId)) {
    void prefetchNodePathHints(environmentId);
  }
}
