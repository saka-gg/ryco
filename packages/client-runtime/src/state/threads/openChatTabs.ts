/**
 * The open chat tabs of the desktop chat header: one ordered list of scoped thread refs, the
 * pure transitions on it, which open chats render as tabs, and which tab takes over when one
 * closes. A tab is a reference, never a connection: it renders from the shell summary the store
 * already holds, so an open tab neither retains an environment nor subscribes to its thread.
 * Ported from Synara 1.0.0's open-thread tabs (`openThreadTabs.logic.ts`, `lib/tabStrip.ts`).
 *
 * @module openChatTabs
 */
import type { ProjectId, ProviderDriverKind, ScopedThreadRef } from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { scopedThreadKey } from "../../scoped.ts";
import { deriveThreadActivityStatus } from "./threadActivityStatus.ts";
import { isArchivedThreadStub, type SidebarThreadOrStub } from "./types.ts";

export const OPEN_CHAT_TABS_STORAGE_KEY = "ryco:open-chat-tabs:v1";
const OPEN_CHAT_TABS_DOCUMENT_VERSION = 1;
/** A stored list longer than this is cut, so a corrupt document cannot grow without bound. */
export const MAX_OPEN_CHAT_TABS = 200;
const MAX_OPEN_CHAT_TABS_DOCUMENT_LENGTH = 128 * 1024;
const MAX_REF_PART_LENGTH = 512;

const sameRef = (a: ScopedThreadRef, b: ScopedThreadRef) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

const indexOfRef = (refs: readonly ScopedThreadRef[], ref: ScopedThreadRef) =>
  refs.findIndex((candidate) => sameRef(candidate, ref));

// The transitions return the input array untouched when nothing changes, so the store can skip
// no-op writes (and the storage round trip) by identity.

/** Opening a chat that already has a tab keeps its position; a new one goes last. */
export function addOpenChatTab(
  refs: readonly ScopedThreadRef[],
  ref: ScopedThreadRef,
): readonly ScopedThreadRef[] {
  return indexOfRef(refs, ref) >= 0 ? refs : [...refs, ref];
}

export function removeOpenChatTabs(
  refs: readonly ScopedThreadRef[],
  removed: readonly ScopedThreadRef[],
): readonly ScopedThreadRef[] {
  return pruneOpenChatTabs(refs, (ref) => indexOfRef(removed, ref) < 0);
}

export function removeOpenChatTab(
  refs: readonly ScopedThreadRef[],
  ref: ScopedThreadRef,
): readonly ScopedThreadRef[] {
  return removeOpenChatTabs(refs, [ref]);
}

/**
 * Drops a dragged tab onto another tab's slot in the full open list, keeping hidden tabs and
 * their relative order.
 */
export function moveOpenChatTab(
  refs: readonly ScopedThreadRef[],
  ref: ScopedThreadRef,
  overRef: ScopedThreadRef,
): readonly ScopedThreadRef[] {
  const fromIndex = indexOfRef(refs, ref);
  const toIndex = indexOfRef(refs, overRef);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return refs;
  const next = [...refs];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function pruneOpenChatTabs(
  refs: readonly ScopedThreadRef[],
  isKept: (ref: ScopedThreadRef) => boolean,
): readonly ScopedThreadRef[] {
  const kept = refs.filter(isKept);
  return kept.length === refs.length ? refs : kept;
}

/** The stored document: references only, never a title or any other thread content. */
export function encodeOpenChatTabs(refs: readonly ScopedThreadRef[]): string {
  return JSON.stringify({
    version: OPEN_CHAT_TABS_DOCUMENT_VERSION,
    tabs: refs.map((ref) => ({ environmentId: ref.environmentId, threadId: ref.threadId })),
  });
}

function decodeRef(value: unknown): ScopedThreadRef | null {
  if (!value || typeof value !== "object") return null;
  const { environmentId, threadId } = value as Record<string, unknown>;
  if (typeof environmentId !== "string" || typeof threadId !== "string") return null;
  const environment = environmentId.trim();
  const thread = threadId.trim();
  if (
    environment.length === 0 ||
    thread.length === 0 ||
    environment.length > MAX_REF_PART_LENGTH ||
    thread.length > MAX_REF_PART_LENGTH
  ) {
    return null;
  }
  return { environmentId: EnvironmentId.make(environment), threadId: ThreadId.make(thread) };
}

/**
 * Reads a stored document: unknown versions, oversized documents and malformed entries give no
 * tabs, duplicates keep their first position, and unknown fields are dropped.
 */
export function decodeOpenChatTabs(text: string | null | undefined): ScopedThreadRef[] {
  if (!text || text.length > MAX_OPEN_CHAT_TABS_DOCUMENT_LENGTH) return [];
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return [];
  }
  if (
    !document ||
    typeof document !== "object" ||
    (document as { version?: unknown }).version !== OPEN_CHAT_TABS_DOCUMENT_VERSION
  ) {
    return [];
  }
  const entries = (document as { tabs?: unknown }).tabs;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const refs: ScopedThreadRef[] = [];
  for (const entry of entries) {
    const ref = decodeRef(entry);
    if (!ref) continue;
    const key = scopedThreadKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
    if (refs.length >= MAX_OPEN_CHAT_TABS) break;
  }
  return refs;
}

