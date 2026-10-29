import type { ScriptShortcutScope } from "@ryco/client-runtime/state/settings";
import type { ScopedThreadRef } from "@ryco/contracts";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { useAppKeybindings } from "~/appKeybindings";
import {
  hasOpenDialogShortcutTarget,
  resolveShortcutCommand,
  type ShortcutMatchContext,
} from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { getModelPickerOpen } from "~/modelPickerOpenState";
import { selectThreadTerminalState, useTerminalStateStore } from "~/terminalStateStore";

/**
 * Marks a diff view that runs its own find for the thread-find shortcut while
 * focus is inside it. The chat's thread find yields to it (see
 * `isDiffFindSurfaceTarget` in ChatView, which matches this attribute by a
 * literal selector; `ChatView.DiffFind.browser.tsx` keeps the two in step).
 */
export const DIFF_FIND_SURFACE_ATTRIBUTE = "data-diff-find-surface";

/** The element a click into the diff focuses, so keyboard scrolling keeps working there. */
const DIFF_SCROLLER_SELECTOR = ".diff-render-surface";

/**
 * Whether the find key belongs to someone else: IME composition, a key from a
 * portal the surface does not contain in the DOM (React bubbles those through
 * it), or another open dialog. A dialog hosting the surface (the narrow
 * workspace sheet) does not count.
 */
export function shouldIgnoreDiffFindShortcut(
  event: {
    readonly type?: string;
    readonly isComposing?: boolean;
    readonly target: EventTarget | null;
  },
  surface: Element,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") return true;
  if (event.isComposing) return true;
  if (!(event.target instanceof Node) || !surface.contains(event.target)) return true;
  return hasOpenDialogShortcutTarget((dialog) => dialog.contains(surface));
}

export interface DiffFindSurfaceProps {
  readonly ref?: Ref<HTMLDivElement>;
  readonly "data-diff-find-surface"?: "";
  readonly tabIndex?: -1;
  readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

export interface DiffFindSurface {
  /** Spread on the element holding the whole diff view: toolbar, find bar and scroller. */
  readonly props: DiffFindSurfaceProps;
  /** Focus the diff's scroller (keyboard scrolling works from it), or the view. */
  readonly focus: () => void;
}

const DISABLED_SURFACE_PROPS: DiffFindSurfaceProps = {};

/**
 * The `when` context the chat's thread find resolves the key with, read at key
 * time, so both resolve a key to the same command (a binding limited to an
 * open terminal is not shadowed here).
 */
function readThreadFindShortcutContext(
  threadRef: ScopedThreadRef | null,
): Partial<ShortcutMatchContext> {
  return {
    terminalFocus: isTerminalFocused(),
    terminalOpen: selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadKey,
      threadRef,
    ).terminalOpen,
    modelPickerOpen: getModelPickerOpen(),
  };
}

/**
 * A diff view that answers the user's thread-find shortcut (⌘F / Ctrl+F by
 * default) while focus is inside it. A click into the diff, whose rows cannot
 * take focus, focuses the scroller (tabindex -1), so the key knows where focus
 * is and arrow/page keys still scroll the diff. Resolved with the project scope
 * and `when` context the chat uses, so a key the chat would resolve to another
 * command (a project script, a terminal-only binding) is not taken here.
 */
export function useDiffFindSurface(input: {
  readonly onFind: () => void;
  /** Off on the frozen phone tier and while there is no diff to search. */
  readonly enabled: boolean;
  readonly scope: ScriptShortcutScope | null;
  /** The thread beside the diff, whose terminal state the `when` context reads. */
  readonly threadRef: ScopedThreadRef | null;
}): DiffFindSurface {
  const { enabled, onFind, scope, threadRef } = input;
  const keybindings = useAppKeybindings(scope);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The scroller is pierre's `Virtualizer`, which takes no tabIndex; mark it
  // after each commit (cheap, and it covers a remounted scroller).
  useLayoutEffect(() => {
    if (!enabled) return;
    const scroller = rootRef.current?.querySelector<HTMLElement>(DIFF_SCROLLER_SELECTOR);
    if (scroller && !scroller.hasAttribute("tabindex")) scroller.tabIndex = -1;
  });

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const nativeEvent = event.nativeEvent;
      // Resolve first: every key typed in the panel passes here, and the ignore
      // check below queries the document for open dialogs.
      const command = resolveShortcutCommand(nativeEvent, keybindings, {
        context: readThreadFindShortcutContext(threadRef),
      });
      if (command !== "thread.find") return;
      if (shouldIgnoreDiffFindShortcut(nativeEvent, event.currentTarget)) return;
      event.preventDefault();
      event.stopPropagation();
      onFind();
    },
    [keybindings, onFind, threadRef],
  );

  const focus = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = root.querySelector<HTMLElement>(DIFF_SCROLLER_SELECTOR);
    (scroller?.hasAttribute("tabindex") ? scroller : root).focus({ preventScroll: true });
  }, []);

  const props = useMemo<DiffFindSurfaceProps>(
    () =>
      enabled
        ? {
            ref: (element: HTMLDivElement | null) => {
              rootRef.current = element;
            },
            [DIFF_FIND_SURFACE_ATTRIBUTE]: "",
            tabIndex: -1,
            onKeyDown,
          }
        : DISABLED_SURFACE_PROPS,
    [enabled, onKeyDown],
  );

  return { props, focus };
}
