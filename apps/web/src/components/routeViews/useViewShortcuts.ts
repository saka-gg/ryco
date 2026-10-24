import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@ryco/contracts";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { paneContains, paneKey } from "../../chatPanes.logic";
import { useChatPanesStore } from "../../chatPanesStore";
import {
  sameClosedViewOwner,
  takeClosedView,
  type ClosedView,
  type ClosedViewOwner,
  type ClosedViewVerdict,
} from "../../closedViews";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveShortcutCommand, shouldIgnoreSplitViewShortcut } from "../../keybindings";
import { isComposerFocused } from "../../lib/composerFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { getModelPickerOpen } from "../../modelPickerOpenState";
import { buildRightPanelTargetSearch, type RightPanelTabTarget } from "../../rightPanelTabs.logic";
import {
  selectSidebarThreadSummaryByRef,
  selectThreadAvailabilityByRef,
  useStore,
} from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

interface ViewShortcutsInput {
  /** The route's thread or draft; null turns the shortcuts off. */
  readonly owner: ClosedViewOwner | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly closeActiveView: () => boolean;
  readonly isPanelTargetOpen: (target: RightPanelTabTarget) => boolean;
  readonly openPanelTarget: (target: RightPanelTabTarget) => void;
}

type Navigate = UseNavigateResult<string>;

// ThreadWorkspacePanel marks its tab content; the pull request and note
// editors mark a field holding text that is not sent or saved yet (a reply,
// line comment or note, an edited description, post or title).
const WORKSPACE_TABPANEL_SELECTOR = '[data-slot="workspace-tabpanel"]';
const UNSENT_DRAFT_SELECTOR = "[data-unsent-draft]";

/** The narrow-viewport sheet showing the workspace panel; its keys stay with the panel. */
function hostsWorkspacePanel(dialog: Element): boolean {
  return dialog.querySelector(WORKSPACE_TABPANEL_SELECTOR) !== null;
}

/** Whether the open workspace panel holds text that closing its tab would drop. */
function hasUnsentWorkspaceDraft(): boolean {
  const panel = document.querySelector(WORKSPACE_TABPANEL_SELECTOR);
  return (
    panel !== null &&
    panel.closest("[hidden], [inert]") === null &&
    panel.querySelector(UNSENT_DRAFT_SELECTOR) !== null
  );
}

/**
 * `terminalFocus` for these keys. A terminal shown as a workspace panel tab is
 * a tab like the others, so the view keys close and reopen it too; otherwise
 * the key would reach the window's Close command. The drawer's terminal keeps
 * its own `mod+w` rule.
 */
function isViewTerminalFocused(): boolean {
  return (
    isTerminalFocused() && document.activeElement?.closest(WORKSPACE_TABPANEL_SELECTOR) == null
  );
}

/** Whether the terminal drawer of the route's thread (or draft) is open, for `when` clauses. */
function isRouteTerminalOpen(owner: ClosedViewOwner): boolean {
  let ref: ScopedThreadRef | null = owner.kind === "thread" ? owner.ref : null;
  if (owner.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(owner.draftId);
    ref = session ? scopeThreadRef(session.environmentId, session.threadId) : null;
  }
  if (!ref) return false;
  return selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadKey, ref)
    .terminalOpen;
}

/** Whether a thread can be shown again: gone or archived never, not loaded yet maybe later. */
function threadReopenVerdict(ref: ScopedThreadRef): ClosedViewVerdict {
  if (useComposerDraftStore.getState().getDraftThreadByRef(ref)) return "reopen";
  const state = useStore.getState();
  switch (selectThreadAvailabilityByRef(state, ref)) {
    case "available":
      return selectSidebarThreadSummaryByRef(state, ref)?.archivedAt ? "drop" : "reopen";
    case "missing":
      return "drop";
    case "unknown":
      return "keep";
  }
}

