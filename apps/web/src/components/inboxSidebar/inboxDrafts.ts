import type { ThreadInboxDraftSummary } from "@ryco/client-runtime/state/threads";
import { hasComposerDraftContent } from "@ryco/client-runtime/state/threads/threadBodyResidency";

import type { ComposerThreadDraftState, DraftId, DraftThreadState } from "../../composerDraftStore";

/** A new thread not sent yet whose composer holds content: the Inbox lists it as a draft. */
export interface InboxSidebarDraft extends ThreadInboxDraftSummary {
  readonly draftId: DraftId;
  /** A "No project" chat whose chat project does not exist yet. */
  readonly isChat: boolean;
}

/** The title of a draft whose prompt has no text (only files, pull requests or other context). */
export const INBOX_DRAFT_FALLBACK_TITLE = "New thread";

/**
 * Longer than a sidebar row shows. Past it, typing on the first line no longer
 * changes the title, so the Inbox stops rebuilding on each keystroke.
 */
const INBOX_DRAFT_TITLE_MAX_CHARS = 80;

/** A draft's title: the first line of its prompt, capped, or the fallback. */
export function inboxDraftTitle(prompt: string): string {
  const start = prompt.search(/\S/);
  if (start === -1) return INBOX_DRAFT_FALLBACK_TITLE;
  const newline = prompt.indexOf("\n", start);
  const end = Math.min(
    newline === -1 ? prompt.length : newline,
    start + INBOX_DRAFT_TITLE_MAX_CHARS,
  );
  return prompt.slice(start, end).trim() || INBOX_DRAFT_FALLBACK_TITLE;
}

interface InboxDraftsStoreState {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftThreadState>>;
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState | undefined>>;
}

interface CachedDraft {
  readonly session: DraftThreadState;
  readonly composer: ComposerThreadDraftState;
  readonly draft: InboxSidebarDraft | null;
}

function toInboxDraft(
  draftId: DraftId,
  session: DraftThreadState,
  composer: ComposerThreadDraftState,
): InboxSidebarDraft | null {
  // A sent draft becomes its server thread; the Inbox lists that one.
  if (session.promotedTo != null || !hasComposerDraftContent(composer)) return null;
  return {
    draftId,
    environmentId: session.environmentId,
    threadId: session.threadId,
    projectId: session.projectId,
    title: inboxDraftTitle(composer.prompt),
    createdAt: session.createdAt,
    branch: session.branch,
    worktreePath: session.worktreePath,
    isChat: session.pendingChat === true,
  };
}

function sameInboxDraft(left: InboxSidebarDraft, right: InboxSidebarDraft): boolean {
  return (
    left.draftId === right.draftId &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.isChat === right.isChat
  );
}

/**
 * The drafts the Inbox lists, from the composer draft store. The result keeps its
 * identity until a listed draft changes, so typing in a composer (which replaces
 * its draft on every keystroke) rebuilds the Inbox only when a title changes or a
 * draft gains or loses all its content.
 */
export function createInboxDraftsSelector(): (
  state: InboxDraftsStoreState,
) => ReadonlyArray<InboxSidebarDraft> {
  let cache = new Map<string, CachedDraft>();
  let previous: ReadonlyArray<InboxSidebarDraft> = [];
  return (state) => {
    const nextCache = new Map<string, CachedDraft>();
    const next: InboxSidebarDraft[] = [];
    for (const [draftId, session] of Object.entries(state.draftThreadsByThreadKey)) {
      // A draft session's composer content is stored under its draft id.
      const composer = state.draftsByThreadKey[draftId];
      if (composer === undefined) continue;
      const cached = cache.get(draftId);
      const draft =
        cached !== undefined && cached.session === session && cached.composer === composer
          ? cached.draft
          : toInboxDraft(draftId as DraftId, session, composer);
      nextCache.set(draftId, { session, composer, draft });
      if (draft !== null) next.push(draft);
    }
    cache = nextCache;
    if (
      next.length === previous.length &&
      next.every((draft, index) => sameInboxDraft(draft, previous[index]!))
    ) {
      return previous;
    }
    previous = next;
    return next;
  };
}
