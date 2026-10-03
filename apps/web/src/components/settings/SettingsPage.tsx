import { EnvironmentId, WS_METHODS } from "@ryco/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  ActivityIcon,
  AppWindowIcon,
  ArchiveIcon,
  ArrowUpRightIcon,
  BarChart3Icon,
  BlocksIcon,
  ChevronsUpDownIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  PaletteIcon,
  PlugIcon,
  PuzzleIcon,
  RotateCcwIcon,
  SearchIcon,
  ServerIcon,
  Settings2Icon,
  ShieldIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../../appChrome";
import { useAppPreferencesLabel, useDeviceName } from "../../deviceName";
import { isElectron, isHostedHubMode } from "../../env";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useAppSidebarCollapsed } from "../../hooks/useAppSidebarCollapsed";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { navigateHub } from "../../hostedHub/hubRoutes";
import { useHostedHubStore } from "../../hostedHub/state";
import { cn } from "../../lib/utils";
import {
  retainDesktopWorkspaceInteractiveScope,
  useDesktopWorkspaceState,
} from "../../platform/desktopWorkspace";
import { useServerConfig } from "../../rpc/serverState";
import { type SettingsSectionId, useSettingsDialogStore } from "../../settingsDialogStore";
import {
  resolveSettingsTargetEnvironmentId,
  SettingsEditingScopeProvider,
  SettingsTargetProvider,
  type SettingsTarget,
} from "../../settingsTarget";
import { useStore } from "../../store";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { DeviceIcon } from "../DeviceIcon";
import { HostedConnectionControl } from "../hostedHub/HostedConnectionControls";
import { isLocalOnboardingClient } from "../onboarding/localOnboarding";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ArchivedThreadsPanel, GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";
import { SETTINGS_SEARCH_INDEX, type SettingsSearchEntry } from "./settingsSearchIndex";
import {
  hostedSettingsRoleFresh,
  hostedSettingsRoleSnapshot,
  settingsSectionInDestination,
  settingsSectionReachable,
} from "./settingsSections.logic";
import { SettingsCard, SettingsEmpty } from "./settingsLayout";
import { useSettingsSubsections } from "./useSettingsSubsections";

type SettingsDestination = "client" | "node";

interface NavItem {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** One line under the page title. A pair when the two destinations differ. */
  readonly description: string | { readonly client: string; readonly node: string };
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    id: "account",
    label: "Account",
    icon: UserRoundIcon,
    description: "Your Hub identity, sign-in methods, and recovery.",
  },
  {
    id: "general",
    label: "General",
    icon: Settings2Icon,
    description: {
      client: "Behavior, notifications, and defaults for this app.",
      node: "Identity, imports, updates, and project defaults for this device.",
    },
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: SparklesIcon,
    description: "What the inbox surfaces and the models that summarize it.",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: PaletteIcon,
    description: "Theme, typography, and interface details for this app.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: BlocksIcon,
    description: "Coding agents on this device and the models they offer.",
  },
  {
    id: "opinionated-plugins",
    label: "Plugins",
    icon: PuzzleIcon,
    description: "Ryco plugins installed into each agent on this device.",
  },
  {
    id: "mcp-servers",
    label: "MCP",
    icon: ServerIcon,
    description: "Model Context Protocol servers each agent can reach.",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: PlugIcon,
    description: {
      client: "Desktop permissions, computer use, and the browser bridge.",
      node: "Agent Control and the tools that can drive this device.",
    },
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: KeyboardIcon,
    description: "Keyboard shortcuts saved in this app or browser profile.",
  },
  {
    id: "source-control",
    label: "Source control",
    icon: GitBranchIcon,
    description: {
      client: "How this app presents commits, branches, and pull requests.",
      node: "Git behavior and the hosting providers this device can reach.",
    },
  },
  {
    id: "connections",
    label: "Connections",
    icon: Link2Icon,
    description: "The devices this app can reach and how it reaches them.",
  },
  {
    id: "security",
    label: "Security",
    icon: ShieldIcon,
    description: "Who can reach this device, live sessions, and pairing policy.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    icon: ActivityIcon,
    description: {
      client: "Performance and presentation checks for this app.",
      node: "Logs, traces, processes, and resource history for this device.",
    },
  },
  {
    id: "statistics",
    label: "Statistics",
    icon: BarChart3Icon,
    description: "Usage and activity for this device.",
  },
  {
    id: "archived",
    label: "Archive",
    icon: ArchiveIcon,
    description: "Archived threads on this device. Restore or delete them.",
  },
];