function reopenVerdict(
  input: ViewShortcutsInput,
  owner: ClosedViewOwner,
  view: ClosedView,
): ClosedViewVerdict {
  if (view.kind === "pane") {
    // On screen again: the route's thread, or a pane of the split around it.
    const root = useChatPanesStore.getState().root;
    if (
      owner.kind === "thread" &&
      (paneKey(owner.ref) === paneKey(view.ref) ||
        (root !== null && paneContains(root, owner.ref) && paneContains(root, view.ref)))
    ) {
      return "drop";
    }
    return threadReopenVerdict(view.ref);
  }
  if (sameClosedViewOwner(view.owner, owner)) {
    return input.isPanelTargetOpen(view.target) ? "drop" : "reopen";
  }
  if (view.owner.kind === "thread") return threadReopenVerdict(view.owner.ref);
  return useComposerDraftStore.getState().getDraftSession(view.owner.draftId) ? "reopen" : "drop";
}

function reopenView(
  input: ViewShortcutsInput,
  navigate: Navigate,
  owner: ClosedViewOwner,
  view: ClosedView,
): void {
  if (view.kind === "pane") {
    // Back into the split around this thread; one that cannot take it (full,
    // another environment, a draft route) gives way to the pane's own thread.
    if (useChatPanesStore.getState().controller?.reopen(view.ref, view.layout)) return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(view.ref) });
    return;
  }
  if (sameClosedViewOwner(view.owner, owner)) {
    input.openPanelTarget(view.target);
    return;
  }
  const search = buildRightPanelTargetSearch({}, view.target);
  if (view.owner.kind === "thread") {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(view.owner.ref),
      search,
    });
    return;
  }
  void navigate({ to: "/draft/$draftId", params: { draftId: view.owner.draftId }, search });
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function handleViewShortcut(
  event: KeyboardEvent,
  input: ViewShortcutsInput,
  navigate: Navigate,
): void {
  const { owner } = input;
  if (!owner || event.defaultPrevented || useCommandPaletteStore.getState().open) return;
  // The same context as the chat-wide shortcuts, so a rule bound to the same
  // keys under another condition is not shadowed. Resolving first keeps the
  // dialog scan below off every other key press.
  const command = resolveShortcutCommand(event, input.keybindings, {
    context: {
      terminalFocus: isViewTerminalFocused(),
      terminalOpen: isRouteTerminalOpen(owner),
      modelPickerOpen: getModelPickerOpen(),
      commandPaletteOpen: false,
      composerFocus: isComposerFocused(),
    },
  });
  if (command !== "view.close" && command !== "view.reopenClosed") return;
  if (shouldIgnoreSplitViewShortcut(event, hostsWorkspacePanel)) return;
  // Holding the key closes or reopens one view, never the window behind it.
  // While a pane closes or moves focus, act on nothing: its navigation decides
  // what is open next.
  if (event.repeat || useChatPanesStore.getState().controller?.busy()) {
    consume(event);
    return;
  }
  if (command === "view.close") {
    if (hasUnsentWorkspaceDraft()) {
      consume(event);
      toastManager.add({
        type: "warning",
        title: "Finish or discard your draft before closing this tab",
      });
      return;
    }
    const closed =
      input.closeActiveView() || useChatPanesStore.getState().controller?.closeFocused() === true;
    if (closed) consume(event);
    return;
  }
  const view = takeClosedView((entry) => reopenVerdict(input, owner, entry));
  if (!view) return;
  consume(event);
  reopenView(input, navigate, owner, view);
}

/**
 * Close and reopen views from the keyboard on a thread or draft route.
 * `view.close` closes the workspace panel's active tab, else the panel while
 * it shows only the launcher, else the focused split pane; with nothing to
 * close, the key goes on to the window (or the browser). `view.reopenClosed`
 * brings back the newest closed view that can still be shown: a tab in its
 * thread or draft, opening that when it is another one, and a pane in the
 * split. Holding either key acts once.
 */
export function useViewShortcuts(input: ViewShortcutsInput): void {
  const navigate = useNavigate();
  const onKeyDown = useEffectEvent((event: KeyboardEvent) =>
    handleViewShortcut(event, input, navigate),
  );
  useEffect(() => {
    // Capture: the workspace sheet stops every key from bubbling out of it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
