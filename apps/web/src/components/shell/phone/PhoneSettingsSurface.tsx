import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BlocksIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  PlugZapIcon,
  RotateCcwIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";

import { type SettingsSectionId, useSettingsDialogStore } from "../../../settingsDialogStore";
import { isHostedHubMode } from "../../../env";
import { useHostedHubStore } from "../../../hostedHub/state";
import {
  hostedSettingsRoleSnapshot,
  settingsSectionReachable,
} from "../../settings/settingsSections.logic";
import {
  ArchivedThreadsPanel,
  GeneralSettingsPanel,
  useSettingsRestore,
} from "../../settings/SettingsPanels";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { Sheet, SheetPopup } from "../../ui/sheet";
import { PhoneAppearanceSettings } from "./PhoneAppearanceSettings";

interface PhoneSettingsItem {
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * The same section inventory the desktop dialog navigates (labels and order
 * match `SettingsPage`'s `NAV_ITEMS`), split for the phone list into the
 * general group and the progressive-disclosure "Advanced" group. Diagnostics
 * hosts the development-only tier-preview override, which stays gated inside
 * `DiagnosticsSettings` behind `import.meta.env.DEV` — grouping it under
 * Advanced changes reachability, never gating. The registry is mirrored rather
 * than imported so the two surfaces can group and order independently.
 *
 * THE MIRROR IS CHECKED RATHER THAN TRUSTED. A section added to the desktop
 * dialog and not here is unreachable on every phone-tier presentation — below
 * 768px, on a coarse-pointer device under 500px tall, and in the hosted PWA on
 * a phone — and a programmatic `openSettings(id)` for it falls silently back to
 * the list, because `ALL_ITEMS.find` returns undefined. That is exactly what
 * happened to `security`. {@link PHONE_SETTINGS_SECTION_IDS} is exported so
 * `SettingsPage.test.ts` can assert the two inventories agree, which no
 * "every label in this array is present" test could.
 */
const GENERAL_ITEMS: ReadonlyArray<PhoneSettingsItem> = [
  { id: "account", label: "Account", icon: UserRoundIcon },
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "inbox", label: "Inbox", icon: SparklesIcon },
  { id: "providers", label: "Providers", icon: BlocksIcon },
  { id: "opinionated-plugins", label: "Plugins", icon: PlugZapIcon },
  { id: "mcp-servers", label: "MCP Servers", icon: ServerIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon },
  { id: "source-control", label: "Source Control", icon: GitBranchIcon },
  { id: "connections", label: "Connections", icon: Link2Icon },
  { id: "security", label: "Security", icon: ShieldIcon },
  { id: "statistics", label: "Statistics", icon: BarChart3Icon },
  { id: "archived", label: "Archive", icon: ArchiveIcon },
];

const ADVANCED_ITEMS: ReadonlyArray<PhoneSettingsItem> = [
  { id: "diagnostics", label: "Diagnostics", icon: ActivityIcon },
];

const ALL_ITEMS: ReadonlyArray<PhoneSettingsItem> = [...GENERAL_ITEMS, ...ADVANCED_ITEMS];

/** Every section this surface can navigate to, for the mirror check. */
export const PHONE_SETTINGS_SECTION_IDS: ReadonlyArray<SettingsSectionId> = ALL_ITEMS.map(
  (item) => item.id,
);

/** The resting list's labels, in order, for the phone browser suite. */
export const PHONE_SETTINGS_GENERAL_LABELS: ReadonlyArray<string> = GENERAL_ITEMS.map(
  (item) => item.label,
);

const SECTIONS_WITH_RESTORE: ReadonlySet<SettingsSectionId> = new Set([
  "general",
  "providers",
  "appearance",
]);

/** The closed-store default; used to detect open-to-section deep links. */
const DEFAULT_SECTION: SettingsSectionId = "general";

const LazyAccountSettingsPanel = lazy(() =>
  import("../../settings/AccountSettings").then((module) => ({
    default: module.AccountSettingsPanel,
  })),
);
const LazyProvidersSettingsPanel = lazy(() =>
  import("../../settings/ProvidersSettingsPanel").then((module) => ({
    default: module.ProvidersSettingsPanel,
  })),
);
const LazyAiFocusSettings = lazy(() =>
  import("../../settings/AiFocusSettings").then((module) => ({
    default: module.AiFocusSettings,
  })),
);
const LazyOpinionatedPluginsSettingsPanel = lazy(() =>
  import("../../settings/OpinionatedPluginsSettings").then((module) => ({
    default: module.OpinionatedPluginsSettingsPanel,
  })),
);
const LazyMcpServersSettings = lazy(() =>
  import("../../settings/McpServersSettings").then((module) => ({
    default: module.McpServersSettings,
  })),
);
const LazyAppearanceSettingsPanel = lazy(() =>
  import("../../settings/AppearanceSettings").then((module) => ({
    default: module.AppearanceSettingsPanel,
  })),
);
const LazyKeybindingsSettingsPanel = lazy(() =>
  import("../../settings/KeybindingsSettings").then((module) => ({
    default: module.KeybindingsSettingsPanel,
  })),
);
const LazySourceControlSettingsPanel = lazy(() =>
  import("../../settings/SourceControlSettings").then((module) => ({
    default: module.SourceControlSettingsPanel,
  })),
);
const LazyConnectionsSettings = lazy(() =>
  import("../../settings/ConnectionsSettings").then((module) => ({
    default: module.ConnectionsSettings,
  })),
);
const LazyNodeSecuritySettings = lazy(() =>
  import("../../settings/NodeSecuritySettings").then((module) => ({
    default: module.NodeSecuritySettings,
  })),
);
const LazyDiagnosticsSettings = lazy(() =>
  import("../../settings/DiagnosticsSettings").then((module) => ({
    default: module.DiagnosticsSettings,
  })),
);
const LazyStatisticsPanel = lazy(() =>
  import("../../settings/StatisticsPanel").then((module) => ({
    default: module.StatisticsPanel,
  })),
);

function SectionPanel({ section }: { section: SettingsSectionId }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-80 items-center justify-center text-muted-foreground text-sm">
          Loading settings...
        </div>
      }
    >
      {section === "account" ? <LazyAccountSettingsPanel /> : null}
      {section === "general" ? <GeneralSettingsPanel /> : null}
      {section === "inbox" ? <LazyAiFocusSettings /> : null}
      {section === "providers" ? <LazyProvidersSettingsPanel /> : null}
      {section === "opinionated-plugins" ? <LazyOpinionatedPluginsSettingsPanel /> : null}
      {section === "mcp-servers" ? <LazyMcpServersSettings /> : null}
      {section === "appearance" ? <LazyAppearanceSettingsPanel /> : null}
      {section === "keybindings" ? <LazyKeybindingsSettingsPanel /> : null}
      {section === "source-control" ? <LazySourceControlSettingsPanel /> : null}
      {section === "connections" ? <LazyConnectionsSettings /> : null}
      {section === "security" ? <LazyNodeSecuritySettings /> : null}
      {section === "diagnostics" ? <LazyDiagnosticsSettings presentation="phone-legacy" /> : null}
      {section === "statistics" ? <LazyStatisticsPanel /> : null}
      {section === "archived" ? <ArchivedThreadsPanel /> : null}
    </Suspense>
  );
}

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="sm"
      variant="outline"
      className="min-h-11 shrink-0"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

