"use client";

import { WS_METHODS } from "@ryco/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";

import { useAppKeybindings } from "../appKeybindings";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { resolveShortcutCommand, shouldIgnoreGlobalNavigationShortcut } from "../keybindings";
import { getPresentationTier } from "../lib/presentationTier";
import { isTerminalFocused } from "../lib/terminalFocus";
import { buildProjectsPageLocation } from "../projectsRoute";
import { buildPullRequestsPageLocation } from "../pullRequestsRoute";
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
  const navigate = useNavigate();
  // `pullRequests.open` and `projects.open` (no default keys) open their pages
  // wherever the user is.
  const pullRequestsAllowed = useHostedRpcCapability(
    WS_METHODS.sourceControlListChangeRequests,
  ).allowed;
  const projectsAllowed = useHostedRpcCapability(WS_METHODS.projectsList).allowed;
  const pageAllowedRef = useRef({ pullRequests: pullRequestsAllowed, projects: projectsAllowed });
  pageAllowedRef.current = { pullRequests: pullRequestsAllowed, projects: projectsAllowed };
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
      if (command === "pullRequests.open" || command === "projects.open") {
        const page = command === "projects.open" ? "projects" : "pullRequests";
        if (!pageAllowedRef.current[page] || getPresentationTier() === "phone") return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate(
          page === "projects" ? buildProjectsPageLocation() : buildPullRequestsPageLocation(),
        );
        return;
      }
      if (command !== "commandPalette.toggle") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate, setOpen, terminalOpen, toggleOpen]);

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
