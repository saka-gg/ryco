import { useAppKeybindings } from "../../appKeybindings";
import { Outlet } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import { useEffect, useEffectEvent } from "react";

import { useChatPanesStore } from "../../chatPanesStore";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import {
  startNewChatFromContext,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../../lib/chatThreadActions";
import { isComposerFocused } from "../../lib/composerFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useModelPickerOpen } from "../../modelPickerOpenState";
import {
  isSplitViewCommand,
  resolveShortcutCommand,
  shouldIgnoreGlobalNavigationShortcut,
  shouldIgnoreSplitViewShortcut,
} from "../../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { toggleThreadPin } from "../../threadPinning";

const selectDefaultThreadEnvMode = (settings: UnifiedSettings) => settings.defaultThreadEnvMode;
const selectConfirmThreadUnpin = (settings: UnifiedSettings) => settings.confirmThreadUnpin;

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const {
    activeContextIsChat,
    activeDraftThread,
    activeThread,
    chatTarget,
    defaultProjectRef,
    handleNewChat,
    handleNewThread,
    routeThreadRef,
  } = useHandleNewThread();
  const keybindings = useAppKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const modelPickerOpen = useModelPickerOpen();
  const defaultThreadEnvMode = useSettings(selectDefaultThreadEnvMode);
  const confirmThreadUnpin = useSettings(selectConfirmThreadUnpin);

  // The handler always sees the latest render's values, so the window
  // listener below binds once per mount instead of on every change.
  const onWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const ignoreNavigation = shouldIgnoreGlobalNavigationShortcut(event);
    if (ignoreNavigation && shouldIgnoreSplitViewShortcut(event)) return;
    // Read modal/palette state via `getState()` at event time so we always
    // see the latest value. The other booleans come from React-tracked
    // stores or DOM queries that are cheap enough to call per event.
    const commandPaletteOpen = useCommandPaletteStore.getState().open;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        modelPickerOpen,
        commandPaletteOpen,
        composerFocus: isComposerFocused(),
      },
    });

    if (commandPaletteOpen) {
      return;
    }

    if (isSplitViewCommand(command)) {
      if (command === "pane.split") {
        event.preventDefault();
        event.stopPropagation();
        useCommandPaletteStore.getState().openSplitThread();
        return;
      }
      // A lone pane leaves these keys to the focused control.
      const controller = useChatPanesStore.getState().controller;
      const handled =
        command === "pane.close"
          ? controller?.closeFocused()
          : controller?.focusSibling(command === "pane.focusNext" ? 1 : -1);
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (ignoreNavigation) return;

    if (event.key === "Escape" && selectedThreadKeysSize > 0) {
      event.preventDefault();
      clearSelection();
      return;
    }

    if (command === "thread.pinToggle") {
      if (!activeThread) return;
      event.preventDefault();
      event.stopPropagation();
      void toggleThreadPin({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, activeThread.id)),
        threadTitle: activeThread.title,
        confirmUnpin: confirmThreadUnpin,
      });
      return;
    }

    const threadActionContext = {
      activeContextIsChat,
      activeDraftThread,
      activeThread,
      chatTarget,
      defaultProjectRef,
      defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: defaultThreadEnvMode,
      }),
      handleNewChat,
      handleNewThread,
    };

    if (command === "chat.newWithoutProject") {
      // Unavailable chats leave the key to the focused control.
      if (!chatTarget) return;
      event.preventDefault();
      event.stopPropagation();
      void startNewChatFromContext(threadActionContext);
      return;
    }

    if (command === "chat.newLocal") {
      event.preventDefault();
      event.stopPropagation();
      void startNewLocalThreadFromContext(threadActionContext);
      return;
    }

    if (command === "chat.new") {
      event.preventDefault();
      event.stopPropagation();
      void startNewThreadFromContext(threadActionContext);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, []);

  return null;
}

/**
 * The `/_chat` layout body: the chat-wide keyboard shortcuts around the
 * outlet. It lives outside the route file so the stores and thread actions the
 * shortcuts read load with the shell graph instead of the boot chunk.
 */
export function ChatLayoutRoute() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}
