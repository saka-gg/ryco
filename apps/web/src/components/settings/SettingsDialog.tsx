// apps/web/src/components/settings/SettingsDialog.tsx
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArchiveIcon,
  BarChart3Icon,
  BlocksIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  MonitorIcon,
  PaletteIcon,
  PlugZapIcon,
  RotateCcwIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
  UserRoundIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import { type SettingsSectionId, useSettingsDialogStore } from "../../settingsDialogStore";
import { cn } from "../../lib/utils";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";
import {
  hostedSettingsRoleFresh,
  hostedSettingsRoleSnapshot,
  settingsSectionReachable,
  settingsSectionScope,
  settingsScopeLabel,
} from "./settingsSections.logic";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { ArchivedThreadsPanel, GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";
import { isElectron, isHostedHubMode } from "../../env";
import { useHostedHubStore } from "../../hostedHub/state";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useServerConfig } from "../../rpc/serverState";
import { useStore } from "../../store";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  resolveSettingsTargetEnvironmentId,
  SettingsTargetProvider,
  type SettingsTarget,
} from "../../settingsTarget";

interface NavItem {
  id: SettingsSectionId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { id: "account", label: "Account", icon: UserRoundIcon },
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "inbox", label: "Inbox", icon: SparklesIcon },
  { id: "providers", label: "Providers", icon: BlocksIcon },
  { id: "opinionated-plugins", label: "Plugins", icon: PlugZapIcon },
  { id: "mcp-servers", label: "Integrations", icon: ServerIcon },
  { id: "computer-use", label: "Computer use", icon: MonitorIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon },
  { id: "source-control", label: "Source Control", icon: GitBranchIcon },
  { id: "connections", label: "Connections", icon: Link2Icon },
  { id: "security", label: "Security", icon: ShieldIcon },
  { id: "diagnostics", label: "Diagnostics", icon: ActivityIcon },
  { id: "statistics", label: "Statistics", icon: BarChart3Icon },
  { id: "archived", label: "Archive", icon: ArchiveIcon },
];

/**
 * Every section this dialog can navigate to.
 *
 * Exported so `PhoneSettingsSurface`'s mirrored registry can be checked against
 * it rather than trusted: a section added here and not there is unreachable on
 * every phone-tier presentation, and `openSettings(id)` for it falls back to the
 * list with no error.
 */
export const SETTINGS_DIALOG_SECTION_IDS: ReadonlyArray<SettingsSectionId> = NAV_ITEMS.map(
  (item) => item.id,
);

/**
 * The section labels this dialog draws, by id.
 *
 * Exported so copy that NAMES a section can be held to the label the nav
 * actually shows: §13.5's `E2EE_WEB_SAS_MORE` sends an owner to
 * "Settings → Security", and `SettingsDialog.test.ts` reads this map to fail
 * that pointer if the section is ever renamed underneath it.
 */
export const SETTINGS_DIALOG_SECTION_LABELS: ReadonlyMap<SettingsSectionId, string> = new Map(
  NAV_ITEMS.map((item) => [item.id, item.label] as const),
);

// The gates themselves live in `settingsSections.logic.ts`, because
// `HostedE2eeVerification` — which sits in the eagerly loaded shell — has to ask
// the same question before it points a reader at Settings → Security, and this
// module is behind a dynamic import on purpose. Re-exported here so the two nav
// surfaces and their tests keep importing them from where they already do.
export {
  hostedSettingsRoleFresh,
  hostedSettingsRoleSnapshot,
  hostedSettingsSectionAllowed,
  settingsSectionAvailable,
  settingsSectionReachable,
  settingsSectionScope,
  settingsScopeLabel,
} from "./settingsSections.logic";

const SECTIONS_WITH_RESTORE: ReadonlySet<SettingsSectionId> = new Set([
  "general",
  "providers",
  "appearance",
]);

