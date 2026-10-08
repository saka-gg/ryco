import {
  NOTE_BODY_MAX_LENGTH,
  NotesCommand,
  WS_METHODS,
  type EnvironmentId,
  type NoteScope,
  type NotesApi,
  type NotesSnapshot,
  type ProjectId,
  type ThreadId,
  type WorktreeId,
  type WorktreeNote,
} from "@ryco/contracts";
import {
  applyPendingNoteChanges,
  noteWorktreeKey,
  projectNotesKey,
  retainProjectNotes,
  selectPinnedNotes,
  selectProjectNotes,
  selectProjectNotesState,
  selectWorktreeNotes,
  toggleNoteTodo,
  useNotesStore,
  type ListedNote,
  type NotesCheckout,
  type PendingNoteChange,
  type NotesRefreshTriggers,
  type ProjectNotesStatus,
  type ProjectNotesSync,
} from "@ryco/client-runtime/state/notes";
import { Schema } from "effect";
import { isTagged } from "effect/Predicate";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApiForConnection } from "../../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../../environments/runtime";
import { useEvent } from "../../../hooks/useEvent";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { selectEnvironmentState, useStore } from "../../../store";
import type { SidebarWorktreeSummary } from "../../../types";
import type { NoteSaveOutcome, NotesPaneView, NoteView, NoteViewScope } from "./noteView";

export type { NoteSaveOutcome } from "./noteView";

/** What a thread's notes are written against. */
export interface WorktreeNotesTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The thread's checkout; null while a draft has none yet (Project view, composer off). */
  readonly checkout: NotesCheckout | null;
  /** The server thread notes link back to; null for drafts. */
  readonly threadId: ThreadId | null;
  /** The node advertises `capabilities.worktreeNotes`. */
  readonly available: boolean;
}

export interface WorktreeNotesOptions {
  /** Opens a note's backlinked thread (same environment); omitted keeps the chip static. */
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}

export interface WorktreeNotes {
  /** The node has notes and this client can reach them: the rail shows the Notes icon. */
  readonly available: boolean;
  readonly status: ProjectNotesStatus;
  /** The node's notes have answered at least once, so the lists are real (alert baselines wait for it). */
  readonly loaded: boolean;
  /** The last failed read or command, or null. */
  readonly error: string | null;
  /** This checkout's notes plus pinned ones, pinned first (only pinned while a draft has no checkout). */
  readonly worktreeNotes: ReadonlyArray<NoteView>;
  /** Every note of the project, newest first. */
  readonly projectNotes: ReadonlyArray<NoteView>;
  /**
   * The Worktree view as the node confirmed it, plus this client's unconfirmed
   * creates: what "Note saved" alerts diff. Pending edits and deletes are left
   * out, so one rolling back never looks like a note appearing.
   */
  readonly alertNotes: ReadonlyArray<{ readonly id: string; readonly body: string }>;
  /** The node's list stopped at this many notes (more exist), or null. */
  readonly truncatedLimit: number | null;
  readonly counts: { readonly worktree: number; readonly project: number };
  /** The pane's scope switch, shared by the card and its flyout. */
  readonly view: NotesPaneView;
  readonly setView: (view: NotesPaneView) => void;
  /** Why the Worktree view is off (a draft without a checkout), or null. */
  readonly worktreeViewDisabledReason: string | null;
  readonly notesFor: (view: NotesPaneView) => ReadonlyArray<NoteView>;
  readonly breadcrumb: { readonly project: string; readonly worktree: string | null };
  /** The composer's backlink chip. */
  readonly threadTitle: string | null;
  /** Why changes are off (no reachable notes, hosted role), or null. */
  readonly disabledReason: string | null;
  /** {@link disabledReason}, or why this thread cannot write notes yet. */
  readonly composerDisabledReason: string | null;
  /** Notes this client created or pinned (pending or confirmed); they never alert as saved elsewhere. */
  readonly ownNoteIds: ReadonlySet<string>;
  /** Shows the note at once; resolves with how the first attempt ended. */
  readonly save: (body: string, scope: NoteViewScope) => Promise<NoteSaveOutcome>;
  readonly toggleTodo: (noteId: string) => void;
  readonly togglePin: (noteId: string) => void;
  readonly remove: (noteId: string) => void;
  readonly refresh: () => void;
  /** Opens a note's thread, or null when the host gave no navigation. */
  readonly openThread: ((threadId: string) => void) | null;
}

