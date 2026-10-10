import type { EnvironmentId } from "@ryco/contracts";
import type { PreviewFileSessionOwner } from "./PreviewFileEditSession";

export interface PreviewFileScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

/** Keep retargeting independent of editor/RPC/router initialization. */
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
