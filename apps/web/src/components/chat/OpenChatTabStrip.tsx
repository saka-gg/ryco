import type { ScopedThreadRef } from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  closeOpenChatTab,
  closeOpenChatTabs,
  createOpenChatTabCloseQueue,
  type OpenChatTab,
  type OpenChatTabCloseScope,
  resolveOpenChatTabsInCloseScope,
  stepOpenChatTab,
} from "@ryco/client-runtime/state/threads/openChatTabs";
import { LoaderCircleIcon, MessageSquareIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAppKeybindings } from "../../appKeybindings";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { resolveShortcutCommand, shouldIgnoreSplitViewShortcut } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { readLocalApi } from "../../localApi";
import { useOpenChatTabsStore } from "../../openChatTabsStore";
import { toastManager } from "../ui/toast";
import { ContentTabStrip } from "./ContentTabStrip";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  useActivateOpenChatTab,
  useOpenChatTabs,
  useReadRouteThreadRef,
  useRecordOpenChatTab,
} from "./useOpenChatTabs";

/*
 * The open chats as browser-style tabs in the chat header, in place of the chat's title. Owns what
 * is specific to chats: which tabs exist, recording the chat on screen, the close queue, the
 * optimistic selection, the next/previous keys and the tab's context menu. Loaded with the chat
 * route's first header that shows it, never at boot.
 */

const CLOSE_TABS_MENU_ROWS: readonly { scope: OpenChatTabCloseScope; label: string }[] = [
  { scope: "left", label: "Close Tabs to the Left" },
  { scope: "right", label: "Close Tabs to the Right" },
  { scope: "others", label: "Close Other Tabs" },
];

function OpenChatTabIcon(props: { readonly tab: OpenChatTab }) {
  const { tab } = props;
  // A running chat spins in place of its glyph.
  if (tab.isRunning) {
    return (
      <span role="img" aria-label="Working" className="inline-flex">
        <LoaderCircleIcon
          aria-hidden
          className="size-3.5 animate-spin text-sky-600 dark:text-sky-300/80"
        />
      </span>
    );
  }
  const Icon =
    (tab.providerDriver ? PROVIDER_ICON_BY_PROVIDER[tab.providerDriver] : null) ??
    MessageSquareIcon;
  return <Icon aria-hidden className="size-3.5" />;
}

/**
 * Paints a clicked tab as active at once; the chat follows when its navigation commits. Any
 * committed change of the chat on screen clears the override, and a navigation that does not land
 * (the file preview's save guard) hands the highlight back once it settles.
 */
function useOptimisticTabSelection(input: {
  readonly activeKey: string | null;
  readonly hasTab: (key: string) => boolean;
  readonly activate: (key: string) => Promise<unknown>;
}) {
  const { activeKey, hasTab, activate } = input;
  const [pending, setPending] = useState<{ from: string | null; to: string } | null>(null);
  // A committed change of the chat on screen supersedes the click (reset during render, so a
  // navigation away and back cannot revive it).
  if (pending !== null && pending.from !== activeKey) setPending(null);
  const shownKey = pending !== null && hasTab(pending.to) ? pending.to : activeKey;
  const select = (key: string) => {
    if (key === activeKey) {
      setPending(null);
      return;
    }
    const next = { from: activeKey, to: key };
    setPending(next);
    void activate(key).finally(() => {
      setPending((current) => (current === next ? null : current));
    });
  };
  return { shownKey, select, cancel: () => setPending(null) };
}

