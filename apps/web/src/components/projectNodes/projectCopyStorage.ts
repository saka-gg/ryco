// FILE: projectCopyStorage.ts
// Purpose: Where the copy runtime keeps its job records and Agent Control copy
//          starts, and whether a previous session left any behind.
// Layer: Web UI state, outside the boot bundle: the app shell checks it at idle
//        and the devices section on mount, so neither loads the copy runtime
//        when there is nothing to resume.

import * as Schema from "effect/Schema";

import { getLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * Where the copy runtime keeps its job records (ids only). Here so the shell
 * can tell whether there is anything to resume without loading the runtime.
 * Hosted builds keep them in memory for the session (`useLocalStorage`).
 */
export const PROJECT_COPY_RECORDS_STORAGE_KEY = "ryco:project-copies:v1";

/**
 * Agent Control approvals of a copy that may have bound a proposal to this
 * client's executor before the copy's own record existed (ids only), so a
 * reload still ends such a proposal. Kept by the copy runtime.
 */
export const PROJECT_COPY_STARTS_STORAGE_KEY = "ryco:project-copy-starts:v1";

const hasStoredEntries = (key: string): boolean => {
  try {
    const stored = getLocalStorageItem(key, Schema.Unknown);
    return Array.isArray(stored) && stored.length > 0;
  } catch {
    return false;
  }
};

/** Whether a session left copy records behind (the copy runtime decides what to resume). */
export function hasStoredProjectCopyRecords(): boolean {
  return (
    hasStoredEntries(PROJECT_COPY_RECORDS_STORAGE_KEY) ||
    hasStoredEntries(PROJECT_COPY_STARTS_STORAGE_KEY)
  );
}
