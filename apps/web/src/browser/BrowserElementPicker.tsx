import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  createBrowserElementReference,
  formatBrowserElementTitle,
} from "@ryco/client-runtime/state/composer";
import type {
  DesktopBridge,
  ProjectBrowserPickCancelReason,
  ProjectBrowserPickedElement,
  ProjectBrowserTab,
  ScopedThreadRef,
} from "@ryco/contracts";
import {
  BROWSER_ELEMENT_MAX_COMMENT_LENGTH,
  BROWSER_ELEMENT_MAX_PER_PROMPT,
} from "@ryco/contracts/browser-element-limits";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { addReferenceToComposer, type ReferenceAddResult } from "../composerContextIntake";
import {
  FileReferenceNoteComposer,
  type ReferenceAddErrors,
} from "../components/fileReferences/FileReferenceNoteComposer";

type BrowserBridge = NonNullable<DesktopBridge["browser"]>;

const ADD_ERRORS: ReferenceAddErrors = {
  full: `This message already has ${BROWSER_ELEMENT_MAX_PER_PROMPT} page elements. Remove one to add more.`,
  refused: "The chat can’t take page elements right now.",
  invalid: "This element can’t be sent to the chat.",
};

/** Why picking stopped, for the reasons the user did not cause and should hear about. */
const CANCEL_NOTICES: Partial<Record<ProjectBrowserPickCancelReason, string>> = {
  agent: "The agent used this tab, so picking stopped.",
  detached: "Picking stopped because another tool took over this page.",
  navigation: "The page changed, so picking stopped.",
  timeout: "Picking timed out.",
};

/** How long a notice says why picking stopped before the page gets its room back. */
export const BROWSER_PICK_NOTICE_MS = 8_000;

const IDLE = { kind: "idle" } as const;

/** What the picker shows for one tab of one thread's panel. */
type PickerState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly generation: number }
  | { readonly kind: "notice"; readonly message: string }
  | {
      readonly kind: "note";
      readonly id: number;
      readonly element: ProjectBrowserPickedElement;
    };

export interface BrowserElementPicker {
  /** The "Pick element" / "Cancel picking" button for the toolbar. */
  readonly control: ReactNode;
  /**
   * The picking hint, a notice, or the note box: in-flow content for the one
   * slot above the page, never a dialog, popover or menu (those would cover
   * the native page and end the pick).
   */
  readonly panel: ReactNode;
}

/**
 * "Pick element" for the Browser panel of a thread's workspace: the user
 * clicks an element in the page (desktop main runs Chromium's inspect tool on
 * the tab), writes an optional note, and "Add to chat" hands the element to
 * the thread's composer. `null` when picking is not offered (no desktop
 * picker, no composer taking context, a popped-out or failed tab). The note
 * lives here, not in the tab's `picker` state, so it survives a navigation
 * that ends the highlight. State is per thread, project and tab while picking
 * is offered there: switching any of them, or picking no longer being
 * offered, starts over.
 */