/**
 * Whether an open chat keeps its tab while it is not on screen. An archived chat keeps one only
 * while it is the chat on screen; one that no longer exists loses it. A local draft stays
 * registered so its tab appears once it is sent, but it renders only from a server summary.
 */
export function canKeepOpenChatTab(
  summary: SidebarThreadOrStub | undefined,
  hasDraft: boolean,
): boolean {
  if (summary) return !isArchivedThreadStub(summary) && summary.archivedAt === null;
  return hasDraft;
}

export interface OpenChatTab {
  readonly ref: ScopedThreadRef;
  /** `scopedThreadKey(ref)`: the tab's identity in the strip and the drag. */
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly providerDriver: ProviderDriverKind | null;
  /** Working or connecting: the tab spins where the sidebar row pulses. */
  readonly isRunning: boolean;
}

/** One open ref with the shell summary the store holds for it (if any). */
export interface OpenChatTabSource {
  readonly ref: ScopedThreadRef;
  readonly summary: SidebarThreadOrStub | undefined;
}

/**
 * The tabs in open order. Unsent drafts and chats the store has no summary for never render; the
 * chat on screen renders even when it could not keep a tab in the background (archived).
 */
export function buildOpenChatTabs(input: {
  readonly sources: readonly OpenChatTabSource[];
  readonly activeRef: ScopedThreadRef | null;
}): OpenChatTab[] {
  return input.sources.flatMap(({ ref, summary }): OpenChatTab[] => {
    if (!summary) return [];
    const active = input.activeRef !== null && sameRef(ref, input.activeRef);
    if (!active && !canKeepOpenChatTab(summary, false)) return [];
    const full = isArchivedThreadStub(summary) ? null : summary;
    const status = full ? deriveThreadActivityStatus(full) : "idle";
    return [
      {
        ref,
        key: scopedThreadKey(ref),
        projectId: summary.projectId,
        title: summary.title,
        providerDriver: full?.providerDriver ?? null,
        isRunning: status === "working" || status === "connecting",
      },
    ];
  });
}

/**
 * Browser-style successor for a closed tab: the tab that slides into the closed slot (its right
 * neighbour), or the new last tab when the closed one was last. `remaining` is the list after
 * removal and `removedIndex` the closed tab's index before it.
 */
export function resolveTabAfterClose<T>(remaining: readonly T[], removedIndex: number): T | null {
  if (remaining.length === 0) return null;
  return remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)] ?? null;
}

type TabRef = Pick<OpenChatTab, "ref">;

/**
 * Where to go after closing a tab. Closing a background tab keeps the current chat (`null`);
 * closing the active one moves to the tab that slides into its slot, else the one before it
 * (`{ ref: null }` when it was the last tab).
 */
export function resolveOpenChatTabCloseTarget(input: {
  readonly tabs: readonly TabRef[];
  readonly closedRef: ScopedThreadRef;
  readonly activeRef: ScopedThreadRef | null;
}): { ref: ScopedThreadRef | null } | null {
  if (input.activeRef === null || !sameRef(input.closedRef, input.activeRef)) return null;
  const closedIndex = input.tabs.findIndex((tab) => sameRef(tab.ref, input.closedRef));
  const remaining = input.tabs.filter((tab) => !sameRef(tab.ref, input.closedRef));
  return { ref: resolveTabAfterClose(remaining, closedIndex)?.ref ?? null };
}

export type CloseOpenChatTabResult = { ok: true } | { ok: false; error: string };

export interface CloseOpenChatTabInput {
  readonly tabs: readonly TabRef[];
  readonly closedRef: ScopedThreadRef;
  readonly activeRef: ScopedThreadRef | null;
  readonly closeTab: (ref: ScopedThreadRef) => void;
  readonly openTab: (ref: ScopedThreadRef) => Promise<unknown>;
  /** What takes the last tab's place (a fresh chat); without one the last tab stays open. */
  readonly replaceLastTab?: (() => Promise<CloseOpenChatTabResult>) | undefined;
  /** The chat the route shows right now, read after the navigation settles. */
  readonly readRouteRef: () => ScopedThreadRef | null;
}

