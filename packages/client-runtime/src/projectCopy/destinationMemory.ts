// FILE: destinationMemory.ts
// Purpose: Remembers where the user last copied a project from one checkout:
//          the destination node and, when they picked it themselves, the parent
//          folder there. A copy form preselects it next time, and a stopped
//          copy resumes into the same folder. The web and the phone keep the
//          list in their own storage.
// Layer: Client runtime, pure.

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";
import * as Schema from "effect/Schema";

export const COPY_DESTINATIONS_STORAGE_KEY = "ryco:project-copy-destinations:v1";

/** The most recent sources remembered; older ones drop off. */
const MAX_REMEMBERED = 50;

const RememberedDestination = Schema.Struct({
  sourceEnvironmentId: Schema.String,
  sourceProjectId: Schema.String,
  targetEnvironmentId: Schema.String,
  /** The parent folder the user picked on the destination; null when the suggestion was used. */
  parentPath: Schema.NullOr(Schema.String),
  at: Schema.Number,
});
export const RememberedCopyDestinations = Schema.Array(RememberedDestination);
export type StoredCopyDestination = typeof RememberedDestination.Type;

export interface RememberedCopyDestination {
  readonly targetEnvironmentId: EnvironmentId;
  readonly parentPath: string | null;
}

/** Where a client keeps the list; either may throw (a full or unreadable storage). */
export interface CopyDestinationStorage {
  readonly read: () => ReadonlyArray<StoredCopyDestination> | null;
  readonly write: (entries: ReadonlyArray<StoredCopyDestination>) => void;
}

export interface CopyDestinationMemory {
  /** Where this checkout was last copied to; null when it never was (or storage can't be read). */
  readonly read: (source: ScopedProjectRef) => RememberedCopyDestination | null;
  /** Remembers a copy that started; the newest first, at most 50 sources. */
  readonly remember: (source: ScopedProjectRef, destination: RememberedCopyDestination) => void;
}

const sameSource = (entry: StoredCopyDestination, source: ScopedProjectRef) =>
  entry.sourceEnvironmentId === source.environmentId && entry.sourceProjectId === source.projectId;

export function createCopyDestinationMemory(
  storage: CopyDestinationStorage,
  now: () => number = Date.now,
): CopyDestinationMemory {
  const readAll = (): ReadonlyArray<StoredCopyDestination> => {
    try {
      return storage.read() ?? [];
    } catch {
      return [];
    }
  };
  return {
    read: (source) => {
      const entry = readAll().find((candidate) => sameSource(candidate, source));
      return entry
        ? {
            targetEnvironmentId: entry.targetEnvironmentId as EnvironmentId,
            parentPath: entry.parentPath,
          }
        : null;
    },
    remember: (source, destination) => {
      const entry: StoredCopyDestination = {
        sourceEnvironmentId: source.environmentId,
        sourceProjectId: source.projectId,
        targetEnvironmentId: destination.targetEnvironmentId,
        parentPath: destination.parentPath,
        at: now(),
      };
      const next = [
        entry,
        ...readAll().filter((candidate) => !sameSource(candidate, source)),
      ].slice(0, MAX_REMEMBERED);
      try {
        storage.write(next);
      } catch {
        // Best effort: a full or unavailable storage just forgets.
      }
    },
  };
}

/**
 * The parent folder a form uses for `targetId`: the one the user picked in
 * this form, else the one remembered for that node (`remembered` when it is
 * the remembered one).
 */
export function copyParentFolderOf(input: {
  readonly targetId: EnvironmentId | null;
  readonly picked: { readonly targetId: EnvironmentId | null; readonly path: string } | null;
  readonly remembered: RememberedCopyDestination | null;
}): { readonly path: string | null; readonly remembered: boolean } {
  const rememberedPath =
    input.remembered?.targetEnvironmentId === input.targetId ? input.remembered.parentPath : null;
  const path =
    input.picked !== null && input.picked.targetId === input.targetId
      ? input.picked.path
      : rememberedPath;
  return { path, remembered: path !== null && path === rememberedPath };
}
