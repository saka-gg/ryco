/**
 * The Automations dialog (the lab's direction C): no page of its own, one
 * dialog that grows out of whatever opened it, scoped to one project with a
 * switcher in its single header bar. List and detail side by side; "Edit" and
 * "New schedule" turn the detail into the editor in place.
 *
 * Mounted once; `automationsDialogStore` opens, re-targets and closes it.
 * Data: `useProjectAutomations` (each device's checkout, live) and
 * `useLapsedScheduleProposals` (each device's Agent Control queue, for
 * proposals that expired undecided), folded into rows by the shared model.
 */
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { definitionWithEnabled, scheduleRetryState } from "@ryco/client-runtime/state/agentControl";
import type { AgentControlProposalId, AutomationCentreRun } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { useEvent } from "../../../hooks/useEvent";
import { useLogicalProjectSnapshots } from "../../../hooks/useLogicalProjectSnapshots";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { formatProjectPath, inferHomeDirectory } from "../../projects/projectsModel.logic";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { toastManager } from "../../ui/toast";
import {
  closeAutomationsDialog,
  rememberAutomationsDialogProject,
  useAutomationsDialogStore,
  type AutomationsDialogRequest,
} from "../automationsDialogStore";
import {
  automationsDialogDevice,
  resolveAutomationsDialogProject,
} from "../data/automationsDialogProject.logic";
import {
  dismissLapsedScheduleProposal,
  useLapsedScheduleProposals,
} from "../data/useLapsedScheduleProposals";
import {
  useProjectAutomations,
  type ProjectAutomationsCheckout,
} from "../data/useProjectAutomations";
import { AutomationsDialogHeader } from "./AutomationsDialogHeader";
import { EMPTY_NEW_SELECTOR, EmptyProjectState, UnavailableState, UndoBar } from "./DialogPanes";
import { ScheduleDetail } from "./ScheduleDetail";
import { DIALOG_ROW_ATTRIBUTE, ScheduleList } from "./ScheduleList";
import { useMinuteNow } from "./clock";
import type { ScheduleDialogActions } from "./dialogControls";
import {
  deriveDialogRows,
  dialogLimit,
  dialogListSections,
  dialogQueueLine,
  dialogRowKey,
  flattenDialogRows,
  liveProjectCounts,
  newScheduleCheckout,
  resolveDialogRequest,
  resolveDialogSelection,
  type ApprovalKind,
  type DialogRow,
} from "./dialogModel.logic";
import type {
  ScheduleEditorConfirm,
  ScheduleEditorDraftState,
  ScheduleEditorSavedResult,
  ScheduleEditorSlotProps,
  ScheduleEditorSource,
} from "./editorContract";
import { ScheduleEditor } from "./editor/ScheduleEditor";
import { animatePaneIn, landOnRow, retirePane, type PaneTransition } from "./paneMotion";
import { useApprovalNotices } from "./useApprovalNotices";

type CloseRequest = "escape" | "close" | "outside";

/** Keys that move through the list and the run history. */
const MOVE_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** What the host asks of the open dialog's body when Base UI wants to close it. */
interface DialogController {
  /** True: close the dialog. False: the body handled it (an editor is open). */
  readonly requestClose: (reason: CloseRequest) => boolean;
}

/** A row's element in the dialog. */
function findRow(root: HTMLElement | null, key: string | null): HTMLElement | null {
  if (!root || !key) return null;
  // Compared, not selected: keys hold a control character.
  return (
    Array.from(root.querySelectorAll<HTMLElement>(`[${DIALOG_ROW_ATTRIBUTE}]`)).find(
      (row) => row.getAttribute(DIALOG_ROW_ATTRIBUTE) === key,
    ) ?? null
  );
}

/** The element focus lands on as the dialog opens or after what held focus went away. */
function defaultFocusTarget(root: HTMLElement): HTMLElement {
  const selected = root.querySelector<HTMLElement>(
    `[${DIALOG_ROW_ATTRIBUTE}][aria-selected="true"]`,
  );
  if (selected) return selected;
  const emptyNew = root.querySelector<HTMLElement>(EMPTY_NEW_SELECTOR);
  if (emptyNew) return emptyNew;
  const newButton = root.querySelector<HTMLElement>('.ad-head [data-act="new"]');
  if (newButton?.offsetParent && !newButton.hasAttribute("disabled")) return newButton;
  return root;
}

