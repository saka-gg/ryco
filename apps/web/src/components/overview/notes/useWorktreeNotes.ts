import {
  NOTE_BODY_MAX_LENGTH,
  NotesCommand,
  WS_METHODS,
  type EnvironmentId,
  type NoteScope,
  type NotesApi,
  type ProjectId,
  type WorktreeId,
} from "@ryco/contracts";
import {
  noteWorktreeKey,
  notesDocumentKey,
  projectNotesKey,
  retainProjectNotes,
  selectNotesDocument,
  selectProjectNotesState,
  useNotesStore,
  type NotesCheckout,
  type NotesRefreshTriggers,
  type ProjectNotesStatus,
  type ProjectNotesSync,
} from "@ryco/client-runtime/state/notes";
import { Schema } from "effect";
import { isTagged } from "effect/Predicate";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApiForConnection } from "../../../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../../environments/runtime";
import { useEvent } from "../../../hooks/useEvent";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { selectEnvironmentState, useStore } from "../../../store";
import type { SidebarWorktreeSummary } from "../../../types";
import type { NotesPaneView, NotesSaveState } from "./noteView";

/** What a thread's notes are written against. */
export interface WorktreeNotesTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The thread's checkout; null while a draft has none yet (only the Project view). */
  readonly checkout: NotesCheckout | null;
  /** The node advertises `capabilities.worktreeNotes`. */
  readonly available: boolean;
}

/** One document as the crown's alerts diff it: the node's confirmed revision. */
export interface NotesAlertDocument {
  readonly key: string;
  readonly view: NotesPaneView;
  readonly revision: number;
  /** This client saved that revision. */
  readonly own: boolean;
}

export interface WorktreeNotes {
  /** The node has notes and this client can reach them: the rail shows the Notes icon. */
  readonly available: boolean;
  readonly status: ProjectNotesStatus;
  /** The node's notes have answered at least once, so the documents are real (alert baselines wait for it). */
  readonly loaded: boolean;
  /** The last failed read or save, or null. */
  readonly error: string | null;
  /** The pane's scope switch, shared by the card and its flyout. */
  readonly view: NotesPaneView;
  readonly setView: (view: NotesPaneView) => void;
  /** Why the Worktree view is off (a draft without a checkout), or null. */
  readonly worktreeViewDisabledReason: string | null;
  readonly breadcrumb: { readonly project: string; readonly worktree: string | null };
  /** The text a view shows: this client's unsaved edit, else the node's document. */
  readonly bodyFor: (view: NotesPaneView) => string;
  readonly saveStateFor: (view: NotesPaneView) => NotesSaveState;
  /** Why editing a view is off (no reachable notes, hosted role, no checkout), or null. */
  readonly editDisabledReasonFor: (view: NotesPaneView) => string | null;
  /** Either document this thread shows has text (the rail badge). */
  readonly filled: boolean;
  /** The confirmed documents this thread shows, for "edited elsewhere" alerts. */
  readonly alertDocuments: ReadonlyArray<NotesAlertDocument>;
  /** Replaces a view's text; it saves on its own shortly after typing stops. */
  readonly edit: (view: NotesPaneView, body: string) => void;
  /** Saves a view's pending text now (blur, the save shortcut). */
  readonly flush: (view: NotesPaneView) => void;
  readonly refresh: () => void;
}

export const NOTES_DRAFT_REASON = "Send the first message to start worktree notes";
const NOTES_UNREACHABLE_REASON = "Connect to a server with notes available.";
const NOTES_READ_ONLY_REASON = "Notes are read-only here.";
export const NOTES_UNCONFIRMED = "Couldn't confirm your notes were saved. Retrying…";
export const NOTES_TOO_LONG = `Notes are too long (${NOTE_BODY_MAX_LENGTH.toLocaleString("en-US")} characters max).`;
export const NOTES_CONFLICT = "Notes kept changing elsewhere. Your text is kept; edit to retry.";
/** Typing pauses this long before the text is saved. */
export const NOTES_SAVE_DEBOUNCE_MS = 700;
/** Backoff for resending a save whose reply was lost, while the notes stay bound. */
const LOST_REPLY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
/** Conflicts in a row before a save gives up until the next edit. */
const MAX_CONFLICT_RETRIES = 3;

const isNotesCommand = Schema.is(NotesCommand);