/**
 * Full-screen popup covering the entire viewport (matching the phone
 * work-surface contract): safe-area top/bottom/side padding, and the bottom
 * inset composes with the keyboard inset so form controls inside settings
 * sections stay reachable above an open software keyboard.
 */
const PHONE_SETTINGS_SURFACE_CLASS_NAME =
  "w-full min-w-0 max-w-none border-s-0 p-0 pt-safe pl-safe pr-safe pb-[max(env(safe-area-inset-bottom),var(--app-keyboard-inset,0px))] wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

/**
 * The phone-tier settings presentation (delivery step 9 of the focused mobile
 * workspace design): a full-screen paged experience replacing the desktop
 * dialog's icon-only collapsed rail. A labeled section list (44px rows,
 * general sections first, an "Advanced" disclosure for diagnostics) pushes the
 * selected section full-width with a back-to-list affordance.
 *
 * The settings dialog store stays the single source of truth: rows call
 * `setSection`, open-to-section flows (`openSettings("connections")` from
 * menus and empty states) land directly on the section page, and Escape
 * closes the whole surface — the same contract as the desktop dialog. Section
 * components render unchanged.
 */
export function PhoneSettingsSurface() {
  const open = useSettingsDialogStore((s) => s.open);
  const storeSection = useSettingsDialogStore((s) => s.section);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const setSection = useSettingsDialogStore((s) => s.setSection);
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedTransportStatus = useHostedHubStore((state) => state.transportStatus);
  const hosted = isHostedHubMode();
  const role = hostedSettingsRoleSnapshot(hostedRole, hostedDirectoryStatus, hostedTransportStatus);
  const sectionAllowed = useCallback(
    (id: SettingsSectionId) => settingsSectionReachable(id, { hosted, role }),
    [hosted, role],
  );
  const generalItems = GENERAL_ITEMS.filter((item) => sectionAllowed(item.id));
  const advancedItems = ADVANCED_ITEMS.filter((item) => sectionAllowed(item.id));

  // The list is the resting view; a non-null pushed section renders the
  // full-width section page. The store's `section` value stays canonical —
  // this only tracks whether the section page is on top of the list.
  const [pushedSection, setPushedSection] = useState<SettingsSectionId | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // Deep-link detection without store changes: on close the stored section
  // resets to the default (below), so an opening call that carries a
  // non-default section is an open-to-section deep link and lands directly on
  // the section page, while a generic `openSettings()` lands on the list.
  // Derived during render (not in an effect) so the first open paint already
  // shows the right view. Unlike the desktop rail, the phone list does not
  // restore the previously visited section on a generic reopen.
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setPushedSection(storeSection !== DEFAULT_SECTION ? storeSection : null);
      setAdvancedExpanded(false);
    }
  }

  // Open-to-section calls while the surface is already open (menus can call
  // `openSettings(section)` at any time) push that section's page.
  const prevSectionRef = useRef(storeSection);
  useEffect(() => {
    const previousSection = prevSectionRef.current;
    prevSectionRef.current = storeSection;
    if (!open) return;
    if (storeSection !== previousSection) {
      setPushedSection(storeSection);
    }
  }, [open, storeSection]);

  // On close, reset the canonical section so the next deep link is
  // distinguishable from a generic open. `pushedSection` is intentionally
  // left in place while the exit transition plays; the next open recomputes
  // it before paint.
  useEffect(() => {
    if (open) return;
    if (useSettingsDialogStore.getState().section !== DEFAULT_SECTION) {
      setSection(DEFAULT_SECTION);
      prevSectionRef.current = DEFAULT_SECTION;
    }
  }, [open, setSection]);

  // Focus management: pushing a section moves focus to its heading (the
  // section announces itself); popping back returns focus to the list row the
  // user came from. Deferred a frame so it lands after the popup's own focus
  // handling and after the target view has rendered.
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const listRowRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>());
  const lastPushedSectionRef = useRef<SettingsSectionId | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  // The dialog primitive re-captures focus onto the popup when the focused
  // element (the tapped row, or the section's back button) leaves the DOM, on
  // its own asynchronous schedule. Retry across a few frames until our
  // intentional target holds focus, then stop; if the surface closes in the
  // meantime the target disconnects and the loop ends without stealing focus.
  const scheduleFocus = useCallback((resolve: () => HTMLElement | null) => {
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current);
    }
    let attempts = 0;
    let heldFrames = 0;
    const tick = () => {
      focusFrameRef.current = null;
      const element = resolve();
      if (!element || !element.isConnected) {
        return;
      }
      if (document.activeElement === element) {
        heldFrames += 1;
        if (heldFrames >= 2) {
          return;
        }
      } else {
        heldFrames = 0;
        element.focus();
        attempts += 1;
        if (attempts >= 6) {
          return;
        }
      }
      focusFrameRef.current = window.requestAnimationFrame(tick);
    };
    focusFrameRef.current = window.requestAnimationFrame(tick);
  }, []);
  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    };
  }, []);

  const pushSection = (id: SettingsSectionId) => {
    setSection(id);
    setPushedSection(id);
    scheduleFocus(() => sectionHeadingRef.current);
  };
  const popToList = () => {
    const returnTo = lastPushedSectionRef.current;
    setPushedSection(null);
    // Return the canonical section to the resting default while the list is
    // showing; otherwise a deep link back to the just-visited section would
    // be a store no-op and could not push the page again. The ref is synced
    // first so the change-watcher effect does not read this reset as an
    // external open-to-section call.
    prevSectionRef.current = DEFAULT_SECTION;
    setSection(DEFAULT_SECTION);
    scheduleFocus(() => (returnTo ? (listRowRefs.current.get(returnTo) ?? null) : null));
  };
  useEffect(() => {
    if (pushedSection !== null) {
      lastPushedSectionRef.current = pushedSection;
    }
  }, [pushedSection]);
  // Deep-link opens also move focus onto the section heading.
  useEffect(() => {
    if (open && pushedSection !== null) {
      scheduleFocus(() => sectionHeadingRef.current);
    }
  }, [open, pushedSection, scheduleFocus]);

  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => {
    setRestoreSignal((value) => value + 1);
  }, []);

  const activeItem =
    pushedSection !== null && sectionAllowed(pushedSection)
      ? (ALL_ITEMS.find((item) => item.id === pushedSection) ?? null)
      : null;

  const renderRow = (item: PhoneSettingsItem) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        ref={(element) => {
          if (element) {
            listRowRefs.current.set(item.id, element);
          } else {
            listRowRefs.current.delete(item.id);
          }
        }}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => pushSection(item.id)}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
      </button>
    );
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeSettings();
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        aria-label="Settings"
        data-testid="phone-settings-surface"
        className={PHONE_SETTINGS_SURFACE_CLASS_NAME}
      >
        {activeItem ? (
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background">
            <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-card/40 px-2">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Back to settings"
                className="shrink-0"
                onClick={popToList}
              >
                <ArrowLeftIcon />
              </Button>
              <h1
                ref={sectionHeadingRef}
                tabIndex={-1}
                className="min-w-0 flex-1 truncate text-sm font-medium outline-none"
              >
                {activeItem.label}
              </h1>
              {SECTIONS_WITH_RESTORE.has(activeItem.id) ? (
                <RestoreDefaultsButton onRestored={handleRestored} />
              ) : null}
            </div>
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              {/* Panels no longer pad themselves; the host owns the gutter. */}
              <div key={restoreSignal} className="flex flex-col p-6">
                <SectionPanel section={activeItem.id} />
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background">
            <div className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-card/40 px-2">
              <h1 className="min-w-0 flex-1 truncate px-2 text-base font-semibold">Settings</h1>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close settings"
                className="shrink-0"
                onClick={closeSettings}
              >
                <XIcon />
              </Button>
            </div>
            <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto p-2">
              <div role="group" aria-label="Settings sections" className="space-y-0.5">
                {generalItems.map((item) => renderRow(item))}
              </div>
              {advancedItems.length > 0 ? (
                <div className="mt-2 border-t border-border pt-2">
                  <button
                    type="button"
                    aria-expanded={advancedExpanded}
                    className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setAdvancedExpanded((expanded) => !expanded)}
                  >
                    {advancedExpanded ? (
                      <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
                    ) : (
                      <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">Advanced</span>
                  </button>
                  {advancedExpanded ? (
                    <div role="group" aria-label="Advanced sections" className="space-y-0.5">
                      {advancedItems.map((item) => renderRow(item))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {/* The phone appearance group: tier-specific presentation
                  controls that stay on the list rather than inside a section
                  page, because they are the ones a phone user changes on the
                  device. They write the same appearance preference keys the
                  desktop Appearance section writes. */}
              <div className="mt-2 border-t border-border pt-2">
                <h2 className="px-2 py-1 font-medium text-muted-foreground text-xs">
                  Phone appearance
                </h2>
                <PhoneAppearanceSettings />
              </div>
            </nav>
          </div>
        )}
      </SheetPopup>
    </Sheet>
  );
}