export const NOTES_DRAFT_REASON = "Send the first message to start worktree notes";
const NOTES_UNREACHABLE_REASON = "Connect to a server with notes available.";
const NOTES_READ_ONLY_REASON = "Notes are read-only here.";
export const NOTES_UNCONFIRMED =
  "Couldn't confirm the change. It will be checked again when you return.";
export const NOTES_CREATE_UNCONFIRMED = "Couldn't confirm the note yet. It will be sent again.";
export const NOTES_TOO_LONG = `Note is too long (${NOTE_BODY_MAX_LENGTH.toLocaleString("en-US")} characters max).`;
const NOTES_INVALID = "The note couldn't be saved.";
/** Backoff for resending a create whose reply was lost, while the notes stay bound. */
const CREATE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

const EMPTY_OWN_IDS: ReadonlySet<string> = new Set();
const NO_PENDING: ReadonlyMap<string, PendingNoteChange> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const isNotesCommand = Schema.is(NotesCommand);

/** The window regaining focus re-reads a project once, however many panes show it. */
const refreshOnWindowFocus: NotesRefreshTriggers = (refresh) => {
  window.addEventListener("focus", refresh);
  return () => window.removeEventListener("focus", refresh);
};

/** The node judged the command; any other failure may not have reached it. */
const isServerAnswer = (cause: unknown) =>
  isTagged(cause, "NotesError") || isTagged(cause, "AuthRpcError");

const isConflict = (cause: unknown) =>
  isTagged(cause, "NotesError") && (cause as { reason?: unknown }).reason === "conflict";

/** The node's own words for its answers; transport text never reaches the banner. */
function errorMessage(cause: unknown): string {
  const message = isServerAnswer(cause) ? (cause as { message?: unknown }).message : undefined;
  return typeof message === "string" && message ? message : NOTES_UNCONFIRMED;
}

/**
 * A command failure shown in the pane. `seen` is the snapshot listed once the
 * follow-up read settled (undefined until then): any later snapshot means the
 * list was reconciled, so the message goes.
 */
interface CommandError {
  readonly message: string;
  readonly seen?: NotesSnapshot | null;
}

function worktreeLabel(summary: SidebarWorktreeSummary | undefined): string | null {
  if (!summary) return null;
  return summary.title?.trim() || summary.branch || null;
}

function withChange(
  pending: ReadonlyMap<string, PendingNoteChange>,
  noteId: string,
  change: PendingNoteChange | null,
): ReadonlyMap<string, PendingNoteChange> {
  if (change === null && !pending.has(noteId)) return pending;
  const next = new Map(pending);
  if (change === null) next.delete(noteId);
  else next.set(noteId, change);
  return next;
}

