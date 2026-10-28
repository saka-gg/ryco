"use client";

import { WS_METHODS } from "@ryco/contracts";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";

import { useAppKeybindings } from "../appKeybindings";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import {
  resolveShortcutCommand,
  shouldIgnoreGlobalNavigationShortcut,
  shouldIgnoreSplitViewShortcut,
} from "../keybindings";
import { isComposerFocused } from "../lib/composerFocus";
import { stepNavigationHistory } from "../lib/navigationHistory";
import { getPresentationTier } from "../lib/presentationTier";
import { preloadableLazy, useLazyComponentReady } from "../lib/preloadableLazy";
import { isTerminalFocused } from "../lib/terminalFocus";
import { buildProjectsPageLocation } from "../projectsRoute";
import { buildPullRequestsPageLocation } from "../pullRequestsRoute";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { CommandDialog } from "./ui/command";

const CommandPaletteDialog = preloadableLazy(() =>
  import("./CommandPaletteDialog").then((module) => module.CommandPaletteDialog),
);

/**
 * Warms the palette dialog chunk so the first open renders without a round
 * trip. Resolves once the load settled; never rejects.
 */
export function preloadCommandPaletteDialog(): Promise<void> {
  return CommandPaletteDialog.preload();
}

function LazyCommandPaletteDialogMount() {
  const open = useCommandPaletteStore((store) => store.open);
  const [hasOpened, setHasOpened] = useState(open);
  // Derived during render: an effect added a commit before the import started.
  if (open && !hasOpened) setHasOpened(true);
  // Mounting only once the chunk resolved keeps the first open free of a
  // committed Suspense fallback and React's fallback-reveal throttle.
  const ready = useLazyComponentReady(CommandPaletteDialog, hasOpened);

  if (!hasOpened || !ready) {
    return null;
  }

  return <CommandPaletteDialog />;
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
  const router = useRouter();
  // `pullRequests.open` and `projects.open` (no default keys) open their pages
  // wherever the user is.
  // hosted-capability: routed node
  const pullRequestsAllowed = useHostedRpcCapability(
    WS_METHODS.sourceControlListChangeRequests,
    null,
  ).allowed;
  // hosted-capability: routed node
  const projectsAllowed = useHostedRpcCapability(WS_METHODS.projectsList, null).allowed;
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
      const ignoreNavigation = !commandPaletteOpen && shouldIgnoreGlobalNavigationShortcut(event);
      const composerFocus = isComposerFocused();
      // Back and forward also run while typing in the composer, whose draft
      // outlives the page. Other text fields would lose theirs, so they keep
      // the key.
      if (ignoreNavigation && !composerFocus) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          composerFocus,
        },
      });
      if (command === "navigation.back" || command === "navigation.forward") {
        if (commandPaletteOpen || shouldIgnoreSplitViewShortcut(event)) return;
        if (getPresentationTier() === "phone") return;
        // Consumed even with nowhere to go, so the browser's own Back never
        // leaves the app; a held key moves one page only.
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        stepNavigationHistory(router.history, command === "navigation.back" ? "back" : "forward");
        return;
      }
      if (ignoreNavigation) return;
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
  }, [keybindings, navigate, router, setOpen, terminalOpen, toggleOpen]);

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