/** Sections that open another page instead of rendering a panel here. */
const LINK_SECTIONS: ReadonlySet<SettingsSectionId> = new Set(["statistics"]);

/**
 * Every section the settings page can navigate to.
 *
 * Exported so `PhoneSettingsSurface`'s mirrored registry can be checked against
 * it rather than trusted: a section added here and not there is unreachable on
 * every phone-tier presentation, and `openSettings(id)` for it falls back to the
 * list with no error.
 */
export const SETTINGS_SECTION_IDS: ReadonlyArray<SettingsSectionId> = NAV_ITEMS.map(
  (item) => item.id,
);

/**
 * The section labels the nav draws, by id.
 *
 * Exported so copy that NAMES a section can be held to the label the nav
 * actually shows: §13.5's `E2EE_WEB_SAS_MORE` sends an owner to
 * "Settings → Security", and `SettingsPage.test.ts` reads this map to fail
 * that pointer if the section is ever renamed underneath it.
 */
export const SETTINGS_SECTION_LABELS: ReadonlyMap<SettingsSectionId, string> = new Map(
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
  import("./AccountSettings").then((module) => ({ default: module.AccountSettingsPanel })),
);
const LazyProvidersSettingsPanel = lazy(() =>
  import("./ProvidersSettingsPanel").then((module) => ({
    default: module.ProvidersSettingsPanel,
  })),
);
const LazyAiFocusSettings = lazy(() =>
  import("./AiFocusSettings").then((module) => ({ default: module.AiFocusSettings })),
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
  import("./ConnectionsSettings").then((module) => ({ default: module.ConnectionsSettings })),
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

function navDescription(item: NavItem, destination: SettingsDestination): string {
  return typeof item.description === "string" ? item.description : item.description[destination];
}

function SectionPanel({
  section,
  searchTargetId,
}: {
  section: SettingsSectionId;
  searchTargetId: string | null;
}) {
  switch (section) {
    case "account":
      return <LazyAccountSettingsPanel />;
    case "general":
      return <GeneralSettingsPanel searchTargetId={searchTargetId} />;
    case "inbox":
      return <LazyAiFocusSettings />;
    case "providers":
      return <LazyProvidersSettingsPanel />;
    case "opinionated-plugins":
      return <LazyOpinionatedPluginsSettingsPanel />;
    case "mcp-servers":
      return <LazyMcpServersSettings />;
    case "integrations":
      return <LazyIntegrationsSettings />;
    case "appearance":
      return <LazyAppearanceSettingsPanel />;
    case "keybindings":
      return <LazyKeybindingsSettingsPanel />;
    case "source-control":
      return <LazySourceControlSettingsPanel />;
    case "connections":
      return <LazyConnectionsSettings />;
    case "security":
      return <LazyNodeSecuritySettings />;
    case "diagnostics":
      return <LazyDiagnosticsSettings />;
    case "archived":
      return <ArchivedThreadsPanel />;
    default:
      return null;
  }
}

function PanelFallback() {
  return (
    <div className="flex flex-col gap-9" aria-busy="true" aria-label="Loading settings">
      {[3, 2].map((rows) => (
        <div key={rows}>
          <Skeleton className="mb-3 h-3.5 w-28" />
          <SettingsCard>
            {Array.from({ length: rows }, (_, row) => (
              <div
                key={row}
                className="flex items-center gap-6 border-t border-border/60 px-5 py-4 first:border-t-0"
              >
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-2.5 w-64 max-w-full" />
                </div>
                <Skeleton className="h-7 w-32" />
              </div>
            ))}
          </SettingsCard>
        </div>
      ))}
    </div>
  );
}

function RestoreDefaultsButton({ onRestored }: { onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon />
      Restore defaults
    </Button>
  );
}

/** Leave the settings page for wherever the reader came from. */
export function useLeaveSettings() {
  const router = useRouter();
  return useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
      return;
    }
    void router.navigate({ to: "/", replace: true });
  }, [router]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The nav's active marker: one element that travels between items instead of
 * each item toggling its own background, so moving between sections reads as
 * motion rather than a cut.
 */