function withId(ids: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  if (ids.has(id) === present) return ids;
  const next = new Set(ids);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

type CreateCommand = Extract<NotesCommand, { kind: "create" }>;

/**
 * One thread's worktree notes, kept fresh from the node: the project's notes
 * are read when the section is bound, when the connection changes, when the
 * window regains focus, on {@link WorktreeNotes.refresh} (the Notes section
 * opening) and from every command's reply. Changes show at once as pending
 * entries; a create keeps its client-generated id, so retrying one whose
 * reply was lost (with a short backoff, on reconnect, focus or reopening)
 * can never save it twice.
 */
export function useWorktreeNotes(
  target: WorktreeNotesTarget | null,
  options: WorktreeNotesOptions = {},
): WorktreeNotes {
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  const requested = target?.available === true && environmentId !== null && projectId !== null;
  const checkout = target?.checkout ?? null;
  const worktreeKey = checkout ? noteWorktreeKey(checkout) : null;
  const threadId = target?.threadId ?? null;
  const capability = useHostedRpcCapability(WS_METHODS.notesCommand);
  const key = environmentId && projectId ? projectNotesKey(environmentId, projectId) : null;

  const [bound, setBound] = useState(false);
  const [view, setStoredView] = useState<NotesPaneView>("worktree");
  const [pending, setPending] = useState(NO_PENDING);
  const [commandError, setCommandError] = useState<CommandError | null>(null);
  /** Creates whose reply was lost and are not confirmed yet. */
  const [unconfirmed, setUnconfirmed] = useState(NO_IDS);
  /** Bumped by every lost create reply; steps the resend backoff. */
  const [lostReplies, setLostReplies] = useState(0);
  const binding = useRef<{
    api: NotesApi;
    sync: ProjectNotesSync;
    epoch: number;
  } | null>(null);
  const epochRef = useRef(0);
  const inFlight = useRef(new Set<string>());
  /** Creates whose reply never arrived, by note id; resent with the same id. */
  const unsent = useRef(new Map<string, CreateCommand>());

  /** Shows a failure until a read after its follow-up reconciles the list. */
  const reportError = useCallback(
    (current: NonNullable<typeof binding.current>, message: string) => {
      const reported: CommandError = { message };
      setCommandError(reported);
      void current.sync.refresh().then(() => {
        if (current.epoch !== epochRef.current) return;
        const seen = selectProjectNotesState(useNotesStore.getState(), current.sync.key).snapshot;
        setCommandError((error) => (error === reported ? { message, seen } : error));
      });
    },
    [],
  );

  const settleCreate = useCallback((noteId: string) => {
    setPending((map) => withChange(map, noteId, null));
    setUnconfirmed((ids) => withId(ids, noteId, false));
  }, []);

  const sendCreate = useCallback(
    async (command: CreateCommand): Promise<NoteSaveOutcome> => {
      const current = binding.current;
      if (!current) {
        unsent.current.set(command.noteId, command);
        return "unconfirmed";
      }
      if (inFlight.current.has(command.noteId)) return "unconfirmed";
      unsent.current.delete(command.noteId);
      // A body the contract refuses fails before the wire, every time: never "maybe landed".
      if (!isNotesCommand(command as unknown)) {
        settleCreate(command.noteId);
        setCommandError({
          message: command.body.length > NOTE_BODY_MAX_LENGTH ? NOTES_TOO_LONG : NOTES_INVALID,
        });
        return "refused";
      }
      inFlight.current.add(command.noteId);
      try {
        const snapshot = await current.api.command(command);
        if (current.epoch !== epochRef.current) return "unconfirmed";
        current.sync.applySnapshot(snapshot);
        settleCreate(command.noteId);
        return "saved";
      } catch (cause) {
        if (current.epoch !== epochRef.current) return "unconfirmed";
        if (isConflict(cause)) {
          // The id is taken: a retried create whose note was since deleted
          // elsewhere (the node keeps its tombstone). The fresh list settles it.
          const fresh = await current.api.list({ projectId: command.projectId }).catch(() => null);
          if (current.epoch !== epochRef.current) return "unconfirmed";
          if (fresh) {
            current.sync.applySnapshot(fresh);
            settleCreate(command.noteId);
            return "saved";
          }
        } else if (isServerAnswer(cause)) {
          settleCreate(command.noteId);
          reportError(current, errorMessage(cause));
          return "rejected";
        }
        // It may have landed: keep it pending and resend the same create later.
        unsent.current.set(command.noteId, command);
        setUnconfirmed((ids) => withId(ids, command.noteId, true));
        setLostReplies((count) => count + 1);
        return "unconfirmed";
      } finally {
        inFlight.current.delete(command.noteId);
      }
    },
    [reportError, settleCreate],
  );

  const resendUnsent = useCallback(() => {
    for (const command of unsent.current.values()) void sendCreate(command);
  }, [sendCreate]);

  const refresh = useCallback(() => {
    resendUnsent();
    void binding.current?.sync.refresh();
  }, [resendUnsent]);

  // A different project (or notes turning off) starts over: nothing pending carries across.
  const [boundKey, setBoundKey] = useState(requested ? key : null);
  const nextBoundKey = requested ? key : null;
  if (boundKey !== nextBoundKey) {
    setBoundKey(nextBoundKey);
    setPending(NO_PENDING);
    setCommandError(null);
    setUnconfirmed(NO_IDS);
  }

  useEffect(() => {
    if (!requested || !environmentId || !projectId) return;
    const epochs = epochRef;
    const epoch = ++epochs.current;
    unsent.current.clear();
    inFlight.current.clear();
    let client: unknown = undefined;
    let stopReadiness: (() => void) | null = null;
    const unbind = () => {
      binding.current?.sync.release();
      binding.current = null;
    };
    const bind = () => {
      const connection = readEnvironmentConnection(environmentId);
      const next = connection?.client ?? null;
      if (next === client && binding.current) return;
      client = next;
      stopReadiness?.();
      // A socket that reconnects on the same client delivers a fresh snapshot: resend then too.
      stopReadiness =
        connection?.shellSnapshotReadiness.subscribe(() => {
          if (connection.shellSnapshotReadiness.read() !== null) resendUnsent();
        }) ?? null;
      const api = readEnvironmentApiForConnection(environmentId, next)?.notes;
      if (api && binding.current?.api === api) return;
      unbind();
      if (!api) {
        setBound(false);
        return;
      }
      binding.current = {
        api,
        sync: retainProjectNotes(api, environmentId, projectId, refreshOnWindowFocus),
        epoch,
      };
      setBound(true);
      // A reconnect may have lost a reply; the node keeps the first copy.
      resendUnsent();
    };
    const unsubscribe = subscribeEnvironmentConnections(bind);
    bind();
    // The shared sync re-reads on focus; each surface only resends its own creates.
    window.addEventListener("focus", resendUnsent);
    return () => {
      ++epochs.current;
      unsubscribe();
      stopReadiness?.();
      window.removeEventListener("focus", resendUnsent);
      unbind();
      setBound(false);
    };
  }, [requested, environmentId, projectId, resendUnsent]);

  // Lost replies are resent on a short backoff while bound (focus, reopening and reconnects too).
  const retryAttempt = useRef(0);
  const hasUnconfirmed = unconfirmed.size > 0;
  useEffect(() => {
    if (!hasUnconfirmed) {
      retryAttempt.current = 0;
      return;
    }
    if (!bound) return;
    const delay = CREATE_RETRY_DELAYS_MS[retryAttempt.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      retryAttempt.current += 1;
      resendUnsent();
    }, delay);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each lost reply steps the backoff
  }, [bound, hasUnconfirmed, lostReplies, resendUnsent]);

  const notesState = useNotesStore((state) =>
    key ? selectProjectNotesState(state, key) : undefined,
  );
  const markOwn = useNotesStore((state) => state.markOwn);
  const worktreeById = useStore((state) =>
    environmentId ? selectEnvironmentState(state, environmentId).worktreeById : undefined,
  );
  const projectName =
    useStore((state) =>
      environmentId && projectId
        ? selectEnvironmentState(state, environmentId).projectById[projectId]?.name
        : undefined,
    ) ?? "Project";

  const available = requested && bound;
  const snapshot = available ? (notesState?.snapshot ?? null) : null;
  // Saves made before the first answer still show, as pending.
  const listed = useMemo(
    () => (available ? applyPendingNoteChanges(snapshot, pending) : []),
    [available, snapshot, pending],
  );
  const listedById = useMemo(() => new Map(listed.map((note) => [note.noteId, note])), [listed]);

  // Only the titles the notes link to: the shell map changes with every streamed message.
  const linkedThreadIds = useMemo(() => {
    const ids = new Set<string>();
    if (threadId) ids.add(threadId);
    for (const note of listed) if (note.threadId) ids.add(note.threadId);
    return [...ids];
  }, [listed, threadId]);
  const threadTitles = useStore(
    useShallow((state) => {
      const titles: Record<string, string | null> = {};
      if (!environmentId) return titles;
      const shells = selectEnvironmentState(state, environmentId).threadShellById;
      for (const id of linkedThreadIds) titles[id] = shells?.[id as ThreadId]?.title ?? null;
      return titles;
    }),
  );

  const mainLabel = useMemo(() => {
    if (!worktreeById || !projectId) return null;
    for (const summary of Object.values(worktreeById))
      if (summary.projectId === projectId && summary.origin === "main")
        return worktreeLabel(summary);
    return null;
  }, [worktreeById, projectId]);
  const labelOf = useCallback(
    (worktreeId: WorktreeId | null) =>
      worktreeId === null
        ? (mainLabel ?? "main")
        : (worktreeLabel(worktreeById?.[worktreeId]) ?? "Removed worktree"),
    [mainLabel, worktreeById],
  );

  const toView = useCallback(
    (note: ListedNote): NoteView => ({
      id: note.noteId,
      body: note.body,
      scope: note.scope,
      worktreeLabel:
        note.scope === "project" || (checkout !== null && note.worktreeId === worktreeKey)
          ? null
          : labelOf(note.worktreeId),
      thread: note.threadId
        ? { id: note.threadId, title: threadTitles[note.threadId] ?? null }
        : null,
      createdAt: note.createdAt,
      ...(note.pending ? { pending: true } : {}),
    }),
    [checkout, worktreeKey, labelOf, threadTitles],
  );

  const selectWorktreeView = useCallback(
    <T extends WorktreeNote>(notes: ReadonlyArray<T>) =>
      checkout ? selectWorktreeNotes({ notes }, worktreeKey) : selectPinnedNotes({ notes }),
    [checkout, worktreeKey],
  );
  const worktreeNotes = useMemo(
    () => selectWorktreeView(listed).map(toView),
    [listed, selectWorktreeView, toView],
  );
  const projectNotes = useMemo(
    () => selectProjectNotes({ notes: listed }).map(toView),
    [listed, toView],
  );
  const pendingCreates = useMemo(() => {
    const creates = new Map<string, PendingNoteChange>();
    for (const [noteId, change] of pending)
      if (change.kind === "create") creates.set(noteId, change);
    return creates.size === pending.size ? pending : creates;
  }, [pending]);
  const alertNotes = useMemo(
    () =>
      available
        ? selectWorktreeView(applyPendingNoteChanges(snapshot, pendingCreates)).map((note) => ({
            id: note.noteId,
            body: note.body,
          }))
        : [],
    [available, snapshot, pendingCreates, selectWorktreeView],
  );

  const disabledReason = !available
    ? NOTES_UNREACHABLE_REASON
    : capability.allowed
      ? null
      : (capability.reason ?? NOTES_READ_ONLY_REASON);
  const composerDisabledReason = disabledReason ?? (checkout ? null : NOTES_DRAFT_REASON);
  const canWrite = composerDisabledReason === null;

  const save = useEvent(async (body: string, scope: NoteViewScope): Promise<NoteSaveOutcome> => {
    const text = body.trim();
    if (!canWrite || !key || !projectId || !text) return "refused";
    if (text.length > NOTE_BODY_MAX_LENGTH) {
      setCommandError({ message: NOTES_TOO_LONG });
      return "refused";
    }
    const noteId = crypto.randomUUID();
    const command = {
      kind: "create",
      noteId,
      projectId,
      worktreeId: worktreeKey,
      scope,
      body: text,
      threadId,
    } as const;
    const at = new Date().toISOString();
    const note: WorktreeNote = {
      noteId,
      revision: 0,
      projectId,
      worktreeId: worktreeKey,
      scope,
      body: text,
      threadId,
      createdAt: at,
      updatedAt: at,
    };
    markOwn(key, noteId);
    setCommandError(null);
    setPending((map) => withChange(map, noteId, { kind: "create", note }));
    return sendCreate(command);
  });

  /** Edits and deletes are judged against the revision this client last saw. */
  const change = async (
    noteId: string,
    edit: { readonly body?: string; readonly scope?: NoteScope } | "delete",
  ) => {
    const current = binding.current;
    const note = listedById.get(noteId);
    if (disabledReason !== null || !current || !projectId || !note || note.pending) return;
    if (inFlight.current.has(noteId)) return;
    inFlight.current.add(noteId);
    // Pinning shows a note from another worktree here: this client's own
    // change must not announce it as saved elsewhere.
    if (key && edit !== "delete" && edit.scope === "project") markOwn(key, noteId);
    setCommandError(null);
    setPending((map) =>
      withChange(map, noteId, edit === "delete" ? { kind: "delete" } : { kind: "update", ...edit }),
    );
    try {
      const snapshot = await current.api.command(
        edit === "delete"
          ? { kind: "delete", noteId, projectId, expectedRevision: note.revision }
          : { kind: "update", noteId, projectId, expectedRevision: note.revision, ...edit },
      );
      if (current.epoch === epochRef.current) current.sync.applySnapshot(snapshot);
    } catch (cause) {
      if (current.epoch !== epochRef.current) return;
      // A conflict means the note moved on elsewhere: show the latest, quietly.
      if (isConflict(cause)) void current.sync.refresh();
      else reportError(current, errorMessage(cause));
    } finally {
      inFlight.current.delete(noteId);
      if (current.epoch === epochRef.current) setPending((map) => withChange(map, noteId, null));
    }
  };

  const toggleTodo = useEvent((noteId: string) => {
    const note = listedById.get(noteId);
    if (note) void change(noteId, { body: toggleNoteTodo(note.body) });
  });
  const togglePin = useEvent((noteId: string) => {
    const note = listedById.get(noteId);
    if (note) void change(noteId, { scope: note.scope === "project" ? "worktree" : "project" });
  });
  const remove = useEvent((noteId: string) => void change(noteId, "delete"));
  const worktreeViewDisabledReason = checkout ? null : NOTES_DRAFT_REASON;
  // A draft has no worktree to list: the Worktree tab is off, not a hidden choice.
  const setView = useEvent((next: NotesPaneView) => {
    if (next === "worktree" && worktreeViewDisabledReason !== null) return;
    setStoredView(next);
  });
  const notesFor = useCallback(
    (forView: NotesPaneView) => (forView === "project" ? projectNotes : worktreeNotes),
    [projectNotes, worktreeNotes],
  );
  const onOpenThread = options.onOpenThread;
  const openThreadEvent = useEvent((id: string) => onOpenThread?.(id as ThreadId));
  const openThread = onOpenThread ? openThreadEvent : null;

  const checkoutLabel = !checkout
    ? null
    : ((checkout.worktreeId
        ? worktreeLabel(worktreeById?.[checkout.worktreeId as WorktreeId])
        : null) ?? (worktreeKey === null ? mainLabel : null));
  const breadcrumb = useMemo(
    () => ({ project: projectName, worktree: checkoutLabel }),
    [projectName, checkoutLabel],
  );
  const counts = useMemo(
    () => ({ worktree: worktreeNotes.length, project: projectNotes.length }),
    [worktreeNotes.length, projectNotes.length],
  );
  const effectiveView: NotesPaneView = checkout ? view : "project";
  const shownCommandError =
    commandError !== null &&
    (commandError.seen === undefined || commandError.seen === notesState?.snapshot)
      ? commandError.message
      : null;
  const error = available
    ? (shownCommandError ??
      (hasUnconfirmed ? NOTES_CREATE_UNCONFIRMED : null) ??
      notesState?.error ??
      null)
    : null;
  const status = available ? (notesState?.status ?? "idle") : "idle";
  const truncatedLimit = snapshot?.truncated ? snapshot.limit : null;
  const threadTitle = threadId ? (threadTitles[threadId] ?? null) : null;
  const ownNoteIds = notesState?.ownNoteIds ?? EMPTY_OWN_IDS;
  return useMemo(
    () => ({
      available,
      status,
      loaded: snapshot !== null,
      error,
      worktreeNotes,
      projectNotes,
      alertNotes,
      truncatedLimit,
      counts,
      view: effectiveView,
      setView,
      worktreeViewDisabledReason,
      notesFor,
      breadcrumb,
      threadTitle,
      disabledReason,
      composerDisabledReason,
      ownNoteIds,
      save,
      toggleTodo,
      togglePin,
      remove,
      refresh,
      openThread,
    }),
    [
      available,
      status,
      snapshot,
      error,
      worktreeNotes,
      projectNotes,
      alertNotes,
      truncatedLimit,
      counts,
      effectiveView,
      setView,
      worktreeViewDisabledReason,
      notesFor,
      breadcrumb,
      threadTitle,
      disabledReason,
      composerDisabledReason,
      ownNoteIds,
      save,
      toggleTodo,
      togglePin,
      remove,
      refresh,
      openThread,
    ],
  );
}
