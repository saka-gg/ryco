import { EnvironmentId, WS_METHODS } from "@ryco/contracts";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { navigateHub } from "../../hostedHub/hubRoutes";
import { useSettingsSubsections } from "./useSettingsSubsections";
// apps/web/src/components/settings/SettingsDialog.tsx
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
} from "react";
import { useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArchiveIcon,
  BarChart3Icon,
  BlocksIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
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
  settingsSectionInDestination,
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
import {
  retainDesktopWorkspaceInteractiveScope,
  useDesktopWorkspaceState,
} from "../../platform/desktopWorkspace";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  resolveSettingsTargetEnvironmentId,
  SettingsTargetProvider,
  SettingsEditingScopeProvider,
  useSettingsEditingScope,
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
  { id: "mcp-servers", label: "MCP", icon: ServerIcon },
  { id: "integrations", label: "Integrations", icon: PlugZapIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon },
  { id: "source-control", label: "Source Control", icon: GitBranchIcon },
  { id: "connections", label: "Connections", icon: Link2Icon },
  { id: "security", label: "Node security", icon: ShieldIcon },
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
const LazyMcpServersSettings = lazy(() =>
  import("./McpServersSettings").then((module) => ({ default: module.McpServersSettings })),
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
  const editingScope = useSettingsEditingScope();
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
      {section === "mcp-servers" ? <LazyMcpServersSettings /> : null}
      {section === "integrations" ? <LazyIntegrationsSettings /> : null}
      {section === "appearance" ? <LazyAppearanceSettingsPanel /> : null}
      {section === "keybindings" ? <LazyKeybindingsSettingsPanel /> : null}
      {section === "source-control" ? <LazySourceControlSettingsPanel /> : null}
      {section === "connections" ? (
        editingScope === "node" || isHostedHubMode() ? (
          <div className="space-y-5 p-6">
            <div className="space-y-1">
              <h1 className="text-base font-semibold">Connections</h1>
              <p className="text-sm text-muted-foreground">
                Ryco manages your connection automatically. Advanced details for this node are
                available below.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => useSettingsDialogStore.getState().setSection("security")}
            >
              <ShieldIcon className="size-4" />
              Node security · Advanced
            </Button>
          </div>
        ) : (
          <LazyConnectionsSettings />
        )
      ) : null}
      {section === "security" ? <LazyNodeSecuritySettings /> : null}
      {section === "diagnostics" ? <LazyDiagnosticsSettings /> : null}
      {section === "statistics" ? <LazyStatisticsPanel /> : null}
      {section === "archived" ? <ArchivedThreadsPanel /> : null}
    </Suspense>
  );
}