const LazyAccountSettingsPanel = lazy(() =>
  import("./AccountSettings").then((module) => ({
    default: module.AccountSettingsPanel,
  })),
);
const LazyProvidersSettingsPanel = lazy(() =>
  import("./ProvidersSettingsPanel").then((module) => ({
    default: module.ProvidersSettingsPanel,
  })),
);
const LazyAiFocusSettings = lazy(() =>
  import("./AiFocusSettings").then((module) => ({
    default: module.AiFocusSettings,
  })),
);
const LazyOpinionatedPluginsSettingsPanel = lazy(() =>
  import("./OpinionatedPluginsSettings").then((module) => ({
    default: module.OpinionatedPluginsSettingsPanel,
  })),
);
const LazyIntegrationsSettings = lazy(() =>
  import("./IntegrationsSettingsPanel").then((module) => ({
    default: module.IntegrationsSettingsPanel,
  })),
);
const LazyComputerUseSettings = lazy(() =>
  import("./ComputerUseSettings").then((module) => ({ default: module.ComputerUseSettings })),
);
const LazyAppearanceSettingsPanel = lazy(() =>
  import("./AppearanceSettings").then((module) => ({
    default: module.AppearanceSettingsPanel,
  })),
);
const LazyKeybindingsSettingsPanel = lazy(() =>
  import("./KeybindingsSettings").then((module) => ({
    default: module.KeybindingsSettingsPanel,
  })),
);
const LazySourceControlSettingsPanel = lazy(() =>
  import("./SourceControlSettings").then((module) => ({
    default: module.SourceControlSettingsPanel,
  })),
);
const LazyConnectionsSettings = lazy(() =>
  import("./ConnectionsSettings").then((module) => ({
    default: module.ConnectionsSettings,
  })),
);
const LazyNodeSecuritySettings = lazy(() =>
  import("./NodeSecuritySettings").then((module) => ({
    default: module.NodeSecuritySettings,
  })),
);
const LazyDiagnosticsSettings = lazy(() =>
  import("./DiagnosticsSettings").then((module) => ({
    default: module.DiagnosticsSettings,
  })),
);
const LazyStatisticsPanel = lazy(() =>
  import("./StatisticsSettingsLink").then((module) => ({
    default: module.StatisticsSettingsLink,
  })),
);

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="size-3.5" />
      Restore defaults
    </Button>
  );
}

function SectionPanel({
  section,
  searchTargetId,
}: {
  section: SettingsSectionId;
  searchTargetId: string | null;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-80 items-center justify-center text-muted-foreground text-sm">
          Loading settings...
        </div>
      }
    >
      {section === "account" ? <LazyAccountSettingsPanel /> : null}
      {section === "general" ? <GeneralSettingsPanel searchTargetId={searchTargetId} /> : null}
      {section === "inbox" ? <LazyAiFocusSettings /> : null}
      {section === "providers" ? <LazyProvidersSettingsPanel /> : null}
      {section === "opinionated-plugins" ? <LazyOpinionatedPluginsSettingsPanel /> : null}
      {section === "mcp-servers" ? <LazyIntegrationsSettings /> : null}
      {section === "computer-use" ? <LazyComputerUseSettings /> : null}
      {section === "appearance" ? <LazyAppearanceSettingsPanel /> : null}
      {section === "keybindings" ? <LazyKeybindingsSettingsPanel /> : null}
      {section === "source-control" ? <LazySourceControlSettingsPanel /> : null}
      {section === "connections" ? <LazyConnectionsSettings /> : null}
      {section === "security" ? <LazyNodeSecuritySettings /> : null}
      {section === "diagnostics" ? <LazyDiagnosticsSettings /> : null}
      {section === "statistics" ? <LazyStatisticsPanel /> : null}
      {section === "archived" ? <ArchivedThreadsPanel /> : null}
    </Suspense>
  );
}

