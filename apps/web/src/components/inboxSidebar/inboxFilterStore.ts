import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

import type { InboxSidebarSectionKey, InboxSidebarStatusFilter } from "./inboxSidebarModel";

/** A logical project: its members on every machine, named as the row named it. */
export interface InboxProjectFilter {
  readonly logicalKey: string;
  readonly label: string;
}

/**
 * Inbox filters, shared by the sidebar header's Omnifield (which edits them)
 * and the Inbox list (which applies them). Session-only, like the old
 * in-list filter row: a reload starts unfiltered.
 */
interface InboxFilterStore {
  /** The Omnifield's text in Inbox mode, kept while the sidebar shows Projects. */
  readonly draft: string;
  readonly environmentId: EnvironmentId | null;
  /** Set from a row's menu; the field only shows it as a token. */
  readonly project: InboxProjectFilter | null;
  readonly status: InboxSidebarStatusFilter;
  /** Rows the list shows for the current filters, for the field's hints. */
  readonly matchCount: number;
  /** Rows per section as shown; null while a status filter hides the other sections. */
  readonly sectionCounts: Readonly<Partial<Record<InboxSidebarSectionKey, number>>> | null;
  readonly setDraft: (draft: string) => void;
  readonly setEnvironmentId: (environmentId: EnvironmentId | null) => void;
  readonly setProject: (project: InboxProjectFilter | null) => void;
  readonly setStatus: (status: InboxSidebarStatusFilter) => void;
  readonly publishCounts: (
    matchCount: number,
    sectionCounts: Readonly<Partial<Record<InboxSidebarSectionKey, number>>> | null,
  ) => void;
}

function sameCounts(
  left: Readonly<Partial<Record<string, number>>> | null,
  right: Readonly<Partial<Record<string, number>>> | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export const useInboxFilterStore = create<InboxFilterStore>((set, get) => ({
  draft: "",
  environmentId: null,
  project: null,
  status: "all",
  matchCount: 0,
  sectionCounts: null,
  setDraft: (draft) => set({ draft }),
  setEnvironmentId: (environmentId) => set({ environmentId }),
  setProject: (project) => set({ project }),
  setStatus: (status) => set({ status }),
  publishCounts: (matchCount, sectionCounts) => {
    const state = get();
    if (state.matchCount === matchCount && sameCounts(state.sectionCounts, sectionCounts)) return;
    set({ matchCount, sectionCounts });
  },
}));
