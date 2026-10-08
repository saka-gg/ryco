import {
  CheckIcon,
  FolderGit2Icon,
  FolderIcon,
  MessageCircleIcon,
  NotebookPenIcon,
  PinIcon,
  Trash2Icon,
} from "lucide-react";
import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts";
import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { SlidingTabs, type SlidingTab } from "~/components/ui/sliding-tabs";
import { useEvent } from "~/hooks/useEvent";
import { useReducedMotionEffective } from "~/hooks/useAppearancePreference";
import { usePresenceList, type PresencePhase } from "~/hooks/usePresenceList";
import { matchesExactModShortcut } from "~/keybindings";
import { cn, isMacPlatform } from "~/lib/utils";

import { formatNoteAge, parseNoteTodo, splitInlineCode } from "./noteText.logic";
import type { NoteSaveOutcome, NotesPaneView, NoteView, NoteViewScope } from "./noteView";

/** How long a removed note stays rendered while it collapses (prototype: 380ms). */
export const NOTES_EXIT_MS = 380;
/** Composer autosize bounds (one line → max). */
const COMPOSER_MIN_HEIGHT = 19;
const COMPOSER_MAX_HEIGHT = 120;
/** The prototype focuses the composer once the card's swap-in has started. */
const AUTO_FOCUS_DELAY_MS = 80;

const WORKTREE_TAB: SlidingTab = {
  id: "worktree",
  label: (
    <span className="notes-seg-label">
      <FolderGit2Icon aria-hidden="true" />
      Worktree
    </span>
  ),
  ariaLabel: "Worktree",
};
const PROJECT_TAB: SlidingTab = {
  id: "project",
  label: (
    <span className="notes-seg-label">
      <FolderIcon aria-hidden="true" />
      Project
    </span>
  ),
  ariaLabel: "Project",
};
const VIEW_TABS: ReadonlyArray<SlidingTab> = [WORKTREE_TAB, PROJECT_TAB];

const COMPOSER_PLACEHOLDER: Record<NotesPaneView, string> = {
  worktree: "Jot a note for this worktree…",
  project: "Pin a note to the whole project…",
};

const noteKey = (note: NoteView) => note.id;

export interface NotesPaneProps {
  readonly view: NotesPaneView;
  readonly onViewChange: (view: NotesPaneView) => void;
  /** Already filtered and ordered for `view`. */
  readonly notes: ReadonlyArray<NoteView>;
  readonly breadcrumb: { readonly project: string; readonly worktree: string | null };
  /** The current thread, shown as the composer's backlink chip. */
  readonly threadTitle: string | null;
  /** Non-null disables the composer and explains why (placeholder and title). */
  readonly composerDisabledReason: string | null;
  /** Non-null makes the listed notes read-only (todo, pin and delete off) and explains why. */
  readonly actionsDisabledReason?: string | null | undefined;
  /** The last failed read or change, shown under the composer. */
  readonly error?: string | null | undefined;
  /**
   * The composer clears and keeps focus at once; a save that resolves as
   * rejected or refused hands its text back (when the composer is still empty).
   */
  readonly onSave: (body: string, scope: NoteViewScope) => Promise<NoteSaveOutcome> | void;
  readonly onToggleTodo: (id: string) => void;
  readonly onTogglePin: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  /** Flashes this note and scrolls it into view (e.g. opened from a "Note saved" alert). */
  readonly highlightId?: string | null | undefined;
  /** Non-null turns the Worktree tab off and explains why (a draft without a checkout). */
  readonly worktreeViewDisabledReason?: string | null | undefined;
  /** The node listed only this many (newest) notes; the Project view says so. */
  readonly truncatedLimit?: number | null | undefined;
  /** Hides the icon + title row content when the host already titles the pane. */
  readonly compact?: boolean | undefined;
  readonly autoFocusComposer?: boolean | undefined;
}

/**
 * The worktree Notes pane (prototype `NotesPane`): a scope switch, a
 * breadcrumb, an auto-sizing composer and the note list with enter / exit
 * motion. Presentational: the parent owns data, sync and optimistic state.
 */
