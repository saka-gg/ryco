"use client";

import { useAppKeybindings } from "../appKeybindings";

import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { resolveShortcutCommand, shouldIgnoreGlobalNavigationShortcut } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { CommandDialog } from "./ui/command";

const LazyCommandPaletteDialog = lazy(() =>
  import("./CommandPaletteDialog").then((module) => ({
    default: module.CommandPaletteDialog,
  })),
);

function LazyCommandPaletteDialogMount() {
  const open = useCommandPaletteStore((store) => store.open);
  const [hasOpened, setHasOpened] = useState(open);

  useEffect(() => {
    if (open) {
      setHasOpened(true);
    }
  }, [open]);

  if (!hasOpened) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <LazyCommandPaletteDialog />
    </Suspense>
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const open = useCommandPaletteStore((store) => store.open);
  const setOpen = useCommandPaletteStore((store) => store.setOpen);
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const keybindings = useAppKeybindings();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const commandPaletteOpen = useCommandPaletteStore.getState().open;
      if (!commandPaletteOpen && shouldIgnoreGlobalNavigationShortcut(event)) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, terminalOpen, toggleOpen]);

  useEffect(() => {
    return () => {
      setOpen(false);
    };
  }, [setOpen]);

  return (
    <ComposerHandleContext.Provider value={composerHandleRef}>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {children}
        <LazyCommandPaletteDialogMount />
      </CommandDialog>
    </ComposerHandleContext.Provider>
  );
}
