import type { EnvironmentId } from "@ryco/contracts";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import { ensureEnvironmentApi } from "~/environmentApi";
import { isHostedHubMode } from "~/env";
import { readHostedNodeMutationLease } from "~/hostedHub/hostedConnectionCoordinator";
import { setProjectReadFileCacheData } from "~/rpc/projectPreviewAtoms";
import { PreviewFileSessionOwner, type PreviewFileDocument } from "./PreviewFileEditSession";

export interface PreviewFileScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

const sessions = new Map<string, { scope: PreviewFileScope; owner: PreviewFileSessionOwner }>();

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
    const owner = new PreviewFileSessionOwner(document, {
      authority: () => previewFileAuthority(scope.environmentId),
      read: () =>
        ensureEnvironmentApi(scope.environmentId).projects.readFile({
          cwd: scope.cwd,
          relativePath: document.relativePath,
        }),
      write: (input) =>
        ensureEnvironmentApi(scope.environmentId).projects.writeFile({ ...input, cwd: scope.cwd }),
      publish: (data) =>
        setProjectReadFileCacheData({ ...scope, relativePath: document.relativePath }, data),
      release: () => {
        if (sessions.get(document.key)?.owner === owner) sessions.delete(document.key);
      },
    });
    entry = { scope, owner };
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