export function SettingsDialog() {
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
  const editingScope = useSettingsDialogStore((s) => s.editingScope);
  const setEditingScope = useSettingsDialogStore((s) => s.setEditingScope);
  const setTargetEnvironmentId = useSettingsDialogStore((s) => s.setTargetEnvironmentId);
  const allSavedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const nodeWriteCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const requestedEnvironmentId = useSettingsDialogStore((s) => s.targetEnvironmentId);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const setSection = useSettingsDialogStore((s) => s.setSection);
  const targetEnvironmentId = isHostedHubMode()
    ? (primaryEnvironment?.environmentId ?? null)
    : resolveSettingsTargetEnvironmentId({
        requestedEnvironmentId,
        routedEnvironmentId,
        activeEnvironmentId,
        primaryEnvironmentId: primaryEnvironment?.environmentId ?? null,
        desktopLocalEnvironmentId: isElectron ? desktopWorkspace.localEnvironmentId : null,
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
  const remoteRole = desktopWorkspaceMachine
    ? desktopWorkspaceMachine.canConnect
      ? desktopWorkspaceMachine.effectiveRole
      : null
    : savedEnvironmentRuntime?.role === "owner"
      ? "owner"
      : savedEnvironmentRuntime?.role
        ? "viewer"
        : null;
  const settingsTarget: SettingsTarget | null = targetEnvironmentId
    ? {
        environmentId: targetEnvironmentId,
        nodeLabel: targetNodeLabel,
        serverConfig: targetServerConfig,
        primary: targetIsPrimary,
        canManage: targetIsPrimary ? !isHostedHubMode() : remoteRole === "owner",
        canMutate:
          targetIsPrimary ||
          (desktopWorkspaceMachine
            ? desktopWorkspaceMachine.canMutate
            : savedEnvironmentRuntime?.role === "owner" ||
              savedEnvironmentRuntime?.role === "client"),
        connected:
          targetServerConfig !== null &&
          (targetIsPrimary ||
            savedEnvironmentRuntime?.connectionState === "connected" ||
            desktopWorkspaceMachine?.connectionState === "connected"),
      }
    : null;
  useEffect(() => {
    if (!open || editingScope !== "node" || !isElectron || !targetEnvironmentId || targetIsPrimary)
      return;
    return retainDesktopWorkspaceInteractiveScope(targetEnvironmentId);
  }, [open, editingScope, targetEnvironmentId, targetIsPrimary]);
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedTransportStatus = useHostedHubStore((state) => state.transportStatus);
  const hosted = isHostedHubMode();
  const roleFresh = hostedSettingsRoleFresh(hostedDirectoryStatus, hostedTransportStatus);
  const role = hostedSettingsRoleSnapshot(hostedRole, hostedDirectoryStatus, hostedTransportStatus);
  const nodeRole = hosted ? role : targetIsPrimary ? "owner" : remoteRole;
  const authorizedTarget = settingsTarget
    ? {
        ...settingsTarget,
        canManage:
          settingsTarget.connected &&
          (hosted
            ? role === "owner" && roleFresh && nodeWriteCapability.allowed
            : settingsTarget.canManage === true),
      }
    : null;
  const nodeChoices = new Map<EnvironmentId, string>();
  if (primaryEnvironment)
    nodeChoices.set(primaryEnvironment.environmentId, primaryEnvironment.label);
  for (const entry of Object.values(allSavedEnvironments)) {
    if (primaryEnvironment && entry.environmentId === desktopWorkspace.localEnvironmentId) continue;
    nodeChoices.set(entry.environmentId, entry.label);
  }
  for (const machine of desktopWorkspace.machines) {
    if (primaryEnvironment && machine.environmentId === desktopWorkspace.localEnvironmentId)
      continue;
    nodeChoices.set(machine.environmentId, machine.label);
  }
  if (targetEnvironmentId) nodeChoices.set(targetEnvironmentId, targetNodeLabel);
  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (
      !settingsSectionInDestination(
        item.id,
        editingScope,
        isElectron && Boolean(window.desktopBridge?.computerUse),
      )
    )
      return false;
    if (editingScope === "client") return item.id !== "connections" || !hosted;
    return settingsSectionReachable(item.id === "connections" ? "security" : item.id, {
      hosted: hosted || !targetIsPrimary,
      role: settingsTarget?.connected ? nodeRole : null,
      desktop: false,
    });
  });
  const requestedSection =
    section === "computer-use" && window.desktopBridge?.computerUse ? "integrations" : section;
  const effectiveSection = visibleNavItems.some((item) => item.id === requestedSection)
    ? requestedSection
    : (visibleNavItems[0]?.id ?? "appearance");
  const scopeLabel =
    editingScope === "node" ? `Node: ${targetNodeLabel}` : isElectron ? "This app" : "This browser";

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
            entry.owner === editingScope &&
            (!entry.desktopCapability ||
              Boolean(window.desktopBridge?.[entry.desktopCapability])) &&
            `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
              .toLowerCase()
              .includes(normalizedQuery),
        );
  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => {
    setRestoreSignal((v) => v + 1);
  }, []);

  const showRestore = effectiveSection === "general";
  const subsections = useSettingsSubsections(
    `${open}:${effectiveSection}`,
    normalizedQuery.length > 0,
    searchTargetId,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeSettings();
      }}
    >
      <SettingsEditingScopeProvider value={editingScope}>
        <SettingsTargetProvider value={editingScope === "node" ? authorizedTarget : null}>
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
              <nav className="relative isolate flex w-12 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2 sm:w-52">
                <div
                  className="mb-2 flex flex-col gap-1 border-b pb-2"
                  role="group"
                  aria-label="Settings destination"
                >
                  <Button
                    variant={editingScope === "client" ? "secondary" : "ghost"}
                    aria-pressed={editingScope === "client"}
                    onClick={() => setEditingScope("client")}
                    className="justify-start px-2"
                  >
                    <PaletteIcon className="size-4 shrink-0" />
                    <span className="hidden sm:inline">
                      {isElectron ? "This app" : "This browser"}
                    </span>
                  </Button>
                  <Button
                    variant={editingScope === "node" ? "secondary" : "ghost"}
                    aria-pressed={editingScope === "node"}
                    onClick={() => setEditingScope("node")}
                    disabled={!settingsTarget}
                    className="justify-start px-2"
                    aria-label={`Node settings: ${targetNodeLabel}`}
                  >
                    <ServerIcon className="size-4 shrink-0" />
                    <span className="hidden truncate sm:inline">{targetNodeLabel}</span>
                  </Button>
                </div>

                {editingScope === "node" && !hosted && nodeChoices.size > 1 && (
                  <select
                    aria-label="Settings node"
                    value={targetEnvironmentId ?? ""}
                    onChange={(event) =>
                      setTargetEnvironmentId(EnvironmentId.make(event.target.value))
                    }
                    className="mb-2 hidden w-full rounded-md border bg-background p-2 text-xs sm:block"
                  >
                    {[...nodeChoices].map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {hosted && editingScope === "client" && (
                  <Button
                    variant="ghost"
                    className="justify-start px-2"
                    onClick={() => {
                      closeSettings();
                      navigateHub({ kind: "account", section: "overview" });
                    }}
                  >
                    <UserRoundIcon className="size-4 shrink-0" />
                    <span className="hidden sm:inline">Hub account</span>
                  </Button>
                )}
                {visibleNavItems.map((item) => {
                  if (item.id === "security") return null;
                  const Icon = item.icon;
                  const isActive =
                    effectiveSection === item.id ||
                    (item.id === "connections" && effectiveSection === "security");
                  return (
                    <Fragment key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchTargetId(null);
                          setSection(item.id);
                        }}
                        className={cn(
                          "relative z-10 flex h-9 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-hidden ring-ring transition-colors duration-150 focus-visible:ring-2",
                          isActive
                            ? "bg-accent font-medium text-foreground"
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
                      {editingScope === "node" &&
                        item.id === "connections" &&
                        isActive &&
                        visibleSectionIds.has("security") && (
                          <button
                            type="button"
                            onClick={() => {
                              setSearchTargetId(null);
                              setSection("security");
                            }}
                            aria-current={effectiveSection === "security" ? "page" : undefined}
                            aria-label="Advanced node security"
                            className={cn(
                              "flex items-center gap-2 rounded-md px-2 py-2 text-left text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:ml-7",
                              effectiveSection === "security"
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          >
                            <ShieldIcon className="size-3.5 shrink-0" />
                            <span className="hidden sm:inline">Node security · Advanced</span>
                          </button>
                        )}
                      {isActive && subsections.sections.length > 1 && (
                        <div className="mb-2 ml-7 hidden flex-col border-l border-border sm:flex">
                          {subsections.sections.map(({ id, title, element }) => (
                            <button
                              key={id}
                              type="button"
                              aria-current={subsections.active === element ? "location" : undefined}
                              className={cn(
                                "rounded-r px-3 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring",
                                subsections.active === element
                                  ? "font-medium text-foreground"
                                  : "text-muted-foreground hover:text-foreground",
                              )}
                              onClick={() => {
                                if (element.hasAttribute("data-settings-action")) element.click();
                                element.scrollIntoView({
                                  block: "start",
                                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                                    .matches
                                    ? "instant"
                                    : "smooth",
                                });
                              }}
                            >
                              {title}
                            </button>
                          ))}
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </nav>

              <ScrollArea ref={subsections.contentRef} className="min-h-0 min-w-0 flex-1">
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
                                setSearchTargetId(entry.targetId ?? entry.title);
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
                    {editingScope === "node" && !authorizedTarget?.connected ? (
                      <p className="p-6 text-sm text-muted-foreground">
                        {desktopWorkspaceMachine && !desktopWorkspaceMachine.online
                          ? `${targetNodeLabel} is offline. Its settings will be available when it reconnects.`
                          : desktopWorkspaceMachine?.canConnect
                            ? `Connecting to ${targetNodeLabel}…`
                            : `Connect to ${targetNodeLabel} to manage its settings.`}
                      </p>
                    ) : editingScope === "node" && visibleNavItems.length === 0 ? (
                      <p className="p-6 text-sm text-muted-foreground">
                        Your access to {targetNodeLabel} does not allow changing node settings.
                      </p>
                    ) : (
                      <SectionPanel section={effectiveSection} searchTargetId={searchTargetId} />
                    )}
                  </div>
                )}
              </ScrollArea>
            </div>
          </DialogPopup>
        </SettingsTargetProvider>
      </SettingsEditingScopeProvider>
    </Dialog>
  );
}
