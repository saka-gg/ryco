import type { SourceControlChangeRequestMergeMethod } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";

/**
 * State the facts rail shares between its two homes (the Conversation rail or
 * band, and the bar off Conversation): which stack section is open, the merge
 * method the user prefers per repository, the delete-branch choice per pull
 * request, and one-shot requests to open a picker from elsewhere (the "Request
 * review" button opens the reviewers picker).
 */

export type PeopleField = "reviewers" | "assignees" | "labels";

const MERGE_METHOD_STORAGE_KEY = "ryco:pull-requests-merge-method:v1";

const PersistedMergeMethods = Schema.Record(
  Schema.String,
  Schema.Literals(["merge", "squash", "rebase"]),
);

function restoreMergeMethods(): Record<string, SourceControlChangeRequestMergeMethod> {
  try {
    return { ...getLocalStorageItem(MERGE_METHOD_STORAGE_KEY, PersistedMergeMethods) };
  } catch {
    return {};
  }
}

interface RailState {
  /** Stack section expanded, per reader key. */
  readonly stackExpanded: Readonly<Record<string, boolean>>;
  /** Last merge method picked, per repository key (a habit, so it persists). */
  readonly mergeMethod: Readonly<Record<string, SourceControlChangeRequestMergeMethod>>;
  /** "Delete branch after merge", per reader key, once the user touched it. */
  readonly deleteBranch: Readonly<Record<string, boolean>>;
  readonly pickerRequest: {
    readonly key: string;
    readonly field: PeopleField;
    readonly token: number;
  } | null;
  setStackExpanded(key: string, expanded: boolean): void;
  setMergeMethod(repositoryKey: string, method: SourceControlChangeRequestMergeMethod): void;
  setDeleteBranch(key: string, value: boolean): void;
  requestPicker(key: string, field: PeopleField): void;
  clearPickerRequest(token: number): void;
}

export const usePullRequestRailStore = create<RailState>()((set) => ({
  stackExpanded: {},
  mergeMethod: restoreMergeMethods(),
  deleteBranch: {},
  pickerRequest: null,
  setStackExpanded: (key, expanded) =>
    set((state) => ({ stackExpanded: { ...state.stackExpanded, [key]: expanded } })),
  setMergeMethod: (repositoryKey, method) =>
    set((state) => {
      const mergeMethod = { ...state.mergeMethod, [repositoryKey]: method };
      try {
        setLocalStorageItem(MERGE_METHOD_STORAGE_KEY, mergeMethod, PersistedMergeMethods);
      } catch {
        // A preference that fails to persist still applies for this session.
      }
      return { mergeMethod };
    }),
  setDeleteBranch: (key, value) =>
    set((state) => ({ deleteBranch: { ...state.deleteBranch, [key]: value } })),
  requestPicker: (key, field) => set({ pickerRequest: { key, field, token: Date.now() } }),
  clearPickerRequest: (token) =>
    set((state) => (state.pickerRequest?.token === token ? { pickerRequest: null } : state)),
}));