function useActiveIndicator(activeKey: string | null) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list || !activeKey) {
      setRect(null);
      return;
    }
    const element = list.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(activeKey)}"]`);
    if (!element) {
      setRect(null);
      return;
    }
    setRect((previous) =>
      previous?.top === element.offsetTop && previous.height === element.offsetHeight
        ? previous
        : { top: element.offsetTop, height: element.offsetHeight },
    );
  }, [activeKey]);
  useLayoutEffect(() => {
    measure();
  }, [measure]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // Measured on the next frame so a resize never feeds back into the
    // observer within the same frame.
    let pending = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(measure);
    });
    observer.observe(list);
    // The first placement lands without sliding in from the top.
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(pending);
      cancelAnimationFrame(frame);
    };
  }, [measure]);
  return { listRef, rect, animate };
}

interface NavGroup {
  readonly destination: SettingsDestination;
  readonly items: ReadonlyArray<NavItem>;
}

function SettingsNav({
  groups,
  activeDestination,
  activeSection,
  clientLabel,
  nodeHeader,
  extraClientItems,
  subsections,
  onSelect,
}: {
  groups: ReadonlyArray<NavGroup>;
  activeDestination: SettingsDestination;
  activeSection: SettingsSectionId;
  clientLabel: string;
  nodeHeader: ReactNode;
  extraClientItems?: ReactNode;
  subsections: ReturnType<typeof useSettingsSubsections>;
  onSelect: (destination: SettingsDestination, item: NavItem) => void;
}) {
  const activeKey = `${activeDestination}:${activeSection}`;
  const { listRef, rect, animate } = useActiveIndicator(activeKey);
  return (
    <nav
      aria-label="Settings sections"
      className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border/70 px-3 pt-4 pb-6 md:flex lg:w-60"
    >
      <div ref={listRef} className="relative isolate flex flex-col">
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 -z-10 rounded-[min(var(--radius-md),0.5rem)] bg-accent",
            animate &&
              "transition-[transform,height,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-ease)",
            rect ? "opacity-100" : "opacity-0",
          )}
          style={{
            top: 0,
            height: rect?.height ?? 0,
            transform: `translateY(${rect?.top ?? 0}px)`,
          }}
        />
        {groups.map((group, groupIndex) => (
          <div
            key={group.destination}
            role="group"
            aria-label={group.destination === "client" ? clientLabel : "Device settings"}
            className={cn("flex flex-col gap-px", groupIndex > 0 && "mt-5")}
          >
            {group.destination === "client" ? (
              <div className="flex h-7 items-center gap-2 px-2.5 text-[11px] font-medium text-muted-foreground">
                <AppWindowIcon className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 truncate" title={clientLabel}>
                  {clientLabel}
                </span>
              </div>
            ) : (
              nodeHeader
            )}
            {group.destination === "client" ? extraClientItems : null}
            {group.items.map((item) => {
              const key = `${group.destination}:${item.id}`;
              const active = key === activeKey;
              const Icon = item.icon;
              const isLink = LINK_SECTIONS.has(item.id);
              return (
                <div key={key} className="flex flex-col">
                  <button
                    type="button"
                    data-nav-key={key}
                    onClick={() => onSelect(group.destination, item)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group/nav flex h-8 w-full items-center gap-2.5 rounded-[min(var(--radius-md),0.5rem)] px-2.5 text-left text-[13px] outline-hidden transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0 transition-colors",
                        active ? "text-foreground" : "text-muted-foreground/70",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {isLink ? (
                      <ArrowUpRightIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/nav:opacity-60" />
                    ) : null}
                  </button>
                  {active && subsections.sections.length > 1 ? (
                    <div className="settings-subsections-enter relative my-1 ml-[1.0625rem] flex flex-col border-l border-border/70 pl-2">
                      {subsections.sections.map(({ id, title, element }) => {
                        const current = subsections.active === element;
                        return (
                          <button
                            key={id}
                            type="button"
                            aria-current={current ? "location" : undefined}
                            className={cn(
                              "relative truncate rounded-sm py-1 pr-2 pl-2.5 text-left text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                              current
                                ? "text-foreground before:absolute before:top-1/2 before:-left-[calc(0.5rem+1px)] before:h-4 before:w-px before:-translate-y-1/2 before:bg-foreground"
                                : "text-muted-foreground/80 hover:text-foreground",
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
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** Narrow widths swap the side nav for a compact section picker. */
function CompactSectionPicker({
  groups,
  activeDestination,
  activeSection,
  clientLabel,
  nodeLabel,
  onSelect,
}: {
  groups: ReadonlyArray<NavGroup>;
  activeDestination: SettingsDestination;
  activeSection: SettingsSectionId;
  clientLabel: string;
  nodeLabel: string;
  onSelect: (destination: SettingsDestination, item: NavItem) => void;
}) {
  const active = groups
    .find((group) => group.destination === activeDestination)
    ?.items.find((item) => item.id === activeSection);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="outline" size="sm" className="mb-6 w-full justify-between md:hidden">
            <span className="truncate">{active?.label ?? "Sections"}</span>
            <ChevronsUpDownIcon className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <MenuPopup align="start" className="max-h-[60dvh] min-w-56 overflow-y-auto">
        {groups.map((group) => (
          <MenuRadioGroup
            key={group.destination}
            value={activeDestination === group.destination ? activeSection : ""}
          >
            <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {group.destination === "client" ? clientLabel : nodeLabel}
            </div>
            {group.items.map((item) => (
              <MenuRadioItem
                key={item.id}
                value={item.id}
                onClick={() => onSelect(group.destination, item)}
              >
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SearchResults({
  query,
  results,
  sectionLabel,
  destinationLabel,
  onPick,
}: {
  query: string;
  results: ReadonlyArray<SettingsSearchEntry>;
  sectionLabel: (entry: SettingsSearchEntry) => string | undefined;
  destinationLabel: (destination: SettingsDestination) => string;
  onPick: (entry: SettingsSearchEntry) => void;
}) {
  if (results.length === 0) {
    return (
      <SettingsEmpty
        icon={<SearchIcon />}
        title={`No settings match “${query}”`}
        description="Try a shorter word, or look through the sections on the left."
        className="settings-panel-enter py-20"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="mb-2 px-0.5 text-xs text-muted-foreground">
        {results.length === 1 ? "1 setting" : `${results.length} settings`}
      </p>
      {results.map((entry, index) => (
        <button
          key={`${entry.owner}:${entry.section}:${entry.title}`}
          type="button"
          onClick={() => onPick(entry)}
          style={{ "--i": Math.min(index, 12) } as CSSProperties}
          className="settings-search-result group/result flex min-w-0 items-start gap-4 rounded-[min(var(--radius-lg),0.625rem)] px-3 py-2.5 text-left outline-hidden ring-ring transition-colors hover:bg-accent/60 focus-visible:ring-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-foreground">{entry.title}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground/80">
            {destinationLabel(entry.owner)}
            {sectionLabel(entry) ? ` · ${sectionLabel(entry)}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const routedEnvironmentId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.environmentId ?? null,
  });
  const leaveSettings = useLeaveSettings();
  const router = useRouter();
  const appSidebarCollapsed = useAppSidebarCollapsed();
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const primaryServerConfig = useServerConfig();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const desktopWorkspace = useDesktopWorkspaceState();
  const section = useSettingsDialogStore((s) => s.section);
  const editingScope = useSettingsDialogStore((s) => s.editingScope);
  const showSection = useSettingsDialogStore((s) => s.showSection);
  const setTargetEnvironmentId = useSettingsDialogStore((s) => s.setTargetEnvironmentId);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const requestedEnvironmentId = useSettingsDialogStore((s) => s.targetEnvironmentId);
  const allSavedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const nodeWriteCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const hosted = isHostedHubMode();
  const targetEnvironmentId = hosted
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
  const primaryDeviceName = useDeviceName();
  const appPreferencesLabel = useAppPreferencesLabel();
  const targetNodeLabel = useDeviceName(
    targetEnvironmentId,
    targetIsPrimary
      ? (primaryEnvironment?.label ?? targetServerConfig?.environment.label)
      : (savedEnvironmentRuntime?.descriptor?.label ??
          targetServerConfig?.environment.label ??
          savedEnvironment?.label),
  );
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
        canManage: targetIsPrimary ? !hosted : remoteRole === "owner",
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
    if (editingScope !== "node" || !isElectron || !targetEnvironmentId || targetIsPrimary) return;
    return retainDesktopWorkspaceInteractiveScope(targetEnvironmentId);
  }, [editingScope, targetEnvironmentId, targetIsPrimary]);
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedTransportStatus = useHostedHubStore((state) => state.transportStatus);
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
  if (primaryEnvironment) nodeChoices.set(primaryEnvironment.environmentId, primaryDeviceName);
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

  const desktopComputerUse = isElectron && Boolean(window.desktopBridge?.computerUse);
  const clientItems = NAV_ITEMS.filter(
    (item) =>
      settingsSectionInDestination(item.id, "client", desktopComputerUse) &&
      (item.id !== "connections" || !hosted),
  );
  // The device's own connection settings live under Security; "Connections"
  // belongs to the app, which is what reaches devices.
  const nodeItems = settingsTarget
    ? NAV_ITEMS.filter(
        (item) =>
          item.id !== "connections" &&
          settingsSectionInDestination(item.id, "node", desktopComputerUse) &&
          settingsSectionReachable(item.id, {
            hosted: hosted || !targetIsPrimary,
            role: settingsTarget.connected ? nodeRole : null,
            desktop: false,
          }),
      )
    : [];
  const groups: NavGroup[] = [{ destination: "client", items: clientItems }];
  if (settingsTarget) groups.push({ destination: "node", items: nodeItems });

  const destination: SettingsDestination =
    editingScope === "node" && settingsTarget ? "node" : "client";
  const visibleItems = destination === "node" ? nodeItems : clientItems;
  const requestedSection =
    section === "computer-use" && window.desktopBridge?.computerUse
      ? "integrations"
      : destination === "node" && section === "connections"
        ? "security"
        : section;
  const effectiveSection = visibleItems.some(
    (item) => item.id === requestedSection && !LINK_SECTIONS.has(item.id),
  )
    ? requestedSection
    : (visibleItems.find((item) => !LINK_SECTIONS.has(item.id))?.id ?? "appearance");
  const activeItem = NAV_ITEMS.find((item) => item.id === effectiveSection);

  useEffect(() => {
    if (hosted && !roleFresh) return;
    if (section !== effectiveSection || editingScope !== destination) {
      showSection(destination, effectiveSection);
    }
  }, [destination, editingScope, effectiveSection, hosted, roleFresh, section, showSection]);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchTargetId, setSearchTargetId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const reachable = new Set(
    groups.flatMap((group) => group.items.map((item) => `${group.destination}:${item.id}`)),
  );
  const searchResults =
    normalizedQuery.length === 0
      ? []
      : SETTINGS_SEARCH_INDEX.filter(
          (entry) =>
            reachable.has(`${entry.owner}:${entry.section}`) &&
            (!entry.localOnboardingOnly || isLocalOnboardingClient()) &&
            (!entry.desktopCapability ||
              Boolean(window.desktopBridge?.[entry.desktopCapability])) &&
            `${entry.title} ${entry.description} ${entry.keywords ?? ""}`
              .toLowerCase()
              .includes(normalizedQuery),
        );

  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => setRestoreSignal((value) => value + 1), []);

  const panelKey = `${destination}:${effectiveSection}:${targetEnvironmentId ?? ""}`;
  const subsections = useSettingsSubsections(panelKey, normalizedQuery.length > 0, searchTargetId);
  const { contentRef: setSubsectionRoot } = subsections;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef.current = element;
      setSubsectionRoot(element);
    },
    [setSubsectionRoot],
  );
  // A new section starts at its top; a search jump scrolls itself into place.
  const scrolledPanelKey = useRef(panelKey);
  useLayoutEffect(() => {
    if (scrolledPanelKey.current === panelKey) return;
    scrolledPanelKey.current = panelKey;
    if (!searchTargetId) scrollRef.current?.scrollTo({ top: 0 });
  }, [panelKey, searchTargetId]);

  const selectSection = useCallback(
    (nextDestination: SettingsDestination, item: NavItem) => {
      if (LINK_SECTIONS.has(item.id)) {
        closeSettings();
        void router.navigate({
          to: "/statistics",
          search: parseStatisticsSearch(
            nextDestination === "node" && targetEnvironmentId
              ? { environmentIds: [targetEnvironmentId] }
              : {},
          ),
        });
        return;
      }
      setSearchTargetId(null);
      setSearchQuery("");
      showSection(nextDestination, item.id);
    },
    [closeSettings, router, showSection, targetEnvironmentId],
  );

  // Escape leaves settings unless something on the page wants the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (isEditableTarget(event.target)) {
        if (event.target === searchInputRef.current && searchQuery) {
          setSearchQuery("");
          return;
        }
        (event.target as HTMLElement).blur();
        return;
      }
      leaveSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leaveSettings, searchQuery]);

  // "/" jumps to search from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const destinationLabel = (value: SettingsDestination) =>
    value === "node" ? targetNodeLabel : "This app";

  const nodeHeader = settingsTarget ? (
    <div className="flex h-7 items-center gap-2 pr-1 pl-2.5 text-[11px] font-medium text-muted-foreground">
      <DeviceIcon
        environmentId={targetEnvironmentId}
        label={targetNodeLabel}
        className="size-3.5 shrink-0 opacity-70"
      />
      <span className="min-w-0 flex-1 truncate" title={targetNodeLabel}>
        {targetNodeLabel}
      </span>
      {!hosted && nodeChoices.size > 1 ? (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Settings device"
                      className="size-6 text-muted-foreground hover:text-foreground sm:size-6"
                    >
                      <ChevronsUpDownIcon className="size-3.5" />
                    </Button>
                  }
                />
              }
            />
            <TooltipPopup side="right">Switch device</TooltipPopup>
          </Tooltip>
          <MenuPopup align="start" className="min-w-52">
            <MenuRadioGroup
              value={targetEnvironmentId ?? ""}
              onValueChange={(value) => {
                setSearchQuery("");
                setTargetEnvironmentId(EnvironmentId.make(String(value)));
              }}
            >
              {[...nodeChoices].map(([id, label]) => (
                <MenuRadioItem key={id} value={id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <DeviceIcon environmentId={id} label={label} className="size-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  ) : null;

  const hubAccountItem = hosted ? (
    <button
      type="button"
      onClick={() => {
        closeSettings();
        navigateHub({ kind: "account", section: "overview" });
      }}
      className="group/nav flex h-8 w-full items-center gap-2.5 rounded-[min(var(--radius-md),0.5rem)] px-2.5 text-left text-[13px] text-muted-foreground outline-hidden transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <UserRoundIcon className="size-4 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 flex-1 truncate">Hub account</span>
      <ArrowUpRightIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/nav:opacity-60" />
    </button>
  ) : null;

  const searching = normalizedQuery.length > 0;
  const nodeUnavailable = destination === "node" && !authorizedTarget?.connected;
  const nodeForbidden = destination === "node" && nodeItems.length === 0;
  const showRestore = !searching && effectiveSection === "general";

  return (
    <SidebarInset
      data-slot="settings-page"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
    >
      <SettingsEditingScopeProvider value={destination}>
        <SettingsTargetProvider value={destination === "node" ? authorizedTarget : null}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header
              className={cn(
                "flex shrink-0 items-center gap-3 border-b border-border/70 pr-3 sm:pr-4",
                APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
                appSidebarCollapsed ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS : "pl-4 sm:pl-5",
                isElectron
                  ? "drag-region h-[52px] wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.75rem)]"
                  : "h-14",
              )}
            >
              <h1 className="shrink-0 text-sm font-semibold tracking-tight">Settings</h1>
              <div className="relative ml-auto w-full max-w-72 min-w-0 md:ml-6 md:max-w-80">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70"
                />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchTargetId(null);
                    setSearchQuery(event.target.value);
                  }}
                  placeholder="Search settings"
                  aria-label="Search settings"
                  className="h-8 w-full rounded-[min(var(--radius-lg),0.625rem)] border border-transparent bg-muted/60 pr-9 pl-8 text-[13px] outline-hidden transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/70 hover:bg-muted focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:appearance-none"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery("");
                      searchInputRef.current?.focus();
                    }}
                    className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                ) : (
                  <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
                    /
                  </Kbd>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <HostedConnectionControl />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Close settings"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={leaveSettings}
                      >
                        <XIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="bottom">
                    Close <Kbd className="ml-1">Esc</Kbd>
                  </TooltipPopup>
                </Tooltip>
              </div>
            </header>

            <div className="flex min-h-0 min-w-0 flex-1">
              <SettingsNav
                groups={groups}
                activeDestination={destination}
                activeSection={effectiveSection}
                clientLabel="This app"
                nodeHeader={nodeHeader}
                extraClientItems={hubAccountItem}
                subsections={subsections}
                onSelect={selectSection}
              />
              <div
                ref={setScrollRef}
                className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
              >
                <div className="mx-auto w-full max-w-[52rem] px-5 pt-8 pb-24 sm:px-8 lg:px-10 lg:pt-10">
                  <CompactSectionPicker
                    groups={groups}
                    activeDestination={destination}
                    activeSection={effectiveSection}
                    clientLabel="This app"
                    nodeLabel={targetNodeLabel}
                    onSelect={selectSection}
                  />
                  {searching ? (
                    <SearchResults
                      query={searchQuery.trim()}
                      results={searchResults}
                      sectionLabel={(entry) => SETTINGS_SECTION_LABELS.get(entry.section)}
                      destinationLabel={destinationLabel}
                      onPick={(entry) => {
                        setSearchTargetId(entry.targetId ?? entry.title);
                        showSection(entry.owner, entry.section);
                        setSearchQuery("");
                      }}
                    />
                  ) : (
                    <div key={`${panelKey}:${restoreSignal}`} className="settings-panel-enter">
                      <header className="mb-8 flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {destination === "node" ? (
                              <DeviceIcon
                                environmentId={targetEnvironmentId}
                                label={targetNodeLabel}
                                className="size-3.5 shrink-0"
                              />
                            ) : (
                              <AppWindowIcon className="size-3.5 shrink-0" />
                            )}
                            <span className="truncate" data-testid="settings-scope-label">
                              {destination === "node" ? targetNodeLabel : appPreferencesLabel}
                            </span>
                          </p>
                          <h2 className="text-xl font-semibold tracking-[-0.015em] text-foreground">
                            {activeItem?.label ?? "Settings"}
                          </h2>
                          {activeItem ? (
                            <p
                              className="mt-1 text-[13px] text-muted-foreground"
                              data-testid="settings-destination-description"
                            >
                              {navDescription(activeItem, destination)}
                            </p>
                          ) : null}
                        </div>
                        {showRestore ? (
                          <div className="shrink-0 pt-6">
                            <RestoreDefaultsButton onRestored={handleRestored} />
                          </div>
                        ) : null}
                      </header>
                      {nodeUnavailable ? (
                        <SettingsEmpty
                          icon={
                            <DeviceIcon
                              environmentId={targetEnvironmentId}
                              label={targetNodeLabel}
                            />
                          }
                          title={
                            desktopWorkspaceMachine && !desktopWorkspaceMachine.online
                              ? `${targetNodeLabel} is offline`
                              : desktopWorkspaceMachine?.canConnect
                                ? `Connecting to ${targetNodeLabel}…`
                                : `${targetNodeLabel} isn't connected`
                          }
                          description={
                            desktopWorkspaceMachine && !desktopWorkspaceMachine.online
                              ? "Its settings will be available when it reconnects."
                              : `Connect to ${targetNodeLabel} to manage its settings.`
                          }
                          className="rounded-[min(var(--radius-xl),0.875rem)] border border-dashed border-border/80 py-16"
                        />
                      ) : nodeForbidden ? (
                        <SettingsEmpty
                          icon={<ShieldIcon />}
                          title="No settings you can change"
                          description={`Your access to ${targetNodeLabel} does not allow changing its settings.`}
                          className="rounded-[min(var(--radius-xl),0.875rem)] border border-dashed border-border/80 py-16"
                        />
                      ) : (
                        <Suspense fallback={<PanelFallback />}>
                          <SectionPanel
                            section={effectiveSection}
                            searchTargetId={searchTargetId}
                          />
                        </Suspense>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </SettingsTargetProvider>
      </SettingsEditingScopeProvider>
    </SidebarInset>
  );
}