/** The window regaining focus re-reads a project once, however many panes show it. */
const refreshOnWindowFocus: NotesRefreshTriggers = (refresh) => {
  window.addEventListener("focus", refresh);
  return () => window.removeEventListener("focus", refresh);
};

/** The node judged the save; any other failure may not have reached it. */
const isServerAnswer = (cause: unknown) =>
  isTagged(cause, "NotesError") || isTagged(cause, "AuthRpcError");

const isConflict = (cause: unknown) =>
  isTagged(cause, "NotesError") && (cause as { reason?: unknown }).reason === "conflict";

/** The node's own words for its answers; transport text never reaches the banner. */
function errorMessage(cause: unknown): string {
  const message = isServerAnswer(cause) ? (cause as { message?: unknown }).message : undefined;
  return typeof message === "string" && message ? message : NOTES_UNCONFIRMED;
}

function worktreeLabel(summary: SidebarWorktreeSummary | undefined): string | null {
  if (!summary) return null;
  return summary.title?.trim() || summary.branch || null;
}

/** Text typed here that the node has not confirmed yet. */
interface Draft {
  /** The project it belongs to (`projectNotesKey`): another project's drafts are never shown. */
  readonly projectKey: string;
  readonly projectId: ProjectId;
  readonly scope: NoteScope;
  readonly worktreeId: WorktreeId | null;
  readonly body: string;
  /** The node's revision the text was edited from. */
  readonly baseRevision: number;
}

type Drafts = ReadonlyMap<string, Draft>;
const NO_DRAFTS: Drafts = new Map();
const NO_KEYS: ReadonlySet<string> = new Set();