export interface AutomationsDialogProps {
  /** The editor rendered while editing (tests swap in a stand-in). */
  readonly editorComponent?: ComponentType<ScheduleEditorSlotProps>;
}

/** The app's one Automations dialog. Mount once; open it with `openAutomationsDialog`. */
export function AutomationsDialog(props: AutomationsDialogProps) {
  const open = useAutomationsDialogStore((state) => state.open);
  const origin = useAutomationsDialogStore((state) => state.origin);
  const controllerRef = useRef<DialogController | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  /**
   * What had focus as the dialog opened, read as the store opens it — before
   * anything inside (an editor opened by the request) can take focus, which
   * would leave the popup nothing to give focus back to.
   */
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(
    () =>
      useAutomationsDialogStore.subscribe((state, previous) => {
        if (!state.open || previous.open) return;
        const active = document.activeElement;
        openerRef.current =
          active instanceof HTMLElement && active !== document.body ? active : null;
      }),
    [],
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        const reason: CloseRequest =
          details.reason === "escape-key"
            ? "escape"
            : details.reason === "outside-press"
              ? "outside"
              : "close";
        if (controllerRef.current && !controllerRef.current.requestClose(reason)) return;
        closeAutomationsDialog();
      }}
    >
      <DialogPopup
        ref={popupRef}
        className="ad-dialog"
        showCloseButton={false}
        bottomStickOnMobile={false}
        morph={origin ? { origin: () => origin } : "auto"}
        initialFocus={() => {
          const root = popupRef.current?.querySelector<HTMLElement>(".ad-root");
          return root ? defaultFocusTarget(root) : true;
        }}
        finalFocus={() => {
          // Focus goes back to what opened the dialog, wherever focus was inside it.
          const target = [origin, openerRef.current].find((element) => element?.isConnected);
          return target ?? true;
        }}
      >
        <AutomationsDialogContent
          open={open}
          controllerRef={controllerRef}
          editorComponent={props.editorComponent ?? ScheduleEditor}
        />
      </DialogPopup>
    </Dialog>
  );
}

interface ContentProps {
  readonly open: boolean;
  readonly controllerRef: RefObject<DialogController | null>;
  readonly editorComponent: ComponentType<ScheduleEditorSlotProps>;
}

function AutomationsDialogContent(props: ContentProps) {
  const { snapshots } = useLogicalProjectSnapshots();
  if (snapshots.length === 0) return <NoProjects />;
  return <AutomationsDialogBody {...props} snapshots={snapshots} />;
}

