// FILE: addProjectMemory.ts
// Purpose: Remembers the node and source the user last added a project with, so the next
//          "Add project" opens on that node's Source step with that source preselected.
// Layer: Web UI state. Kept through `useLocalStorage`'s storage: this browser's localStorage,
//        or memory for the session in hosted builds (nothing is persisted there).

import { EnvironmentId } from "@ryco/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import type { AddProjectLastUsed } from "./addProjectDialog.logic";

export const ADD_PROJECT_LAST_USED_STORAGE_KEY = "ryco:add-project-last-used:v1";

const StoredAddProjectLastUsed = Schema.Struct({
  nodeId: EnvironmentId,
  kind: Schema.NullOr(Schema.Literals(["folder", "clone", "copy"])),
});

/** What the last add used; null when nothing (readable) is stored. */
export function readAddProjectLastUsed(): AddProjectLastUsed | null {
  try {
    return getLocalStorageItem(ADD_PROJECT_LAST_USED_STORAGE_KEY, StoredAddProjectLastUsed);
  } catch {
    return null;
  }
}

/** Records an add on `nodeId` from `kind`; a link keeps the source remembered before it. */
export function rememberAddProjectLastUsed(
  nodeId: EnvironmentId,
  kind: "folder" | "clone" | "copy" | "link" | null,
): void {
  try {
    setLocalStorageItem(
      ADD_PROJECT_LAST_USED_STORAGE_KEY,
      { nodeId, kind: kind === "link" ? (readAddProjectLastUsed()?.kind ?? null) : kind },
      StoredAddProjectLastUsed,
    );
  } catch {
    // Storage full or blocked: the next open starts without the memory.
  }
}