export const NotesPane = memo(function NotesPane(props: NotesPaneProps) {
  const {
    view,
    notes,
    breadcrumb,
    threadTitle,
    composerDisabledReason,
    actionsDisabledReason = null,
    error = null,
    highlightId = null,
    worktreeViewDisabledReason = null,
    truncatedLimit = null,
    compact = false,
    autoFocusComposer = false,
  } = props;
  const reducedMotion = useReducedMotionEffective();
  const entries = usePresenceList(notes, noteKey, {
    exitMs: NOTES_EXIT_MS,
    animate: !reducedMotion,
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [draft, setDraft] = useState("");
  const disabled = composerDisabledReason !== null;
  const hasText = draft.trim().length > 0;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${COMPOSER_MIN_HEIGHT}px`;
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- re-measure when the text changes
  }, [draft]);

  useEffect(() => {
    if (!autoFocusComposer || disabled) return;
    const timer = setTimeout(
      () => textareaRef.current?.focus({ preventScroll: true }),
      AUTO_FOCUS_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [autoFocusComposer, disabled]);

  // Scroll the highlighted note into view once it is rendered (it may arrive after a refresh).
  // Only its own scroller moves: the crown island around it must never scroll mid-morph.
  const scrolledHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    if (highlightId === null) {
      scrolledHighlightRef.current = null;
      return;
    }
    if (scrolledHighlightRef.current === highlightId) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${CSS.escape(highlightId)}"]`,
    );
    if (!row) return;
    scrolledHighlightRef.current = highlightId;
    scrollIntoScroller(row, reducedMotion ? "auto" : "smooth");
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retry once the rows change
  }, [entries, highlightId, reducedMotion]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const save = useEvent(() => {
    if (disabled) return;
    const body = draft.trim();
    if (!body) return;
    const saved = props.onSave(body, view === "project" ? "project" : "worktree");
    setDraft("");
    // A refused or rejected note was not kept: give its text back unless the user typed on.
    void saved?.then((outcome) => {
      if (!mountedRef.current || (outcome !== "rejected" && outcome !== "refused")) return;
      setDraft((current) => (current.trim() ? current : body));
    });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Only blur: the crown card stays open (its Escape listener sits on the document).
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" && matchesExactModShortcut(event, "enter")) {
      event.preventDefault();
      event.stopPropagation();
      save();
    }
  };

  const onToggleTodo = useEvent((id: string) => props.onToggleTodo(id));
  const onTogglePin = useEvent((id: string) => props.onTogglePin(id));
  const onDelete = useEvent((id: string) => props.onDelete(id));
  const openThread = useEvent((threadId: string) => props.onOpenThread?.(threadId));
  const tabs = useMemo(
    () =>
      worktreeViewDisabledReason === null
        ? VIEW_TABS
        : [{ ...WORKTREE_TAB, disabled: true, title: worktreeViewDisabledReason }, PROJECT_TAB],
    [worktreeViewDisabledReason],
  );

  const placeholder = composerDisabledReason ?? COMPOSER_PLACEHOLDER[view];
  const saveShortcut = isMacPlatform(navigator.platform) ? "⌘↵" : "Ctrl↵";
  return (
    <div
      className={cn("notes-pane", compact && "notes-compact")}
      data-slot="notes-pane"
      data-view={view}
      data-motion={reducedMotion ? "reduced" : undefined}
    >
      <div className="notes-head">
        <NotebookPenIcon aria-hidden="true" className="notes-head-icon" />
        <span className="notes-title">Notes</span>
        <SlidingTabs
          className="notes-seg"
          aria-label="Notes scope"
          tabs={tabs}
          activeId={view}
          onSelect={(id) => props.onViewChange(id === "project" ? "project" : "worktree")}
        />
      </div>

      <div className="notes-crumb" data-slot="notes-breadcrumb">
        <FolderIcon aria-hidden="true" />
        <span className="notes-crumb-name">{breadcrumb.project}</span>
        {view === "project" ? (
          <span className="shrink-0">· all worktrees</span>
        ) : breadcrumb.worktree !== null ? (
          <>
            <span className="shrink-0">›</span>
            <FolderGit2Icon aria-hidden="true" />
            <span className="notes-crumb-name">{breadcrumb.worktree}</span>
          </>
        ) : null}
        <span className="notes-count" data-slot="notes-count" aria-hidden="true">
          {notes.length}
        </span>
        <span className="sr-only">{notes.length === 1 ? "1 note" : `${notes.length} notes`}</span>
      </div>

      <div
        className="notes-compose"
        data-has-text={hasText ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
      >
        <textarea
          ref={textareaRef}
          className="notes-textarea"
          rows={1}
          maxLength={NOTE_BODY_MAX_LENGTH}
          aria-label="New note"
          placeholder={placeholder}
          title={composerDisabledReason ?? undefined}
          disabled={disabled}
          value={draft}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="notes-cfoot">
          {threadTitle !== null ? (
            <span className="crown-chip" data-slot="notes-composer-thread">
              <MessageCircleIcon aria-hidden="true" />
              <span className="truncate">{threadTitle}</span>
            </span>
          ) : null}
          <button
            type="button"
            className="notes-save"
            disabled={disabled}
            // Keep focus in the textarea so saving keeps the composer open.
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={save}
          >
            Save <kbd>{saveShortcut}</kbd>
          </button>
        </div>
      </div>

      {error !== null ? (
        <div className="notes-error" role="alert" data-slot="notes-error">
          {error}
        </div>
      ) : null}

      <ul ref={listRef} className="notes-list" aria-label="Notes">
        {entries.map((entry) => (
          <NoteItem
            key={entry.key}
            note={entry.item}
            phase={entry.phase}
            highlighted={entry.key === highlightId}
            readOnlyReason={actionsDisabledReason}
            onToggleTodo={onToggleTodo}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
            onOpenThread={props.onOpenThread ? openThread : undefined}
          />
        ))}
      </ul>
      {notes.length === 0 ? (
        <div className="notes-empty" data-slot="notes-empty">
          No notes here yet
        </div>
      ) : null}
      {view === "project" && truncatedLimit !== null ? (
        <div className="notes-footnote" data-slot="notes-truncated">
          Showing the {truncatedLimit} newest notes
        </div>
      ) : null}
    </div>
  );
});

/**
 * Brings `row` into its nearest vertical scroller's view (nearest edge),
 * moving only that scroller, never the clipped containers around it.
 */
function scrollIntoScroller(row: HTMLElement, behavior: ScrollBehavior) {
  let scroller = row.parentElement;
  while (scroller) {
    const overflowY = getComputedStyle(scroller).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") break;
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const top =
    row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  const bottom = top + row.offsetHeight;
  if (top < scroller.scrollTop) scroller.scrollTo({ top, behavior });
  else if (bottom > scroller.scrollTop + scroller.clientHeight)
    scroller.scrollTo({ top: bottom - scroller.clientHeight, behavior });
}

const NoteItem = memo(function NoteItem({
  note,
  phase,
  highlighted,
  readOnlyReason,
  onToggleTodo,
  onTogglePin,
  onDelete,
  onOpenThread,
}: {
  note: NoteView;
  phase: PresencePhase;
  highlighted: boolean;
  readOnlyReason: string | null;
  onToggleTodo: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenThread: ((threadId: string) => void) | undefined;
}) {
  const { todo, text } = parseNoteTodo(note.body);
  const pinned = note.scope === "project";
  const otherWorktree = !pinned && note.worktreeLabel !== null;
  const pending = note.pending === true;
  // Exiting rows and unconfirmed saves are not actionable.
  const inert = phase === "exit" || pending;
  // Read-only notes (no write access) keep the thread chip but not the edits.
  const locked = inert || readOnlyReason !== null;
  const lockedTitle = readOnlyReason ?? undefined;
  const thread = note.thread;
  const threadLabel = thread ? (thread.title ?? "Deleted thread") : null;
  const textId = useId();
  return (
    <li
      className="notes-item"
      data-note-id={note.id}
      data-phase={phase}
      data-scope={note.scope}
      data-todo={todo ?? undefined}
      data-other={otherWorktree ? "" : undefined}
      data-pending={pending ? "" : undefined}
      data-highlight={highlighted ? "" : undefined}
      aria-busy={pending || undefined}
      inert={phase === "exit"}
    >
      <div>
        <div className="notes-card">
          <div className="notes-row">
            {todo !== null ? (
              <button
                type="button"
                className="notes-check"
                role="checkbox"
                aria-checked={todo === "done"}
                aria-labelledby={textId}
                title={lockedTitle}
                disabled={locked}
                onClick={() => onToggleTodo(note.id)}
              >
                <CheckIcon aria-hidden="true" />
              </button>
            ) : null}
            <div className="notes-text" id={textId}>
              {splitInlineCode(text).map((segment, index) =>
                segment.kind === "code" ? (
                  // oxlint-disable-next-line react/no-array-index-key -- segments are positional
                  <code key={index}>{segment.text}</code>
                ) : (
                  segment.text
                ),
              )}
            </div>
          </div>
          <div className="notes-meta">
            {pinned ? (
              <span className="crown-chip notes-chip-pin">
                <PinIcon aria-hidden="true" />
                <span>project</span>
              </span>
            ) : null}
            {otherWorktree ? (
              <span className="crown-chip" data-slot="notes-worktree-chip">
                <FolderGit2Icon aria-hidden="true" />
                <span>{note.worktreeLabel}</span>
              </span>
            ) : null}
            {thread && threadLabel !== null ? (
              onOpenThread && thread.title !== null ? (
                <button
                  type="button"
                  className="crown-chip notes-thread-chip"
                  title={`Open “${thread.title}”`}
                  disabled={inert}
                  onClick={() => onOpenThread(thread.id)}
                >
                  <MessageCircleIcon aria-hidden="true" />
                  <span>{threadLabel}</span>
                </button>
              ) : (
                <span className="crown-chip" data-slot="notes-thread-chip">
                  <MessageCircleIcon aria-hidden="true" />
                  <span>{threadLabel}</span>
                </span>
              )
            ) : null}
            <time dateTime={note.createdAt}>{formatNoteAge(note.createdAt)}</time>
          </div>
          <span className="notes-acts">
            <button
              type="button"
              className="crown-icon-btn notes-pin-btn"
              title={lockedTitle ?? (pinned ? "Unpin from project" : "Pin to project")}
              // The name stays put; aria-pressed carries the state.
              aria-label="Pinned to project"
              aria-pressed={pinned}
              disabled={locked}
              onClick={() => onTogglePin(note.id)}
            >
              <PinIcon aria-hidden="true" />
            </button>
            <button
              type="button"
              className="crown-icon-btn"
              title={lockedTitle ?? "Delete note"}
              aria-label="Delete note"
              disabled={locked}
              onClick={() => onDelete(note.id)}
            >
              <Trash2Icon aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
    </li>
  );
});
