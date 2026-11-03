import type { UnifiedSettings } from "@ryco/contracts/settings";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { useAppKeybindings } from "../appKeybindings";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { resolveShortcutCommand, shouldIgnoreGlobalNavigationShortcut } from "../keybindings";
import {
  startNewChatFromContext,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isComposerFocused } from "../lib/composerFocus";
import { getPresentationTier } from "../lib/presentationTier";
import { isTerminalFocused } from "../lib/terminalFocus";
import { getModelPickerOpen } from "../modelPickerOpenState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveSidebarNewThreadEnvMode } from "./Sidebar.logic";

const selectDefaultThreadEnvMode = (settings: UnifiedSettings) => settings.defaultThreadEnvMode;

/**
 * `chat.new`, `chat.newLocal` and `chat.newWithoutProject` on every page of the
 * app shell (threads, tasks, settings, pull requests, statistics), not only on
 * the chat routes. The frozen phone tier keeps them on its chat routes only.
 */
export function NewChatShortcuts() {
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
  const defaultThreadEnvMode = useSettings(selectDefaultThreadEnvMode);
  const router = useRouter();

  // The handler always sees the latest render's values, so the window
  // listener below binds once per mount instead of on every change.
  const onWindowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || shouldIgnoreGlobalNavigationShortcut(event)) return;
    if (useCommandPaletteStore.getState().open) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        terminalOpen: routeThreadRef
          ? selectThreadTerminalState(
              useTerminalStateStore.getState().terminalStateByThreadKey,
              routeThreadRef,
            ).terminalOpen
          : false,
        modelPickerOpen: getModelPickerOpen(),
        commandPaletteOpen: false,
        composerFocus: isComposerFocused(),
      },
    });
    if (
      command !== "chat.new" &&
      command !== "chat.newLocal" &&
      command !== "chat.newWithoutProject"
    ) {
      return;
    }
    if (
      getPresentationTier() === "phone" &&
      !router.state.matches.some((match) => match.routeId === "/_chat")
    ) {
      return;
    }
    // Unavailable chats leave the key to the focused control.
    if (command === "chat.newWithoutProject" && !chatTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const context = {
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
    if (command === "chat.newWithoutProject") void startNewChatFromContext(context);
    else if (command === "chat.newLocal") void startNewLocalThreadFromContext(context);
    else void startNewThreadFromContext(context);
  });

  useEffect(() => {
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, []);

  return null;
}
