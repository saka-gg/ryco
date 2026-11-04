// FILE: copyDestinationMemory.ts
// Purpose: Remembers where the user last copied a project from one checkout:
//          the destination node and, when they picked it themselves, the parent
//          folder there. The copy dialog preselects it next time; the copy
//          prefetch warms that node first.
// Layer: Web UI state, loaded with the copy dialog and the copy prefetch.
//        Kept through `getLocalStorageItem`, so hosted builds keep it in this
//        window's memory only (the app's rule for anything with paths).

import type { EnvironmentId, ScopedProjectRef } from "@ryco/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

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
const RememberedDestinations = Schema.Array(RememberedDestination);
type StoredDestination = typeof RememberedDestination.Type;

export interface RememberedCopyDestination {
  readonly targetEnvironmentId: EnvironmentId;
  readonly parentPath: string | null;
}

function readAll(): ReadonlyArray<StoredDestination> {
  try {
    return getLocalStorageItem(COPY_DESTINATIONS_STORAGE_KEY, RememberedDestinations) ?? [];
  } catch {
    return [];
  }
}

const sameSource = (entry: StoredDestination, source: ScopedProjectRef) =>
  entry.sourceEnvironmentId === source.environmentId && entry.sourceProjectId === source.projectId;

/** Where this checkout was last copied to; null when it never was (or storage can't be read). */
export function readRememberedCopyDestination(
  source: ScopedProjectRef,
): RememberedCopyDestination | null {
  const entry = readAll().find((candidate) => sameSource(candidate, source));
  return entry
    ? {
        targetEnvironmentId: entry.targetEnvironmentId as EnvironmentId,
        parentPath: entry.parentPath,
      }
    : null;
}

/** Remembers a copy that started; the newest first, at most `MAX_REMEMBERED` sources. */
export function rememberCopyDestination(
  source: ScopedProjectRef,
  destination: RememberedCopyDestination,
): void {
  const entry: StoredDestination = {
    sourceEnvironmentId: source.environmentId,
    sourceProjectId: source.projectId,
    targetEnvironmentId: destination.targetEnvironmentId,
    parentPath: destination.parentPath,
    at: Date.now(),
  };
  const next = [entry, ...readAll().filter((candidate) => !sameSource(candidate, source))].slice(
    0,
    MAX_REMEMBERED,
  );
  try {
    setLocalStorageItem(COPY_DESTINATIONS_STORAGE_KEY, next, RememberedDestinations);
  } catch {
    // Best effort: a full or unavailable storage just forgets.
  }
}
