import { FolderGit2Icon, FolderIcon, NotebookPenIcon } from "lucide-react";
import { NOTE_BODY_MAX_LENGTH } from "@ryco/contracts";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import { SlidingTabs, type SlidingTab } from "~/components/ui/sliding-tabs";
import { useReducedMotionEffective } from "~/hooks/useAppearancePreference";
import { matchesExactModShortcut } from "~/keybindings";
import { cn } from "~/lib/utils";

import type { NotesPaneView, NotesSaveState } from "./noteView";

/** Editor autosize bounds: it grows with its text, then scrolls. */
const EDITOR_MIN_HEIGHT = 160;
const EDITOR_MAX_HEIGHT = 420;
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

const PLACEHOLDER: Record<NotesPaneView, string> = {
  worktree: "Notes for this worktree…",
  project: "Notes for the whole project…",
};
const EDITOR_LABEL: Record<NotesPaneView, string> = {
  worktree: "Worktree notes",
  project: "Project notes",
};
const SAVE_STATE_LABEL: Record<NotesSaveState, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
};

export interface NotesPaneProps {
  readonly view: NotesPaneView;
  readonly onViewChange: (view: NotesPaneView) => void;
  /** The document's text for `view`. */
  readonly body: string;
  readonly onChange: (view: NotesPaneView, body: string) => void;
  /** Saves pending text now (blur, the save shortcut). */
  readonly onFlush: (view: NotesPaneView) => void;
  readonly saveState: NotesSaveState;
  readonly breadcrumb: { readonly project: string; readonly worktree: string | null };
  /** Non-null makes the editor read-only and explains why (placeholder and title). */
  readonly disabledReason: string | null;
  /** The last failed read or save, shown under the editor. */
  readonly error?: string | null | undefined;
  /** Non-null turns the Worktree tab off and explains why (a draft without a checkout). */
  readonly worktreeViewDisabledReason?: string | null | undefined;
  /** Hides the icon + title row content when the host already titles the pane. */
  readonly compact?: boolean | undefined;
  readonly autoFocus?: boolean | undefined;
}

/**
 * The Notes pane: a scope switch, a breadcrumb and one free-text editor for
 * the worktree's or the project's notes. Presentational: the parent owns the
 * text, saving and sync.
 */
export const NotesPane = memo(function NotesPane(props: NotesPaneProps) {
  const {
    view,
    body,
    saveState,
    breadcrumb,
    disabledReason,
    error = null,
    worktreeViewDisabledReason = null,
    compact = false,
    autoFocus = false,
  } = props;
  const reducedMotion = useReducedMotionEffective();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = disabledReason !== null;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = `${EDITOR_MIN_HEIGHT}px`;
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, EDITOR_MIN_HEIGHT), EDITOR_MAX_HEIGHT)}px`;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- re-measure when the text or editor changes
  }, [body, view]);

  useEffect(() => {
    if (!autoFocus || disabled) return;
    const timer = setTimeout(
      () => textareaRef.current?.focus({ preventScroll: true }),
      AUTO_FOCUS_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [autoFocus, disabled]);

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
      props.onFlush(view);
    }
  };

  const tabs = useMemo(
    () =>
      worktreeViewDisabledReason === null
        ? VIEW_TABS
        : [{ ...WORKTREE_TAB, disabled: true, title: worktreeViewDisabledReason }, PROJECT_TAB],
    [worktreeViewDisabledReason],
  );

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
          onSelect={(id) => {
            // Leaving a view saves what was typed there.
            props.onFlush(view);
            props.onViewChange(id === "project" ? "project" : "worktree");
          }}
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
        {disabled ? null : (
          <span
            className="notes-save-state"
            data-slot="notes-save-state"
            data-state={saveState}
            aria-live="polite"
          >
            {SAVE_STATE_LABEL[saveState]}
          </span>
        )}
      </div>

      <div className="notes-editor" data-disabled={disabled ? "" : undefined}>
        <textarea
          // A fresh editor per document: undo history never crosses scopes.
          key={view}
          ref={textareaRef}
          className="notes-textarea"
          maxLength={NOTE_BODY_MAX_LENGTH}
          aria-label={EDITOR_LABEL[view]}
          placeholder={disabledReason ?? PLACEHOLDER[view]}
          title={disabledReason ?? undefined}
          readOnly={disabled}
          aria-disabled={disabled || undefined}
          spellCheck
          value={body}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
            props.onChange(view, event.target.value)
          }
          onBlur={() => props.onFlush(view)}
          onKeyDown={onKeyDown}
        />
      </div>

      {error !== null ? (
        <div className="notes-error" role="alert" data-slot="notes-error">
          {error}
        </div>
      ) : null}
    </div>
  );
});