function NoProjects() {
  return (
    <div className="ad-root" tabIndex={-1}>
      <header className="ad-head">
        <DialogTitle className="ad-title">Automations</DialogTitle>
      </header>
      <div className="ad-body" data-empty="">
        <div className="ad-detail">
          <div className="ad-pane">
            <div className="ad-empty">
              <h3>No projects yet</h3>
              <p>Add a project, then schedule work in it.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** An open editor. */
interface EditorSession {
  /** Keys the editor pane: a new session is a new editor. */
  readonly id: string;
  readonly source: ScheduleEditorSource;
  readonly origin: HTMLElement | null;
  readonly focus: "title" | "model";
  readonly fromDetail: boolean;
  /** The row being edited (dimmed list highlights it); null for a new schedule. */
  readonly rowKey: string | null;
  readonly projectKey: string;
}

function sessionIsNew(session: EditorSession): boolean {
  const source = session.source;
  if (source.kind === "new") return true;
  if (source.kind === "restore") return source.state.isNew;
  return !source.row.automation;
}

function sessionTitle(session: EditorSession): string {
  const source = session.source;
  if (source.kind === "new") return "";
  if (source.kind === "restore") return source.state.draft.title;
  return source.row.title;
}

/** A discarded draft, one click (or ⌘Z) away until the next edit starts. */
interface UndoEntry {
  readonly projectKey: string;
  readonly state: ScheduleEditorDraftState;
  readonly rowKey: string | null;
}

type CommandInput = Parameters<ProjectAutomationsCheckout["command"]>[0];

function AutomationsDialogBody(
  props: ContentProps & { readonly snapshots: readonly SidebarProjectSnapshot[] },
) {
  const { snapshots, controllerRef } = props;
  const Editor = props.editorComponent;
  const request = useAutomationsDialogStore((state) => state.request);
  const token = useAutomationsDialogStore((state) => state.token);
  const lastProject = useAutomationsDialogStore((state) => state.lastProject);
  const navigate = useNavigate();
  const nowMs = useMinuteNow();

  // ── which project ─────────────────────────────────────────────────
  const [projectKey, setProjectKey] = useState<string>(
    () =>
      (
        resolveAutomationsDialogProject({
          snapshots,
          target: request?.project ?? { kind: "last" },
          last: lastProject,
        }) ?? snapshots[0]!
      ).projectKey,
  );
  const snapshot =
    snapshots.find((candidate) => candidate.projectKey === projectKey) ?? snapshots[0]!;
  const automations = useProjectAutomations(snapshot);
  const { checkouts, loading } = automations;
  const queues = useLapsedScheduleProposals(checkouts);
  const groups = useMemo(
    () => deriveDialogRows(checkouts, queues, nowMs),
    [checkouts, queues, nowMs],
  );
  const rows = useMemo(() => flattenDialogRows(groups), [groups]);
  const sections = useMemo(() => dialogListSections(groups), [groups]);
  const checkoutsByKey = useMemo(
    () => new Map(checkouts.map((checkout) => [checkout.key, checkout])),
    [checkouts],
  );
  const scheduleRowsByCheckout = useMemo(
    () => new Map(groups.map((group) => [group.checkout.key, group.scheduleRows])),
    [groups],
  );
  const devices = useMemo(
    () =>
      new Map(
        checkouts.map((checkout) => [
          checkout.key,
          { label: checkout.deviceLabel, environmentId: checkout.environmentId },
        ]),
      ),
    [checkouts],
  );
  const limit = dialogLimit(checkouts);
  /** Why nothing can be proposed here (a hosted reader's role on every device), or null. */
  const lockedReason =
    checkouts.length > 0 && checkouts.every((checkout) => checkout.disabledReason)
      ? checkouts[0]!.disabledReason
      : null;
  /** No device's schedules could be read: why, or null. */
  const unreadableReason =
    !loading && checkouts.length > 0 && limit.readableCheckoutKeys.length === 0
      ? (checkouts.find((checkout) => checkout.error)?.error ??
        "Connect to a server with the automation centre available.")
      : null;
  /** Why "New schedule" is off besides the limit, or null. */
  const newOffReason = lockedReason ?? unreadableReason;
  useEffect(() => rememberAutomationsDialogProject(snapshot), [snapshot]);

  // ── state ─────────────────────────────────────────────────────────
  const [selection, setSelection] = useState<Readonly<Record<string, string>>>({});
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [confirm, setConfirm] = useState<ScheduleEditorConfirm>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const [historyOpen, setHistoryOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [promptOpen, setPromptOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [runFocus, setRunFocus] = useState<Readonly<Record<string, string>>>({});
  const [pending, setPending] = useState<AutomationsDialogRequest | null>(request);
  /**
   * A just-saved schedule's row, before the device's next read lists it (a
   * new schedule has no row until its proposal is read back): it keeps the
   * selection and the landing until it arrives.
   */
  const [awaitedRow, setAwaitedRow] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  /** How the next detail pane arrives (set by the action that changes it). */
  const transitionRef = useRef<PaneTransition>("none");
  /** Rows settle in once they arrive after a project switch. */
  const listSettleRef = useRef(false);
  const editorStateRef = useRef<ScheduleEditorDraftState | null>(null);
  const editorSeqRef = useRef(0);
  /** Where focus goes once the editor has folded back. */
  const focusAfterRef = useRef<{ rowKey: string | null; isNew: boolean } | null>(null);
  const landingRef = useRef<{ rowKey: string; fromRect: DOMRectReadOnly } | null>(null);
  const focusedOnceRef = useRef(false);

  // ── selection: the chosen row while it exists, else the first waiting, else the first ──
  // The fallback is kept once picked (the lab's `selectedId`), so the detail
  // and the target of E / Enter stay put when a run turns up or is decided —
  // except while a saved row is on its way (it is stored before it is listed).
  const stored = selection[snapshot.projectKey] ?? null;
  const selectedKey = resolveDialogSelection(rows, stored);
  if (awaitedRow !== null && rows.some((item) => item.key === awaitedRow)) setAwaitedRow(null);
  if (
    !loading &&
    selectedKey !== null &&
    selectedKey !== stored &&
    (awaitedRow === null || stored !== awaitedRow)
  )
    setSelection({ ...selection, [snapshot.projectKey]: selectedKey });
  const selectedItem = rows.find((item) => item.key === selectedKey) ?? null;

  // ── a request lands once its rows (or the limit) are known ──
  if (pending && !editor) {
    const outcome = resolveDialogRequest({
      request: {
        automationId: pending.automationId,
        mode: pending.mode,
        environmentId: pending.project.kind === "checkout" ? pending.project.environmentId : null,
      },
      rows,
      loading,
    });
    if (outcome.kind !== "wait") setPending(null);
    if (outcome.kind === "select") {
      setSelection({ ...selection, [snapshot.projectKey]: outcome.item.key });
      if (outcome.edit && !checkoutsByKey.get(outcome.item.checkoutKey)?.disabledReason)
        setEditor({
          id: `request-${token}`,
          source: { kind: "edit", checkoutKey: outcome.item.checkoutKey, row: outcome.item.row },
          origin: null,
          focus: "title",
          fromDetail: false,
          rowKey: outcome.item.key,
          projectKey: snapshot.projectKey,
        });
    } else if (outcome.kind === "new" && !lockedReason) {
      // A device's own "New schedule" opens on that device, even at the
      // limit (the editor says why Save is off); otherwise one with room.
      const device = automationsDialogDevice(snapshot, pending);
      const requested = checkouts.find((checkout) => checkout.environmentId === device)?.key;
      const checkoutKey = newScheduleCheckout(limit, requested ?? null);
      if (checkoutKey !== null)
        setEditor({
          id: `request-${token}`,
          source: { kind: "new", checkoutKey },
          origin: null,
          focus: "title",
          fromDetail: false,
          rowKey: null,
          projectKey: snapshot.projectKey,
        });
    }
  }

  // ── actions ───────────────────────────────────────────────────────
  const select = useEvent((key: string, how: PaneTransition, focus = true) => {
    if (editor) return;
    setAwaitedRow(null);
    if (key !== selectedKey) {
      transitionRef.current = how;
      setSelection((current) => ({ ...current, [snapshot.projectKey]: key }));
    }
    const element = findRow(rootRef.current, key);
    if (focus) element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  });

  const switchProject = useEvent((key: string) => {
    if (editor || key === snapshot.projectKey) return;
    setAwaitedRow(null);
    listSettleRef.current = true;
    transitionRef.current = "fade";
    setProjectKey(key);
  });

  const openEditor = useEvent(
    (
      source: ScheduleEditorSource,
      options: {
        readonly origin: HTMLElement | null;
        readonly focus?: "title" | "model";
        readonly rowKey: string | null;
        readonly fromDetail: boolean;
      },
    ) => {
      if (editor) return;
      if (source.kind === "new" && limit.allFull) return;
      setAwaitedRow(null);
      transitionRef.current = "to-editor";
      editorStateRef.current = null;
      editorSeqRef.current += 1;
      setUndo(null);
      setConfirm(null);
      setEditor({
        id: `user-${editorSeqRef.current}`,
        source,
        origin: options.origin,
        focus: options.focus ?? "title",
        fromDetail: options.fromDetail,
        rowKey: options.rowKey,
        projectKey: snapshot.projectKey,
      });
    },
  );

  const openNew = useEvent((origin: HTMLElement | null) => {
    if (limit.allFull || newOffReason) return;
    const checkoutKey = newScheduleCheckout(limit, null);
    // No device read yet (still loading): nothing to draft on.
    if (checkoutKey === null) return;
    openEditor({ kind: "new", checkoutKey }, { origin, rowKey: null, fromDetail: false });
  });

  const editRow = useEvent((item: DialogRow, focus: "title" | "model") => {
    if (item.row.state === "lapsed" || checkoutsByKey.get(item.checkoutKey)?.disabledReason) return;
    openEditor(
      { kind: "edit", checkoutKey: item.checkoutKey, row: item.row },
      { origin: null, focus, rowKey: item.key, fromDetail: item.key === selectedKey },
    );
  });

  /**
   * Back to the detail. A discarded dirty draft goes to the undo bar; a save
   * lands on its row (the plate folds into it and it takes focus).
   */
  const closeEditor = useEvent(
    (
      reason: "discard" | "unchanged" | "saved",
      landing?: { readonly rowKey: string; readonly fromRect: DOMRectReadOnly | null },
    ) => {
      const session = editor;
      if (!session) return;
      const state = editorStateRef.current;
      if (reason === "discard" && state?.dirty)
        setUndo({ projectKey: session.projectKey, state, rowKey: session.rowKey });
      editorStateRef.current = null;
      transitionRef.current = "from-editor";
      setConfirm(null);
      setEditor(null);
      if (landing) {
        setSelection((current) => ({ ...current, [session.projectKey]: landing.rowKey }));
        if (!rows.some((item) => item.key === landing.rowKey)) setAwaitedRow(landing.rowKey);
        if (landing.fromRect)
          landingRef.current = { rowKey: landing.rowKey, fromRect: landing.fromRect };
      }
      focusAfterRef.current = {
        rowKey: landing?.rowKey ?? session.rowKey,
        isNew: sessionIsNew(session),
      };
    },
  );

  const restoreDraft = useEvent(() => {
    if (editor || !undo || undo.projectKey !== snapshot.projectKey) return;
    if (undo.rowKey && !rows.some((item) => item.key === undo.rowKey)) {
      setUndo(null);
      return;
    }
    openEditor(
      { kind: "restore", state: undo.state },
      { origin: newButtonRef.current, rowKey: undo.rowKey, fromDetail: false },
    );
  });

  const dismissUndo = useEvent(() => {
    setUndo(null);
    (findRow(rootRef.current, selectedKey) ?? newButtonRef.current)?.focus({
      preventScroll: true,
    });
  });

  const requestClose = useEvent((reason: CloseRequest): boolean => {
    if (!editor) return true;
    const dirty = editorStateRef.current?.dirty ?? false;
    if (reason === "escape") {
      // A dirty draft is never thrown away by one stray key: the first Escape asks.
      if (dirty && confirm === null) setConfirm("escape");
      else closeEditor("discard");
      return false;
    }
    if (dirty && confirm !== "close") {
      setConfirm("close");
      return false;
    }
    return true;
  });
  useEffect(() => {
    controllerRef.current = { requestClose };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, requestClose]);

  const closeDialog = useEvent(() => {
    if (requestClose("close")) closeAutomationsDialog();
  });

  const runCommand = useEvent(
    async (item: DialogRow, input: CommandInput, failure: string | null): Promise<boolean> => {
      const checkout = checkoutsByKey.get(item.checkoutKey);
      if (!checkout || checkout.busy || checkout.disabledReason) return false;
      const ok = await checkout.command(input);
      if (!ok && failure) toastManager.add({ type: "warning", title: failure });
      return ok;
    },
  );
  const watchApproval = useApprovalNotices(queues);
  const decide = useEvent(
    (
      item: DialogRow,
      proposalId: AgentControlProposalId | null,
      accept: boolean,
      kind: ApprovalKind,
    ) => {
      const checkout = checkoutsByKey.get(item.checkoutKey);
      if (!checkout || !proposalId || checkout.busy || checkout.disabledReason) return;
      if (accept) watchApproval(item.checkoutKey, proposalId, kind);
      void checkout.decide(proposalId, accept ? "accept" : "reject");
    },
  );
  const setEnabled = useEvent((item: DialogRow, enabled: boolean, failure: string) => {
    const automation = item.row.automation;
    if (!automation) return;
    void runCommand(
      item,
      {
        kind: "save",
        projectId: item.projectId,
        automationId: automation.automationId,
        expectedRevision: automation.revision,
        definition: definitionWithEnabled(automation, enabled, Date.now()),
      },
      failure,
    );
  });
  const cancelSchedule = useEvent((item: DialogRow, failure: string) => {
    const automation = item.row.automation;
    if (!automation) return;
    void runCommand(
      item,
      {
        kind: "cancel",
        projectId: item.projectId,
        automationId: automation.automationId,
        expectedRevision: automation.revision,
      },
      failure,
    );
  });
  const retry = useEvent((item: DialogRow, entry: AutomationCentreRun) => {
    const failure =
      scheduleRetryState(entry, scheduleRowsByCheckout.get(item.checkoutKey) ?? []).reason ??
      "Couldn't retry.";
    void runCommand(
      item,
      { kind: "retry", projectId: item.projectId, runId: entry.run.runId },
      failure,
    );
  });
  const setUnread = useEvent((item: DialogRow, entry: AutomationCentreRun, unread: boolean) => {
    void runCommand(
      item,
      {
        kind: "read",
        projectId: item.projectId,
        runId: entry.run.runId,
        expectedUpdatedAt: entry.run.updatedAt,
        unread,
      },
      null,
    );
  });

  // Members close over `useEvent`s, setters and refs only, so the compiler
  // keeps the object stable across renders (data changes included).
  const actions: ScheduleDialogActions = {
    edit: editRow,
    pause: (item) => setEnabled(item, false, "This schedule can't be paused right now."),
    resume: (item) => setEnabled(item, true, "This schedule can't be resumed right now."),
    cancel: (item) => cancelSchedule(item, "This schedule can't be cancelled."),
    approveRun: (item) => decide(item, item.row.dueRun?.proposalId ?? null, true, "run"),
    rejectRun: (item) => decide(item, item.row.dueRun?.proposalId ?? null, false, "run"),
    approveProposal: (item) => decide(item, item.row.proposal?.id ?? null, true, "change"),
    rejectProposal: (item) => decide(item, item.row.proposal?.id ?? null, false, "change"),
    repropose: (item, origin) => {
      const lapsed = item.row.lapsed;
      if (!lapsed) return;
      if (lapsed.kind === "create" || lapsed.kind === "edit") {
        openEditor(
          { kind: "repropose", checkoutKey: item.checkoutKey, row: item.row, proposal: lapsed },
          { origin, rowKey: item.key, fromDetail: true },
        );
        return;
      }
      const failure = "That can't be proposed right now.";
      if (lapsed.kind === "cancel") cancelSchedule(item, failure);
      else setEnabled(item, lapsed.kind === "resume", failure);
    },
    dismissLapsed: (item) => {
      const lapsed = item.row.lapsed;
      if (!lapsed) return;
      transitionRef.current = "fade";
      dismissLapsedScheduleProposal(item.environmentId, lapsed.id);
    },
    retry,
    setUnread,
    openThread: (item, entry) => {
      const threadId = entry.threadIds[0];
      if (!threadId) return;
      if (entry.unread) setUnread(item, entry, false);
      closeAutomationsDialog();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(item.environmentId, threadId)),
      });
    },
    toggleHistory: (key) =>
      setHistoryOpen((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    togglePrompt: (key) =>
      setPromptOpen((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    focusRun: (key, runId) => setRunFocus((current) => ({ ...current, [key]: runId })),
  };

  // ── a request while open (another entry point) re-targets the dialog ──
  const retarget = useEvent((next: AutomationsDialogRequest) => {
    if (editor) return; // One draft at a time: an open editor keeps the dialog where it is.
    const target = resolveAutomationsDialogProject({
      snapshots,
      target: next.project,
      last: lastProject,
    });
    if (target && target.projectKey !== snapshot.projectKey) {
      listSettleRef.current = true;
      transitionRef.current = "fade";
      setProjectKey(target.projectKey);
    }
    setPending(next);
  });
  useEffect(
    () =>
      useAutomationsDialogStore.subscribe((state, previous) => {
        if (state.open && state.request && state.token !== previous.token) retarget(state.request);
      }),
    [retarget],
  );

  // ── focus: never left on <body>; lands where the editor folded back ──
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !props.open) return;
    const intent = focusAfterRef.current;
    if (intent && !editor) {
      const row = findRow(root, intent.rowKey);
      // The saved row is on its way: hold focus on the dialog until it lands.
      if (!row && intent.rowKey !== null && intent.rowKey === awaitedRow) {
        const active = document.activeElement;
        if (!active || active === document.body) root.focus({ preventScroll: true });
        return;
      }
      focusAfterRef.current = null;
      const target =
        row ??
        (intent.isNew
          ? (root.querySelector<HTMLElement>(EMPTY_NEW_SELECTOR) ?? newButtonRef.current)
          : null);
      target?.focus({ preventScroll: true });
      const landing = landingRef.current;
      landingRef.current = null;
      if (landing && row && landing.rowKey === intent.rowKey)
        landOnRow(root, row, landing.fromRect);
      return;
    }
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (!lost && !(active === root && !focusedOnceRef.current)) return;
    const target = defaultFocusTarget(root);
    if (target === root && !lost) return;
    target.focus({ preventScroll: true });
    if (target !== root) focusedOnceRef.current = true;
  });

  // ── keyboard (the lab's): ↑↓ Home End on rows, ↵ to the actions, E, N, ⌘Z; history U ──
  const onKeyDown = useEvent((event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    const root = event.currentTarget;
    // Keys typed inside a menu, picker or portal belong to it.
    if (!(target instanceof HTMLElement) || !root.contains(target)) return;
    if (target.closest('[role="menu"], [role="listbox"][data-picker]')) return;
    if (editor) return; // The editor owns its keys (⌘↵ saves).
    const typing = target.matches("input, textarea, select, [contenteditable='true']");
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === "z" &&
      undo?.projectKey === snapshot.projectKey &&
      !typing
    ) {
      event.preventDefault();
      restoreDraft();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = (index: number, length: number) =>
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? length - 1
          : Math.min(length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    const row = target.closest<HTMLElement>(`[${DIALOG_ROW_ATTRIBUTE}]`);
    if (row && MOVE_KEYS.has(event.key)) {
      event.preventDefault();
      const all = Array.from(root.querySelectorAll<HTMLElement>(`[${DIALOG_ROW_ATTRIBUTE}]`));
      const next = all[step(all.indexOf(row), all.length)];
      const key = next?.getAttribute(DIALOG_ROW_ATTRIBUTE);
      if (key) select(key, "none");
      return;
    }
    if (row && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      root
        .querySelector<HTMLElement>(
          '.ad-pane:not(.is-leaving) .ad-dh-x button:not([aria-disabled="true"]):not([disabled])',
        )
        ?.focus();
      return;
    }
    const run = target.closest<HTMLElement>(".ad-run");
    if (run && target === run) {
      if (MOVE_KEYS.has(event.key)) {
        event.preventDefault();
        const list = run.closest(".ad-runs");
        const all = list ? Array.from(list.querySelectorAll<HTMLElement>(".ad-run")) : [];
        const next = all[step(all.indexOf(run), all.length)];
        const runId = next?.dataset.run;
        if (next && runId && selectedKey) {
          actions.focusRun(selectedKey, runId);
          next.focus();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        run.querySelector<HTMLElement>(".ad-run-a button")?.click();
        return;
      }
    }
    if (run && (event.key === "u" || event.key === "U")) {
      event.preventDefault();
      const entry = selectedItem?.row.history.find((x) => x.run.runId === run.dataset.run);
      if (selectedItem && entry) setUnread(selectedItem, entry, !entry.unread);
      return;
    }
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      openNew(newButtonRef.current);
    } else if ((event.key === "e" || event.key === "E") && selectedItem) {
      if (selectedItem.row.state === "lapsed") return;
      event.preventDefault();
      editRow(selectedItem, "title");
    }
  });

  // ── panes: cross-fade (the old pane stays, inert, while it fades) ──
  const paneRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const how = transitionRef.current;
    transitionRef.current = "none";
    animatePaneIn(node, how);
    return () => retirePane(node, transitionRef.current);
  }, []);
  const takeListSettle = useCallback(() => {
    const settle = listSettleRef.current;
    listSettleRef.current = false;
    return settle;
  }, []);

  // ── editor callbacks ──
  const onEditorDirtyChange = useEvent((_dirty: boolean, state: ScheduleEditorDraftState) => {
    editorStateRef.current = state;
    setConfirm(null);
  });
  const onEditorSaved = useEvent((result: ScheduleEditorSavedResult) => {
    const checkout = checkoutsByKey.get(result.checkoutKey);
    if (!checkout) {
      closeEditor("saved");
      return;
    }
    closeEditor("saved", {
      rowKey: dialogRowKey(checkout.environmentId, result.automationId),
      fromRect: result.fromRect,
    });
  });
  const onEditorClose = useEvent((reason: "discard" | "unchanged") => closeEditor(reason));
  const onKeepEditing = useEvent(() => setConfirm(null));

  // ── what shows ──
  const empty = rows.length === 0;
  const queue = dialogQueueLine(rows, editor ? null : selectedKey);
  const showUndo = !!undo && undo.projectKey === snapshot.projectKey && !editor;
  const unavailable = empty ? unreadableReason : null;
  const unreachable = empty
    ? []
    : checkouts.filter((checkout) => !checkout.snapshot && checkout.error);
  const primary = snapshot.memberProjects[0] ?? snapshot;
  const selectedCheckout = selectedItem ? checkoutsByKey.get(selectedItem.checkoutKey) : undefined;

  let pane;
  if (editor) {
    const isNew = sessionIsNew(editor);
    pane = (
      <div
        key={`editor:${editor.id}`}
        ref={paneRef}
        className="ad-pane ad-pane-editor"
        role="region"
        aria-label={isNew ? "New schedule" : `Edit ${sessionTitle(editor)}`}
      >
        <Editor
          source={editor.source}
          project={snapshot}
          checkouts={checkouts}
          nowMs={nowMs}
          focus={editor.focus}
          fromDetail={editor.fromDetail}
          origin={editor.origin}
          confirm={confirm}
          onKeepEditing={onKeepEditing}
          onDirtyChange={onEditorDirtyChange}
          onSaved={onEditorSaved}
          onClose={onEditorClose}
        />
      </div>
    );
  } else if (selectedItem && selectedCheckout) {
    pane = (
      <div key={selectedItem.key} ref={paneRef} className="ad-pane ad-pane-detail">
        <ScheduleDetail
          item={selectedItem}
          checkout={selectedCheckout}
          scheduleRows={scheduleRowsByCheckout.get(selectedItem.checkoutKey) ?? []}
          projectName={snapshot.displayName}
          nowMs={nowMs}
          historyOpen={historyOpen.has(selectedItem.key)}
          promptOpen={promptOpen.has(selectedItem.key)}
          focusRunId={runFocus[selectedItem.key] ?? null}
          actions={actions}
        />
      </div>
    );
  } else {
    pane = (
      <div key="empty" ref={paneRef} className="ad-pane ad-pane-empty">
        {loading && empty ? null : unavailable ? (
          <UnavailableState message={unavailable} />
        ) : (
          <EmptyProjectState
            projectName={snapshot.displayName}
            path={formatProjectPath(primary.cwd, inferHomeDirectory(primary.cwd))}
            newOff={limit.allFull}
            newOffReason={newOffReason}
            onNew={(origin) => openNew(origin)}
          />
        )}
      </div>
    );
  }

  return (
    // The root takes focus only while nothing inside it can (data still loading).
    <div ref={rootRef} className="ad-root" tabIndex={-1} onKeyDown={onKeyDown}>
      {automations.sources}
      <AutomationsDialogHeader
        project={snapshot}
        projects={snapshots}
        currentCounts={liveProjectCounts(rows)}
        editing={editor !== null}
        limit={limit}
        lockedReason={newOffReason}
        multiDevice={checkouts.length > 1}
        queue={queue}
        newButtonRef={newButtonRef}
        onSwitchProject={switchProject}
        onNew={(origin) => openNew(origin)}
        onClose={closeDialog}
        onShowRow={(key) => select(key, "fade")}
      />
      <div
        className="ad-body"
        data-empty={empty ? "" : undefined}
        data-editing={editor ? "" : undefined}
      >
        <div className="ad-list" inert={editor !== null}>
          <ScheduleList
            key={snapshot.projectKey}
            projectName={snapshot.displayName}
            sections={sections}
            devices={devices}
            selectedKey={selectedKey}
            editingKey={editor?.rowKey ?? null}
            nowMs={nowMs}
            takeSettle={takeListSettle}
            onSelect={(key) => select(key, "fade")}
          />
          {unreachable.map((checkout) => (
            <p key={checkout.key} className="ad-list-note">
              {checkout.deviceLabel}: {checkout.error}
            </p>
          ))}
        </div>
        <div className="ad-detail" data-undo={showUndo ? "" : undefined}>
          {pane}
          {showUndo ? <UndoBar onRestore={restoreDraft} onDismiss={dismissUndo} /> : null}
        </div>
      </div>
    </div>
  );
}
