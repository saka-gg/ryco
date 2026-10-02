import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { useEffect } from "react";

import { useChatPanesStore } from "../chatPanesStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isComposerFocused } from "../lib/composerFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useModelPickerOpen } from "../modelPickerOpenState";
import {
  isSplitViewCommand,
  resolveShortcutCommand,
  shouldIgnoreGlobalNavigationShortcut,
  shouldIgnoreSplitViewShortcut,
} from "../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";
import { toggleThreadPin } from "../threadPinning";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const modelPickerOpen = useModelPickerOpen();
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const ignoreNavigation = shouldIgnoreGlobalNavigationShortcut(event);
      if (ignoreNavigation && shouldIgnoreSplitViewShortcut(event)) return;
      // Read modal/palette state via `getState()` at event time so we always
      // see the latest value without having to re-bind the listener on every
      // toggle. The other booleans come from React-tracked stores or DOM
      // queries that are cheap enough to call per event.
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
          confirmUnpin: appSettings.confirmThreadUnpin,
        });
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    selectedThreadKeysSize,
    terminalOpen,
    modelPickerOpen,
    appSettings.defaultThreadEnvMode,
    appSettings.confirmThreadUnpin,
  ]);

  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