export function useBrowserElementPicker(input: {
  readonly api: BrowserBridge | undefined;
  readonly tab: ProjectBrowserTab | null;
  readonly thread: ScopedThreadRef | null;
  /** The panel's project key: a change starts over, like a tab change. */
  readonly project: string;
  readonly available: boolean;
  readonly onError: (message: string | null) => void;
}): BrowserElementPicker | null {
  const { api, tab, thread, project, onError } = input;
  const tabId = tab?.id ?? null;
  const enabled =
    Boolean(api?.pick) &&
    thread !== null &&
    input.available &&
    tab !== null &&
    tab.presentation !== "window" &&
    !tab.error;
  /** Where picking is offered; null while it is not. */
  const scope =
    enabled && thread && tabId !== null
      ? JSON.stringify([project, scopedThreadKey(thread), tabId])
      : null;
  const [state, setState] = useState<{
    readonly scope: string | null;
    readonly value: PickerState;
  }>({ scope, value: IDLE });
  // Another thread, project or tab, or picking no longer offered (the composer
  // went away, the tab popped out or failed), starts over: coming back does
  // not bring back a note whose highlight has ended, and a pick still running
  // for the old scope settles nowhere.
  if (state.scope !== scope) setState({ scope, value: IDLE });
  const current = state.scope === scope ? state.value : IDLE;
  const generationRef = useRef(0);
  /** The tab whose pick (choosing, or a picked element's highlight) this picker opened. */
  const ownedTabRef = useRef<string | null>(null);
  const picking = enabled && (current.kind === "starting" || tab?.picker === "picking");

  const endPick = useCallback(() => {
    if (!api || tabId === null) return;
    ownedTabRef.current = null;
    void api.command({ action: "end-pick", tab: tabId }).catch(() => undefined);
  }, [api, tabId]);

  const start = useCallback(async () => {
    if (!api?.pick || tabId === null || scope === null) return;
    const generation = ++generationRef.current;
    const at = scope;
    ownedTabRef.current = tabId;
    onError(null);
    setState({ scope: at, value: { kind: "starting", generation } });
    // Only the latest pick of this scope may change what the picker shows.
    const settle = (value: PickerState) =>
      setState((previous) =>
        previous.scope === at &&
        previous.value.kind === "starting" &&
        previous.value.generation === generation
          ? { scope: at, value }
          : previous,
      );
    try {
      const result = await api.pick(tabId);
      if (result.kind === "picked") {
        settle({ kind: "note", id: generation, element: result.element });
        return;
      }
      // The desktop ended the pick itself; nothing is left to end.
      if (generationRef.current === generation) ownedTabRef.current = null;
      const message = CANCEL_NOTICES[result.reason];
      settle(message ? { kind: "notice", message } : IDLE);
    } catch (error) {
      settle(IDLE);
      if (generationRef.current === generation) {
        ownedTabRef.current = null;
        onError(error instanceof Error ? error.message : "Couldn’t pick an element.");
      }
    }
  }, [api, onError, scope, tabId]);

  const close = useCallback(() => {
    endPick();
    setState({ scope, value: IDLE });
  }, [endPick, scope]);

  // A pick or a picked element's highlight never outlives what showed it:
  // another thread, project or tab, picking no longer offered (the composer
  // went away, the tab popped out or failed), or the panel closing.
  useEffect(() => {
    if (scope === null || !api) return;
    return () => {
      const owned = ownedTabRef.current;
      if (owned === null) return;
      ownedTabRef.current = null;
      void api.command({ action: "end-pick", tab: owned }).catch(() => undefined);
    };
  }, [api, scope]);

  // A notice is said once, then the page gets its room back.
  useEffect(() => {
    if (current.kind !== "notice") return;
    const timer = window.setTimeout(
      () =>
        setState((previous) =>
          previous.value === current ? { scope: previous.scope, value: IDLE } : previous,
        ),
      BROWSER_PICK_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [current]);

  // Esc cancels while the page is waiting for a click; in the page itself,
  // desktop main handles it. Only while picking, so Esc keeps its other uses.
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      endPick();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [endPick, picking]);

  if (!enabled || !thread) return null;

  const add = (comment: string): ReferenceAddResult => {
    if (current.kind !== "note") return "invalid";
    const element = createBrowserElementReference({ ...current.element, comment });
    if (!element) return "invalid";
    const result = addReferenceToComposer(thread, { kind: "browser-element", element });
    if (result === "added") close();
    return result;
  };

  const control = (
    <button
      type="button"
      aria-pressed={picking}
      onClick={() => {
        if (picking) endPick();
        else void start();
      }}
    >
      {picking ? "Cancel picking" : "Pick element"}
    </button>
  );

  const panel =
    current.kind === "note" ? (
      <div className="shrink-0 border-b" data-browser-element-note>
        <FileReferenceNoteComposer
          key={current.id}
          title={formatBrowserElementTitle(current.element)}
          onCancel={close}
          onAdd={add}
          maxLength={BROWSER_ELEMENT_MAX_COMMENT_LENGTH}
          addErrors={ADD_ERRORS}
        />
      </div>
    ) : picking ? (
      <p role="status" className="shrink-0 border-b p-2 text-xs text-muted-foreground">
        Click an element on the page to add it to the chat. Esc cancels.
      </p>
    ) : current.kind === "notice" ? (
      <p role="status" className="shrink-0 border-b p-2 text-xs text-muted-foreground">
        {current.message}
      </p>
    ) : null;

  return { control, panel };
}
