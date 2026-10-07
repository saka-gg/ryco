import type { EnvironmentId } from "@ryco/contracts";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import { ensureEnvironmentApi } from "~/environmentApi";
import { isHostedHubMode } from "~/env";
import { readHostedNodeMutationLease } from "~/hostedHub/hostedConnectionCoordinator";
import { setProjectReadFileCacheData } from "~/rpc/projectPreviewAtoms";
import { PreviewFileSessionOwner, type PreviewFileDocument } from "./PreviewFileEditSession";
import {
  previewFileSessionRegistry as sessions,
  type PreviewFileScope,
} from "./previewFileSessionRegistry";
export type { PreviewFileScope } from "./previewFileSessionRegistry";

/** Consult existing lifecycle authorities; this module never initiates reconnects. */
export function previewFileAuthority(environmentId: EnvironmentId): string | object | null {
  if (isHostedHubMode()) {
    const lease = readHostedNodeMutationLease(environmentId);
    return lease ? `${lease.selectionGeneration}:${lease.snapshotGeneration}` : null;
  }
  const status = getWsConnectionStatusForEnvironment(environmentId);
  return status.phase === "connected" && status.online ? status : null;
}

export function retainedPreviewFilePath(scope: PreviewFileScope) {
  return (
    matchingSessions(scope)
      .find((owner) => owner.unsaved)
      ?.getSnapshot().relativePath ?? null
  );
}

export function readPreviewFileSession(scope: PreviewFileScope, relativePath: string) {
  return (
    sessions.get(`${scope.environmentId}\u0000${scope.cwd}\u0000${relativePath}`)?.owner ?? null
  );
}

export function getPreviewFileSession(scope: PreviewFileScope, document: PreviewFileDocument) {
  let entry = sessions.get(document.key);
  if (!entry) {
    const route = { scope, key: document.key };
    const owner = new PreviewFileSessionOwner(document, {
      authority: () => previewFileAuthority(scope.environmentId),
      read: () =>
        ensureEnvironmentApi(route.scope.environmentId).projects.readFile({
          cwd: route.scope.cwd,
          relativePath: document.relativePath,
        }),
      write: (input) =>
        ensureEnvironmentApi(route.scope.environmentId).projects.writeFile({
          ...input,
          cwd: route.scope.cwd,
        }),
      publish: (data) =>
        setProjectReadFileCacheData({ ...route.scope, relativePath: document.relativePath }, data),
      release: () => {
        if (sessions.get(route.key)?.owner === owner) sessions.delete(route.key);
      },
    });
    entry = { scope, owner, route };
    sessions.set(document.key, entry);
  }
  return entry.owner;
}

export function hasUnsavedPreviewFiles(scope?: PreviewFileScope) {
  return matchingSessions(scope).some((owner) => owner.unsaved);
}

function matchingSessions(scope?: PreviewFileScope) {
  return [...sessions.values()]
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
      matchingSessions(scope)
        .filter((owner) => owner.unsaved)
        .map((owner) => owner.flush()),
    );
    if (results.some((saved) => !saved)) return false;
  }
  return true;
}

export function resetPreviewFileSessionsForTests() {
  for (const { owner } of sessions.values()) owner.disposeForTests();
  sessions.clear();
}