export function OpenChatTabStrip(props: {
  /** The chat on screen; null on an unsent draft, which has no tab. */
  readonly activeRef: ScopedThreadRef | null;
  /** Shown in the strip's place while no chat has a tab (an unsent draft, a first open). */
  readonly fallback: ReactNode;
}) {
  const { activeRef } = props;
  useRecordOpenChatTab(activeRef);
  const tabs = useOpenChatTabs(activeRef);
  const closeTab = useOpenChatTabsStore((state) => state.close);
  const closeMany = useOpenChatTabsStore((state) => state.closeMany);
  const moveTab = useOpenChatTabsStore((state) => state.move);
  const keybindings = useAppKeybindings();
  const activateRef = useActivateOpenChatTab();
  const readRouteRef = useReadRouteThreadRef();
  const { handleNewThread } = useNewThreadHandler();
  const [enqueueClose] = useState(createOpenChatTabCloseQueue);

  const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
  const activeTab = activeRef
    ? tabs.find(
        (tab) =>
          tab.ref.environmentId === activeRef.environmentId &&
          tab.ref.threadId === activeRef.threadId,
      )
    : undefined;
  const {
    shownKey,
    select,
    cancel: cancelSelection,
  } = useOptimisticTabSelection({
    activeKey: activeTab?.key ?? null,
    hasTab: (key) => tabByKey.has(key),
    activate: (key) => {
      const tab = tabByKey.get(key);
      return tab ? activateRef(tab.ref) : Promise.resolve(false);
    },
  });

  // Previous/next tab, wrapping like a browser. Steps from the tab painted as active, so a quick
  // run of presses walks the strip before each chat renders. Typing in the composer does not stop
  // it; a dialog, the command palette or IME composition does.
  const keyState = useRef({ tabs, shownKey, select, keybindings });
  useLayoutEffect(() => {
    keyState.current = { tabs, shownKey, select, keybindings };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || useCommandPaletteStore.getState().open) return;
      const state = keyState.current;
      const command = resolveShortcutCommand(event, state.keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "threadTab.next" && command !== "threadTab.previous") return;
      if (shouldIgnoreSplitViewShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const shown = state.shownKey
        ? (state.tabs.find((tab) => tab.key === state.shownKey) ?? null)
        : null;
      const next = stepOpenChatTab({
        tabs: state.tabs,
        shownRef: shown?.ref ?? null,
        direction: command === "threadTab.previous" ? "backward" : "forward",
      });
      const nextTab = next
        ? state.tabs.find(
            (tab) =>
              tab.ref.environmentId === next.environmentId && tab.ref.threadId === next.threadId,
          )
        : undefined;
      if (nextTab && nextTab.key !== state.shownKey) state.select(nextTab.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const liveTabs = () => {
    // The tabs as clicked, minus any an earlier queued close has since dropped.
    const open = useOpenChatTabsStore.getState().refs;
    return tabs.filter((tab) =>
      open.some(
        (ref) => ref.environmentId === tab.ref.environmentId && ref.threadId === tab.ref.threadId,
      ),
    );
  };

  const closeChatTab = (tab: OpenChatTab) => {
    cancelSelection();
    void enqueueClose(() =>
      closeOpenChatTab({
        tabs: liveTabs(),
        closedRef: tab.ref,
        activeRef: readRouteRef(),
        closeTab,
        openTab: activateRef,
        // The last tab gives way to a fresh chat in its project, as a new chat would open.
        replaceLastTab: async () => {
          try {
            await handleNewThread(scopeProjectRef(tab.ref.environmentId, tab.projectId));
            return { ok: true };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : "Unable to open a new chat.",
            };
          }
        },
        readRouteRef,
      }),
    ).then((result) => {
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Unable to close the tab",
          description: result.error,
        });
      }
    });
  };

  const closeTabsInScope = (anchor: OpenChatTab, scope: OpenChatTabCloseScope) => {
    cancelSelection();
    void enqueueClose(() =>
      closeOpenChatTabs({
        closedRefs: resolveOpenChatTabsInCloseScope(liveTabs(), anchor.ref, scope),
        keptRef: anchor.ref,
        activeRef: readRouteRef(),
        closeTabs: closeMany,
        openTab: activateRef,
        readRouteRef,
      }),
    );
  };

  const openTabContextMenu = (tab: OpenChatTab, position: { x: number; y: number }) => {
    // Only the scopes that have tabs in them are listed: none on a lone tab, and no left (or
    // right) row on the first (or last) tab.
    const rows = CLOSE_TABS_MENU_ROWS.filter(
      (row) => resolveOpenChatTabsInCloseScope(tabs, tab.ref, row.scope).length > 0,
    );
    const api = readLocalApi();
    if (!api || rows.length === 0) return;
    void api.contextMenu
      .show(
        rows.map((row) => ({ id: row.scope, label: row.label })),
        position,
      )
      .then((clicked) => {
        const row = rows.find((candidate) => candidate.scope === clicked);
        if (row) closeTabsInScope(tab, row.scope);
      });
  };

  if (tabs.length === 0) return <>{props.fallback}</>;

  return (
    <ContentTabStrip
      ariaLabel="Open chats"
      activeKey={shownKey}
      onMove={(key, overKey) => {
        const from = tabByKey.get(key);
        const over = tabByKey.get(overKey);
        if (from && over) moveTab(from.ref, over.ref);
      }}
      tabs={tabs.map((tab) => ({
        key: tab.key,
        title: tab.title,
        icon: <OpenChatTabIcon tab={tab} />,
        onSelect: () => {
          if (tab.key !== shownKey) select(tab.key);
        },
        onClose: () => closeChatTab(tab),
        onContextMenu: (position) => openTabContextMenu(tab, position),
      }))}
    />
  );
}
