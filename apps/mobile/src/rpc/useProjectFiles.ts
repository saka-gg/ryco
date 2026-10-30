// React bindings over the workspace file cache (projectFilesAtoms), through the
// shared `useMobileQuery` binding. The mobile counterpart of
// apps/web/src/rpc/useProjectPreview.ts.
//
// Entry ordering is deliberately NOT applied here: the tree builder owns
// directories-first/natural ordering, and search results must keep the node's
// ranking.
import {
  normalizeWorkspaceFileSearchQuery,
  WORKSPACE_FILE_SEARCH_DEBOUNCE_MS,
} from "@ryco/client-runtime/state/files";
import type {
  ProjectListEntriesResult,
  ProjectReadFileBinaryResult,
  ProjectReadFileResult,
  ProjectSearchEntriesResult,
} from "@ryco/contracts";
import { useEffect, useState } from "react";

import {
  projectListEntriesQuery,
  projectReadFileBinaryQuery,
  projectReadFileQuery,
  projectSearchEntriesQuery,
  type ProjectListEntriesInput,
  type ProjectReadFileBinaryInput,
  type ProjectReadFileInput,
  type ProjectSearchEntriesInput,
} from "./projectFilesAtoms";
import { useMobileQuery, type MobileQueryResult } from "./useMobileQuery";

export type ProjectFilesQueryResult<T> = MobileQueryResult<T>;

export interface ProjectSearchEntriesQueryResult extends ProjectFilesQueryResult<ProjectSearchEntriesResult> {
  /** The box holds a query the debounce has not sent to the node yet. */
  readonly isDebouncing: boolean;
}

export function useProjectListEntries(
  input: ProjectListEntriesInput,
): ProjectFilesQueryResult<ProjectListEntriesResult> {
  return useMobileQuery(projectListEntriesQuery, input, input.environmentId);
}

export function useProjectReadFile(
  input: ProjectReadFileInput,
): ProjectFilesQueryResult<ProjectReadFileResult> {
  return useMobileQuery(projectReadFileQuery, input, input.environmentId);
}

/**
 * Raster image bytes, base64 over the same socket. The retained-key budget for
 * this family is deliberately small, so leaving the screen makes the payload
 * evictable rather than keeping it for the session.
 */
export function useProjectReadFileBinary(
  input: ProjectReadFileBinaryInput,
): ProjectFilesQueryResult<ProjectReadFileBinaryResult> {
  return useMobileQuery(projectReadFileBinaryQuery, input, input.environmentId);
}

/**
 * Server-side entry search. The debounce lives here so every caller pays it: the
 * node ranks the results, and a request per keystroke would both burn the socket
 * and race answers back out of order.
 */
export function useProjectSearchEntries(
  input: ProjectSearchEntriesInput,
): ProjectSearchEntriesQueryResult {
  const normalizedQuery = normalizeWorkspaceFileSearchQuery(input.query);
  const [debouncedQuery, setDebouncedQuery] = useState(normalizedQuery);

  useEffect(() => {
    if (normalizedQuery === debouncedQuery) return;
    // Clearing the box is not a keystroke to wait out: drop back to the tree at
    // once rather than showing results for a query the user already erased.
    if (normalizedQuery.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(
      () => setDebouncedQuery(normalizedQuery),
      WORKSPACE_FILE_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [normalizedQuery, debouncedQuery]);

  const result = useMobileQuery(
    projectSearchEntriesQuery,
    { ...input, query: debouncedQuery },
    input.environmentId,
  );

  return { ...result, isDebouncing: normalizedQuery !== debouncedQuery };
}