function withKey(keys: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> {
  if (keys.has(key) === present) return keys;
  const next = new Set(keys);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

/**
 * One thread's notes documents, kept fresh from the node: the project's
 * documents are read when the section is bound, when the connection changes,
 * when the window regains focus, on {@link WorktreeNotes.refresh} (the Notes
 * section opening) and from every save's reply. Typing shows at once as a
 * local edit that saves itself shortly after typing stops, against the
 * revision it was edited from. A save that meets a newer revision re-reads
 * and resends the text typed here (the person typing wins); one whose reply
 * was lost is resent with a short backoff, on reconnect and on focus.
 */
export function useWorktreeNotes(target: WorktreeNotesTarget | null): WorktreeNotes {
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  const requested = target?.available === true && environmentId !== null && projectId !== null;
  const checkout = target?.checkout ?? null;
  const worktreeKey = checkout ? noteWorktreeKey(checkout) : null;
  const capability = useHostedRpcCapability(WS_METHODS.notesCommand);
  const key = environmentId && projectId ? projectNotesKey(environmentId, projectId) : null;

  const [bound, setBound] = useState(false);
  const [view, setStoredView] = useState<NotesPaneView>("worktree");
  const [drafts, setDraftsState] = useState(NO_DRAFTS);
  const draftsRef = useRef(drafts);
  const [saving, setSaving] = useState(NO_KEYS);
  /** Saves whose reply was lost; resent on a backoff. */
  const [lost, setLost] = useState(NO_KEYS);
  /** Bumped by every lost reply; steps the resend backoff. */
  const [lostReplies, setLostReplies] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const binding = useRef<{
    api: NotesApi;
    sync: ProjectNotesSync;
    epoch: number;
  } | null>(null);
  const epochRef = useRef(0);
  const inFlight = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const conflicts = useRef(new Map<string, number>());

  const setDrafts = useCallback((update: (current: Drafts) => Drafts) => {
    const next = update(draftsRef.current);
    if (next === draftsRef.current) return;
    draftsRef.current = next;
    setDraftsState(next);
  }, []);
  const putDraft = useCallback(
    (draftKey: string, draft: Draft | null) =>
      setDrafts((current) => {
        if (draft === null && !current.has(draftKey)) return current;
        const next = new Map(current);
        if (draft === null) next.delete(draftKey);
        else next.set(draftKey, draft);
        return next;
      }),
    [setDrafts],
  );

  /** The debounce timers reach the latest {@link flushDraft} through this ref. */
  const flushRef = useRef<(draftKey: string) => Promise<void>>(async () => {});
  const scheduleFlush = useEvent((draftKey: string) => {
    const pendingTimer = timers.current.get(draftKey);
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    timers.current.set(
      draftKey,
      setTimeout(() => void flushRef.current(draftKey), NOTES_SAVE_DEBOUNCE_MS),
    );
  });

  // An event, not a callback: it always reads the latest binding.
  const flushDraft = useEvent(async (draftKey: string): Promise<void> => {
    const pendingTimer = timers.current.get(draftKey);
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    timers.current.delete(draftKey);
    const draft = draftsRef.current.get(draftKey);
    const current = binding.current;
    // Unbound or another project: kept until this project binds again.
    if (!draft || !current || current.sync.key !== draft.projectKey) return;
    // The reply in flight sends whatever was typed meanwhile.
    if (inFlight.current.has(draftKey)) return;
    const command: NotesCommand = {
      kind: "save",
      projectId: draft.projectId,
      scope: draft.scope,
      worktreeId: draft.worktreeId,
      body: draft.body,
      expectedRevision: draft.baseRevision,
    };
    // A body the contract refuses fails before the wire, every time: never "maybe landed".
    if (!isNotesCommand(command as unknown)) {
      setSaveError(NOTES_TOO_LONG);
      return;
    }
    const documentKey = notesDocumentKey(draft.scope, draft.worktreeId);
    /** Settles the draft against the node's document; true when text remains to save. */
    const settle = (revision: number, body: string) => {
      const latest = draftsRef.current.get(draftKey);
      if (!latest) return false;
      if (latest.body === body) {
        putDraft(draftKey, null);
        return false;
      }
      putDraft(draftKey, { ...latest, baseRevision: revision });
      return true;
    };
    inFlight.current.add(draftKey);
    setSaving((keys) => withKey(keys, draftKey, true));
    let resend: "now" | "later" | null = null;
    try {
      const snapshot = await current.api.command(command);
      if (current.epoch !== epochRef.current) return;
      const saved = selectNotesDocument(snapshot, draft.scope, draft.worktreeId);
      const revision = saved?.revision ?? 0;
      // Marked before it lands, so the reply never reads as an edit from elsewhere.
      if (saved) useNotesStore.getState().markOwn(draft.projectKey, documentKey, revision);
      current.sync.applySnapshot(snapshot);
      conflicts.current.delete(draftKey);
      setLost((keys) => withKey(keys, draftKey, false));
      setSaveError(null);
      if (settle(revision, command.body)) resend = "later";
    } catch (cause) {
      if (current.epoch !== epochRef.current) return;
      if (isConflict(cause)) {
        // Edited elsewhere (or a lost reply that landed): compare with the latest.
        const fresh = await current.api.list({ projectId: draft.projectId }).catch(() => null);
        if (current.epoch !== epochRef.current) return;
        if (!fresh) {
          setLost((keys) => withKey(keys, draftKey, true));
          setLostReplies((count) => count + 1);
          return;
        }
        const remote = selectNotesDocument(fresh, draft.scope, draft.worktreeId);
        const revision = remote?.revision ?? 0;
        if (remote && remote.body === draftsRef.current.get(draftKey)?.body)
          useNotesStore.getState().markOwn(draft.projectKey, documentKey, revision);
        current.sync.applySnapshot(fresh);
        setLost((keys) => withKey(keys, draftKey, false));
        if (!settle(revision, remote?.body ?? "")) {
          conflicts.current.delete(draftKey);
          return;
        }
        const attempts = (conflicts.current.get(draftKey) ?? 0) + 1;
        conflicts.current.set(draftKey, attempts);
        if (attempts <= MAX_CONFLICT_RETRIES) resend = "now";
        else setSaveError(NOTES_CONFLICT);
      } else if (isServerAnswer(cause)) {
        // Refused: the text stays here, and the next edit tries again.
        setSaveError(errorMessage(cause));
      } else {
        // It may have landed: keep the text and resend it later.
        setLost((keys) => withKey(keys, draftKey, true));
        setLostReplies((count) => count + 1);
      }
    } finally {
      inFlight.current.delete(draftKey);
      if (current.epoch === epochRef.current) setSaving((keys) => withKey(keys, draftKey, false));
    }
    if (resend === "now") void flushRef.current(draftKey);
    else if (resend === "later") scheduleFlush(draftKey);
  });

  useLayoutEffect(() => {
    flushRef.current = flushDraft;
  });

  const flushAll = useEvent(() => {
    for (const draftKey of draftsRef.current.keys()) void flushDraft(draftKey);
  });

  const refresh = useEvent(() => {
    flushAll();
    void binding.current?.sync.refresh();
  });

  useEffect(() => {
    if (!requested || !environmentId || !projectId) return;
    const epochs = epochRef;
    const epoch = ++epochs.current;
    const flying = inFlight.current;
    flying.clear();
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
          if (connection.shellSnapshotReadiness.read() !== null) flushAll();
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
      // Text typed while unbound, or a reply lost to the reconnect.
      flushAll();
    };
    const unsubscribe = subscribeEnvironmentConnections(bind);
    bind();
    // The shared sync re-reads on focus; each surface only resends its own text.
    window.addEventListener("focus", flushAll);
    const draftTimers = timers.current;
    const failedSaves = conflicts.current;
    return () => {
      // Leaving the project: unsaved text goes out once, unconfirmed (the next read shows it).
      const leaving = binding.current;
      for (const [draftKey, draft] of draftsRef.current) {
        const timer = draftTimers.get(draftKey);
        if (timer !== undefined) clearTimeout(timer);
        draftTimers.delete(draftKey);
        if (leaving && draft.projectKey === leaving.sync.key && !flying.has(draftKey))
          void leaving.api
            .command({
              kind: "save",
              projectId: draft.projectId,
              scope: draft.scope,
              worktreeId: draft.worktreeId,
              body: draft.body,
              expectedRevision: draft.baseRevision,
            })
            .catch(() => undefined);
      }
      failedSaves.clear();
      setDrafts(() => NO_DRAFTS);
      ++epochs.current;
      unsubscribe();
      stopReadiness?.();
      window.removeEventListener("focus", flushAll);
      unbind();
      setBound(false);
    };
  }, [requested, environmentId, projectId, flushAll, setDrafts]);

  // A different project (or notes turning off) starts over: no failure carries across.
  const [boundKey, setBoundKey] = useState(requested ? key : null);
  const nextBoundKey = requested ? key : null;
  if (boundKey !== nextBoundKey) {
    setBoundKey(nextBoundKey);
    setSaving(NO_KEYS);
    setLost(NO_KEYS);
    setSaveError(null);
  }

  // Lost replies are resent on a short backoff while bound (focus, reopening and reconnects too).
  const retryAttempt = useRef(0);
  const hasLost = lost.size > 0;
  useEffect(() => {
    if (!hasLost) {
      retryAttempt.current = 0;
      return;
    }
    if (!bound) return;
    const delay = LOST_REPLY_RETRY_DELAYS_MS[retryAttempt.current];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      retryAttempt.current += 1;
      flushAll();
    }, delay);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each lost reply steps the backoff
  }, [bound, hasLost, lostReplies, flushAll]);

  // Pending timers never outlive the hook.
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  const notesState = useNotesStore((state) =>
    key ? selectProjectNotesState(state, key) : undefined,
  );
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

  const disabledReason = !available
    ? NOTES_UNREACHABLE_REASON
    : capability.allowed
      ? null
      : (capability.reason ?? NOTES_READ_ONLY_REASON);
  const worktreeViewDisabledReason = checkout ? null : NOTES_DRAFT_REASON;

  /** A view's document address, or null while it has none (a draft's Worktree view). */
  const addressOf = useCallback(
    (forView: NotesPaneView) => {
      if (!key || !projectId) return null;
      if (forView === "project")
        return { scope: "project" as const, worktreeId: null, draftKey: `${key}|project` };
      if (!checkout) return null;
      return {
        scope: "worktree" as const,
        worktreeId: worktreeKey,
        draftKey: `${key}|${notesDocumentKey("worktree", worktreeKey)}`,
      };
    },
    [key, projectId, checkout, worktreeKey],
  );

  const documentFor = useCallback(
    (forView: NotesPaneView) => {
      const address = addressOf(forView);
      return address ? selectNotesDocument(snapshot, address.scope, address.worktreeId) : null;
    },
    [addressOf, snapshot],
  );

  const bodyFor = useCallback(
    (forView: NotesPaneView) => {
      const address = addressOf(forView);
      if (!address || !available) return "";
      return drafts.get(address.draftKey)?.body ?? documentFor(forView)?.body ?? "";
    },
    [addressOf, available, drafts, documentFor],
  );

  const saveStateFor = useCallback(
    (forView: NotesPaneView): NotesSaveState => {
      const address = addressOf(forView);
      if (!address) return "saved";
      if (saving.has(address.draftKey)) return "saving";
      return drafts.has(address.draftKey) ? "unsaved" : "saved";
    },
    [addressOf, saving, drafts],
  );

  const editDisabledReasonFor = useCallback(
    (forView: NotesPaneView) =>
      disabledReason ?? (forView === "worktree" ? worktreeViewDisabledReason : null),
    [disabledReason, worktreeViewDisabledReason],
  );

  const edit = useEvent((forView: NotesPaneView, body: string) => {
    const address = addressOf(forView);
    if (!address || !key || !projectId || editDisabledReasonFor(forView) !== null) return;
    const existing = draftsRef.current.get(address.draftKey);
    const document = documentFor(forView);
    conflicts.current.delete(address.draftKey);
    if (!existing && body === (document?.body ?? "")) return;
    putDraft(address.draftKey, {
      projectKey: key,
      projectId,
      scope: address.scope,
      worktreeId: address.worktreeId,
      body,
      baseRevision: existing?.baseRevision ?? document?.revision ?? 0,
    });
    scheduleFlush(address.draftKey);
  });

  const flush = useEvent((forView: NotesPaneView) => {
    const address = addressOf(forView);
    if (address && draftsRef.current.has(address.draftKey)) void flushDraft(address.draftKey);
  });

  // A draft has no worktree to edit: the Worktree tab is off, not a hidden choice.
  const setView = useEvent((next: NotesPaneView) => {
    if (next === "worktree" && worktreeViewDisabledReason !== null) return;
    setStoredView(next);
  });

  const mainLabel = useMemo(() => {
    if (!worktreeById || !projectId) return null;
    for (const summary of Object.values(worktreeById))
      if (summary.projectId === projectId && summary.origin === "main")
        return worktreeLabel(summary);
    return null;
  }, [worktreeById, projectId]);
  const checkoutLabel = !checkout
    ? null
    : ((checkout.worktreeId
        ? worktreeLabel(worktreeById?.[checkout.worktreeId as WorktreeId])
        : null) ?? (worktreeKey === null ? mainLabel : null));
  const breadcrumb = useMemo(
    () => ({ project: projectName, worktree: checkoutLabel }),
    [projectName, checkoutLabel],
  );

  const ownRevisions = notesState?.ownRevisions;
  const alertDocuments = useMemo(() => {
    if (!available || !snapshot) return [];
    const documents: NotesAlertDocument[] = [];
    for (const forView of ["worktree", "project"] as const) {
      const address = addressOf(forView);
      if (!address) continue;
      const document = selectNotesDocument(snapshot, address.scope, address.worktreeId);
      if (!document) continue;
      const documentKey = notesDocumentKey(address.scope, address.worktreeId);
      documents.push({
        key: documentKey,
        view: forView,
        revision: document.revision,
        own: ownRevisions?.get(documentKey) === document.revision,
      });
    }
    return documents;
  }, [available, snapshot, addressOf, ownRevisions]);

  const worktreeBody = bodyFor("worktree");
  const projectBody = bodyFor("project");
  const filled = worktreeBody.trim() !== "" || projectBody.trim() !== "";
  const effectiveView: NotesPaneView = checkout ? view : "project";
  const error = available
    ? (saveError ?? (hasLost ? NOTES_UNCONFIRMED : null) ?? notesState?.error ?? null)
    : null;
  const status = available ? (notesState?.status ?? "idle") : "idle";
  return useMemo(
    () => ({
      available,
      status,
      loaded: snapshot !== null,
      error,
      view: effectiveView,
      setView,
      worktreeViewDisabledReason,
      breadcrumb,
      bodyFor,
      saveStateFor,
      editDisabledReasonFor,
      filled,
      alertDocuments,
      edit,
      flush,
      refresh,
    }),
    [
      available,
      status,
      snapshot,
      error,
      effectiveView,
      setView,
      worktreeViewDisabledReason,
      breadcrumb,
      bodyFor,
      saveStateFor,
      editDisabledReasonFor,
      filled,
      alertDocuments,
      edit,
      flush,
      refresh,
    ],
  );
}
