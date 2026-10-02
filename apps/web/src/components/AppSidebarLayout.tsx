import { Schema } from "effect";
import { BarChart3Icon, PanelLeftOpenIcon, SettingsIcon } from "lucide-react";
import { WS_METHODS } from "@ryco/contracts";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";

import ThreadSidebar from "./Sidebar";
import { RycoLetterMark } from "./RycoLetterMark";
import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { usePresentationTier } from "../hooks/usePresentationTier";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { SettingsRouteBridge } from "./SettingsRouteBridge";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_OPEN_STORAGE_KEY = "chat_thread_sidebar_open";
// Desktop window controls need extra room beside the logo and essential header actions.
const THREAD_SIDEBAR_MIN_WIDTH = (isElectron ? 15 : 13) * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

function readPersistedThreadSidebarOpen(): boolean {
  try {
    return getLocalStorageItem(THREAD_SIDEBAR_OPEN_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch {
    return true;
  }
}

const LazyPhoneSettingsSurface = lazy(() =>
  import("./shell/phone/PhoneSettingsSurface").then((module) => ({
    default: module.PhoneSettingsSurface,
  })),
);

/**
 * Where settings are presented. Every tier but phone shows them as the
 * `/settings` page, kept in step with the settings store by
 * `SettingsRouteBridge`; the frozen phone tier keeps its full-screen sheet,
 * driven by the same store, so a mid-open tier flip re-presents the same
 * section in the other presentation.
 */
export function SettingsSurfaceMount() {
  const open = useSettingsDialogStore((s) => s.open);
  const presentationTier = usePresentationTier();
  // Mount the sheet's chunk on its first phone-tier open and keep it after, so
  // its close animation can run.
  const [phoneSheetMounted, setPhoneSheetMounted] = useState(false);
  if (open && presentationTier === "phone" && !phoneSheetMounted) setPhoneSheetMounted(true);

  return (
    <>
      <SettingsRouteBridge />
      {phoneSheetMounted && presentationTier === "phone" ? (
        <Suspense fallback={null}>
          <LazyPhoneSettingsSurface />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * Shell-wide global effects shared by every application shell tier: the
 * shortcut-modifier keydown/keyup/blur sync and the desktop-bridge
 * open-settings menu action. Mounted once by the active shell (desktop
 * sidebar layout or the phone shell) — never by both.
 */
export function useAppShellGlobalEffects(): void {
  const openSettings = useSettingsDialogStore((s) => s.openSettings);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        openSettings();
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [openSettings]);
}

/**
 * What survives a collapsed thread sidebar.
 *
 * Offcanvas collapse takes the whole sidebar — brand mark, settings, and the
 * collapse button itself — off screen, and the resize rail is deliberately
 * inert in that state. Rather than make every workspace surface host its own
 * copy of that chrome, the shell floats the essentials over the corner the
 * sidebar vacated, in the same order they sit in the sidebar header so
 * collapsing reads as the row compressing rather than being replaced.
 * Surfaces that own that corner reserve room with
 * `COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS`.
 *
 * Always mounted on the desktop tier and cross-faded rather than swapped in
 * and out. Mounting on collapse used to leave the corner empty for the whole
 * 200ms slide — the floating mark vanished the instant expanding began, while
 * the sidebar's own mark was still travelling in from off-screen, so the logo
 * read as blinking out and reappearing. Because this mark sits at exactly the
 * x its sidebar counterpart lands on, holding it through the slide and fading
 * it out as that one arrives keeps one continuous logo in the corner.
 */
function CollapsedAppSidebarChrome({ sidebarOpen }: { sidebarOpen: boolean }) {
  const { toggleSidebar } = useSidebar();
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const statisticsCapability = useHostedRpcCapability(WS_METHODS.serverGetStatistics);

  return (
    <div
      aria-hidden={sidebarOpen ? true : undefined}
      data-slot="collapsed-app-sidebar-chrome"
      inert={sidebarOpen ? true : undefined}
      className={cn(
        // The row itself is click-through so it never shadows the header
        // beneath it; only the controls take pointer events.
        // Electron hit-tests app drag regions independently of DOM pointer
        // events. This sibling overlay therefore needs its own no-drag
        // boundary or the title bar beneath it swallows the controls' clicks.
        "pointer-events-none fixed top-0 z-50 flex items-center gap-0.5 [-webkit-app-region:no-drag] phone:hidden",
        "transition-opacity ease-linear motion-reduce:transition-none",
        // Expanding holds the row at full opacity for the first half of the
        // sidebar's 200ms slide, then fades it out just as the sidebar's own
        // chrome reaches this spot. Collapsing fades straight in, since the
        // sidebar mark is still under it at that moment.
        sidebarOpen ? "opacity-0 delay-100 duration-100" : "opacity-100 duration-100",
        // The left offsets land the mark on exactly the x it occupies in the
        // expanded sidebar header (its padding plus the link's `ml-1`), so
        // collapsing never nudges the logo toward the window edge. In the
        // desktop shell that also clears the macOS traffic lights, or the
        // Window Controls Overlay origin on platforms that publish one.
        isElectron
          ? "left-[94px] h-[52px] wco:left-[calc(env(titlebar-area-x)+1.25rem)] wco:h-[env(titlebar-area-height)]"
          : "top-[env(safe-area-inset-top)] left-[calc(env(safe-area-inset-left)+1.25rem)] h-[52px]",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              // Sets the brand apart from the controls beside it; the two
              // controls stay tight to each other since they belong together.
              className="pointer-events-auto mr-2.5 flex cursor-pointer items-center rounded-md text-foreground outline-hidden ring-ring transition-opacity hover:opacity-80 focus-visible:ring-2"
              to="/"
            >
              <RycoLetterMark className="h-4.5" />
            </Link>
          }
        />
        <TooltipPopup side="bottom">
          {APP_BASE_NAME} {APP_STAGE_LABEL} · Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
      {/* Only the mark has a counterpart to hand off to, so only the mark
          needs to survive the whole slide. These two clear out early instead,
          before the sidebar's own settings and collapse buttons sweep through
          this corner on their way in — two sets of the same icons crossing
          over each other is the part that read as a rendering glitch. */}
      <div
        className={cn(
          "flex items-center gap-0.5 transition-opacity ease-linear motion-reduce:transition-none",
          sidebarOpen ? "opacity-0 duration-75" : "opacity-100 delay-75 duration-150",
        )}
      >
        {statisticsCapability.allowed ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  aria-label="Open statistics"
                  className="pointer-events-auto flex size-8 items-center justify-center rounded-md text-muted-foreground/72 hover:bg-accent hover:text-foreground"
                  to="/statistics"
                >
                  <BarChart3Icon className="size-4" />
                </Link>
              }
            />
            <TooltipPopup side="bottom">Statistics</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Settings"
                className="pointer-events-auto text-muted-foreground/72 hover:text-foreground"
                onClick={() => openSettings()}
                size="icon-sm"
                variant="ghost"
              >
                <SettingsIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Settings</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Show sidebar"
                className="pointer-events-auto text-muted-foreground/72 hover:text-foreground"
                onClick={toggleSidebar}
                size="icon-sm"
                variant="ghost"
              >
                <PanelLeftOpenIcon />
              </Button>
            }
          />
          <TooltipPopup side="bottom">Show sidebar</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The tier-aware application shell (delivery step 6 of the focused mobile
 * workspace design). The `SidebarProvider` context and the route subtree stay
 * mounted identically on both tiers — a tier flip (mid-size rotation, QA
 * override) must never remount the workspace and lose scroll, draft, or
 * panel state, and many components call `useSidebar()` unconditionally. Only
 * the sidebar chrome is tier-conditional: the desktop tier renders the
 * persistent thread sidebar; the phone tier renders no drawer — navigation is
 * URL-driven through the phone Home surface and the compact thread app bar.
 */
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  useAppShellGlobalEffects();
  const presentationTier = usePresentationTier();
  // Collapsing the sidebar is a deliberate layout choice, so it outlives the
  // session the same way the sidebar width does. The shell owns the state
  // (rather than `SidebarProvider`'s internal default) because the collapsed
  // layout also decides whether the floating re-open control renders.
  const [sidebarOpen, setSidebarOpen] = useState(readPersistedThreadSidebarOpen);
  const isDesktopTier = presentationTier === "desktop";
  const handleSidebarOpenChange = useCallback((open: boolean) => {
    setSidebarOpen(open);
    try {
      setLocalStorageItem(THREAD_SIDEBAR_OPEN_STORAGE_KEY, open, Schema.Boolean);
    } catch {
      // Ignore quota/storage failures — the collapse still applies this session.
    }
  }, []);

  return (
    <SidebarProvider
      className="h-dvh! min-h-0!"
      open={sidebarOpen}
      onOpenChange={handleSidebarOpenChange}
    >
      {/* Ambient base layer: a faint primary-derived tint behind the shell.
          Opaque content covers it entirely; it exists so translucent chrome
          (Material steps above Solid) frosts something other than a flat
          fill. Static gradient — no animation, no compositing cost. */}
      <div aria-hidden className="app-ambient fixed inset-0 pointer-events-none" />
      {isDesktopTier ? (
        <Sidebar
          side="left"
          collapsible="offcanvas"
          className="border-r border-sidebar-border text-sidebar-foreground"
          resizable={{
            minWidth: THREAD_SIDEBAR_MIN_WIDTH,
            shouldAcceptWidth: ({ nextWidth, wrapper }) =>
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          }}
        >
          <ThreadSidebar />
          <SidebarRail />
        </Sidebar>
      ) : null}
      {children}
      {isDesktopTier ? <CollapsedAppSidebarChrome sidebarOpen={sidebarOpen} /> : null}
      <SettingsSurfaceMount />
    </SidebarProvider>
  );
}