/**
 * Closes a tab. A background tab closes at once. The active tab first leaves for its successor
 * (or a fresh chat when it was the last tab) and closes only once the route has actually moved
 * off it: a guarded navigation (an editor buffer that fails to save) keeps the chat on screen,
 * and then it keeps its tab. Resolves with the replacement's error when it could not open.
 */
export async function closeOpenChatTab(
  input: CloseOpenChatTabInput,
): Promise<CloseOpenChatTabResult> {
  const target = resolveOpenChatTabCloseTarget(input);
  if (!target) {
    input.closeTab(input.closedRef);
    return { ok: true };
  }
  if (target.ref) {
    await input.openTab(target.ref);
  } else {
    if (!input.replaceLastTab) return { ok: true };
    const replacement = await input.replaceLastTab();
    if (!replacement.ok) return replacement;
  }
  const routeRef = input.readRouteRef();
  if (routeRef === null || !sameRef(routeRef, input.closedRef)) input.closeTab(input.closedRef);
  return { ok: true };
}

/** Which neighbours of a tab its context menu closes; the tab itself always stays. */
export type OpenChatTabCloseScope = "left" | "right" | "others";

/**
 * The tabs a scoped close removes, in tab order. Empty when the scope has nothing in it (no tabs
 * on that side, or the anchor is the only tab), which is also when its menu row is left out.
 */
export function resolveOpenChatTabsInCloseScope(
  tabs: readonly TabRef[],
  anchorRef: ScopedThreadRef,
  scope: OpenChatTabCloseScope,
): ScopedThreadRef[] {
  const anchorIndex = tabs.findIndex((tab) => sameRef(tab.ref, anchorRef));
  if (anchorIndex < 0) return [];
  return tabs
    .filter((_, index) =>
      scope === "left"
        ? index < anchorIndex
        : scope === "right"
          ? index > anchorIndex
          : index !== anchorIndex,
    )
    .map((tab) => tab.ref);
}

/**
 * Closes several tabs around one that stays. When the chat on screen is among them the kept tab
 * takes over first, and (as with a single close) a chat the route could not leave keeps its tab.
 */
export async function closeOpenChatTabs(input: {
  readonly closedRefs: readonly ScopedThreadRef[];
  readonly keptRef: ScopedThreadRef;
  readonly activeRef: ScopedThreadRef | null;
  readonly closeTabs: (refs: readonly ScopedThreadRef[]) => void;
  readonly openTab: (ref: ScopedThreadRef) => Promise<unknown>;
  readonly readRouteRef: () => ScopedThreadRef | null;
}): Promise<void> {
  const { activeRef } = input;
  if (activeRef !== null && indexOfRef(input.closedRefs, activeRef) >= 0) {
    await input.openTab(input.keptRef);
  }
  const routeRef = input.readRouteRef();
  const closedRefs = input.closedRefs.filter((ref) => routeRef === null || !sameRef(ref, routeRef));
  if (closedRefs.length > 0) input.closeTabs(closedRefs);
}

/**
 * Runs tab closes one at a time, each reading its input when it starts rather than when its X was
 * clicked. A second close clicked while the first is still navigating must see where that
 * navigation lands: with the old active chat it would take the successor for a background tab and
 * drop it, and the landing chat would then reopen it.
 */
export function createOpenChatTabCloseQueue(): <Result>(
  run: () => Promise<Result>,
) => Promise<Result> {
  let queue: Promise<unknown> = Promise.resolve();
  return (run) => {
    const queued = queue.then(run, run);
    queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
}

/**
 * The next or previous tab from the one shown, wrapping at either end like a browser. With no
 * shown tab (a draft on screen) forward starts at the first tab and backward at the last.
 */
export function stepOpenChatTab(input: {
  readonly tabs: readonly TabRef[];
  readonly shownRef: ScopedThreadRef | null;
  readonly direction: "forward" | "backward";
}): ScopedThreadRef | null {
  const { tabs, shownRef, direction } = input;
  if (tabs.length === 0) return null;
  const index = shownRef === null ? -1 : tabs.findIndex((tab) => sameRef(tab.ref, shownRef));
  if (index < 0) return (direction === "forward" ? tabs[0] : tabs.at(-1))?.ref ?? null;
  const offset = direction === "forward" ? 1 : -1;
  return tabs[(index + offset + tabs.length) % tabs.length]?.ref ?? null;
}