export function SettingsDialog() {
  const navigate = useNavigate();
  const routedEnvironmentId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.environmentId ?? null,
  });
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const primaryServerConfig = useServerConfig();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const desktopWorkspace = useDesktopWorkspaceState();
  const open = useSettingsDialogStore((s) => s.open);
  const section = useSettingsDialogStore((s) => s.section);
  const requestedEnvironmentId = useSettingsDialogStore((s) => s.targetEnvironmentId);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const setSection = useSettingsDialogStore((s) => s.setSection);
  const targetEnvironmentId = resolveSettingsTargetEnvironmentId({
    requestedEnvironmentId,
    routedEnvironmentId,
    activeEnvironmentId,
    primaryEnvironmentId: primaryEnvironment?.environmentId ?? null,
  });
  const savedEnvironment = useSavedEnvironmentRegistryStore((state) =>
    targetEnvironmentId ? (state.byId[targetEnvironmentId] ?? null) : null,
  );
  const savedEnvironmentRuntime = useSavedEnvironmentRuntimeStore((state) =>
    targetEnvironmentId ? (state.byId[targetEnvironmentId] ?? null) : null,
  );
  const targetIsPrimary =
    targetEnvironmentId !== null && targetEnvironmentId === primaryEnvironment?.environmentId;
  const desktopWorkspaceMachine = targetEnvironmentId
    ? (desktopWorkspace.machines.find((machine) => machine.environmentId === targetEnvironmentId) ??
      null)
    : null;
  const targetServerConfig = targetIsPrimary
    ? primaryServerConfig
    : (savedEnvironmentRuntime?.serverConfig ?? null);
  const targetNodeLabel = targetIsPrimary
    ? (primaryEnvironment?.label ?? targetServerConfig?.environment.label ?? "Current node")
    : (savedEnvironmentRuntime?.descriptor?.label ??
      targetServerConfig?.environment.label ??
      savedEnvironment?.label ??
      desktopWorkspaceMachine?.label ??
      "Selected node");
  const settingsTarget: SettingsTarget | null = targetEnvironmentId
    ? {
        environmentId: targetEnvironmentId,
        nodeLabel: targetNodeLabel,
        serverConfig: targetServerConfig,
        primary: targetIsPrimary,
        connected: targetIsPrimary
          ? targetServerConfig !== null
          : savedEnvironmentRuntime?.connectionState === "connected" ||
            desktopWorkspaceMachine?.connectionState === "connected",
      }
    : null;
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedTransportStatus = useHostedHubStore((state) => state.transportStatus);
  const hosted = isHostedHubMode();
  const roleFresh = hostedSettingsRoleFresh(hostedDirectoryStatus, hostedTransportStatus);
  const role = hostedSettingsRoleSnapshot(hostedRole, hostedDirectoryStatus, hostedTransportStatus);
  const visibleNavItems = NAV_ITEMS.filter((item) =>
    settingsSectionReachable(item.id, {
      hosted,
      role,
      desktop: isElectron && Boolean(window.desktopBridge?.computerUse),
    }),
  );
  const effectiveSection = visibleNavItems.some((item) => item.id === section)
    ? section
    : (visibleNavItems[0]?.id ?? "appearance");
  const activeScope = settingsSectionScope(effectiveSection);
  const scopeLabel = settingsScopeLabel(activeScope, {
    nativeClient: isElectron,
    nodeLabel: settingsTarget?.nodeLabel ?? null,
  });

  useEffect(() => {
    if (hosted && !roleFresh) return;
    if (open && section !== effectiveSection) setSection(effectiveSection);
  }, [effectiveSection, hosted, open, roleFresh, section, setSection]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchTargetId, setSearchTargetId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setSearchQuery("");
      setSearchTargetId(null);
    }
  }, [open]);
  const visibleSectionIds = new Set(visibleNavItems.map((item) => item.id));
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchResults =
    normalizedQuery.length === 0
      ? []
      : SETTINGS_SEARCH_INDEX.filter(
          (entry) =>
            visibleSectionIds.has(entry.section) &&
            `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
              .toLowerCase()
              .includes(normalizedQuery),
        );
  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => {
    setRestoreSignal((v) => v + 1);
  }, []);

  const showRestore = SECTIONS_WITH_RESTORE.has(effectiveSection);
  const activeSectionIndex = Math.max(
    0,
    visibleNavItems.findIndex((item) => item.id === effectiveSection),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeSettings();
      }}
    >
      <SettingsTargetProvider value={settingsTarget}>
        <DialogPopup
          className="project-glass-surface h-[min(88dvh,880px)] max-w-[1180px] overflow-hidden p-0"
          bottomStickOnMobile={false}
          showCloseButton={true}
          surface="glass"
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex shrink-0 items-baseline gap-2">
                <DialogTitle className="text-base font-semibold">Settings</DialogTitle>
                <span
                  data-testid="settings-scope-label"
                  className="max-w-48 truncate text-xs text-muted-foreground"
                >
                  {scopeLabel}
                </span>
              </div>
              <div className="relative w-72 max-w-[40vw]">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchTargetId(null);
                    setSearchQuery(event.target.value);
                  }}
                  placeholder="Search settings…"
                  aria-label="Search settings"
                  className="h-8 w-full rounded-md border border-input bg-muted/40 pr-3 pl-8 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 pr-9">
              {showRestore ? <RestoreDefaultsButton onRestored={handleRestored} /> : null}
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-row">
            <nav className="relative isolate flex w-12 shrink-0 flex-col gap-1 border-r border-border p-2 sm:w-48">
              <span
                className="pointer-events-none absolute top-2 right-2 left-2 z-0 h-9 rounded-md bg-accent transition-transform duration-[240ms] ease-out"
                style={{
                  transform: `translateY(${activeSectionIndex * 2.5}rem)`,
                }}
                aria-hidden
              />
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = effectiveSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSearchTargetId(null);
                      setSection(item.id);
                    }}
                    className={cn(
                      "relative z-10 flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-hidden ring-ring transition-colors duration-150 focus-visible:ring-2",
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted-foreground/70 hover:text-foreground/80",
                    )}
                    aria-label={item.label}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        isActive ? "text-foreground" : "text-muted-foreground/60",
                      )}
                    />
                    <span className="hidden truncate sm:inline">{item.label}</span>
                  </button>
                );
              })}
            </nav>

            <ScrollArea className="min-h-0 min-w-0 flex-1">
              {normalizedQuery.length > 0 ? (
                <div className="p-4">
                  <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card p-1.5 shadow-sm/4">
                    {searchResults.length === 0 ? (
                      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                        No settings match “{searchQuery.trim()}”.
                      </p>
                    ) : (
                      searchResults.map((entry) => {
                        const sectionLabel = visibleNavItems.find(
                          (item) => item.id === entry.section,
                        )?.label;
                        return (
                          <button
                            key={`${entry.section}:${entry.title}`}
                            type="button"
                            onClick={() => {
                              if (entry.section === "statistics") {
                                closeSettings();
                                void navigate({ to: "/statistics" });
                                return;
                              }
                              setSearchTargetId(entry.targetId ?? null);
                              setSection(entry.section);
                              setSearchQuery("");
                            }}
                            className="flex flex-col gap-0.5 rounded-md px-3 py-2.5 text-left outline-hidden ring-ring transition-colors hover:bg-accent focus-visible:ring-2"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="text-sm font-medium">{entry.title}</span>
                              {sectionLabel ? (
                                <span className="text-[11px] text-muted-foreground/70">
                                  {sectionLabel}
                                </span>
                              ) : null}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {entry.description}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                <div key={restoreSignal} className="flex flex-col">
                  <SectionPanel section={effectiveSection} searchTargetId={searchTargetId} />
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogPopup>
      </SettingsTargetProvider>
    </Dialog>
  );
}
