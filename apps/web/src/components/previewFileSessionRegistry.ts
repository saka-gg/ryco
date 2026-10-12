import type { EnvironmentId } from "@ryco/contracts";
import type { PreviewFileSessionOwner } from "./PreviewFileEditSession";

export interface PreviewFileScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/**
 * Keep retargeting, the unsaved check, and flushing independent of
 * editor/RPC/router initialization: the root navigation guard reads them on
 * every route, so this module must stay free of the editor session, the
 * environment API, and the hosted coordinator (`previewFileSessions.ts`).
 */
export const previewFileSessionRegistry = new Map<
  string,
  {
    scope: PreviewFileScope;
    owner: PreviewFileSessionOwner;
    route: { scope: PreviewFileScope; key: string };
  }
>();

/** Retarget relative file tabs and their only buffer after a current server snapshot/event. */
export function retargetPreviewFileSessions(input: {
  environmentId: EnvironmentId;
  sourcePath: string;
  destinationPath: string;
}) {
  for (const [key, entry] of previewFileSessionRegistry) {
    if (entry.scope.environmentId !== input.environmentId || entry.scope.cwd !== input.sourcePath)
      continue;
    const relativePath = entry.owner.getSnapshot().relativePath;
    const nextKey = `${input.environmentId}\u0000${input.destinationPath}\u0000${relativePath}`;
    if (previewFileSessionRegistry.has(nextKey)) continue; // Never overwrite another unsaved buffer.
    previewFileSessionRegistry.delete(key);
    entry.scope = { environmentId: input.environmentId, cwd: input.destinationPath };
    entry.route.scope = entry.scope;
    entry.route.key = nextKey;
    previewFileSessionRegistry.set(nextKey, entry);
    entry.owner.retarget(nextKey);
  }
}

export function hasUnsavedPreviewFiles(scope?: PreviewFileScope) {
  return matchingPreviewFileOwners(scope).some((owner) => owner.unsaved);
}

/** The session owners of one scope, or of every scope. */
export function matchingPreviewFileOwners(scope?: PreviewFileScope) {
  return [...previewFileSessionRegistry.values()]
    .filter(
      (entry) =>
        !scope ||
        (entry.scope.environmentId === scope.environmentId && entry.scope.cwd === scope.cwd),
    )
    .map((entry) => entry.owner);
}

/** A barrier also catches buffers added while an earlier save was pending. */
export async function flushPreviewFiles(scope?: PreviewFileScope): Promise<boolean> {
  while (hasUnsavedPreviewFiles(scope)) {
    const results = await Promise.all(
      matchingPreviewFileOwners(scope)
        .filter((owner) => owner.unsaved)
        .map((owner) => owner.flush()),
    );
    if (results.some((saved) => !saved)) return false;
  }
  return true;
}
