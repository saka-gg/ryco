import { useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@ryco/contracts";
import {
  ActivityIcon,
  AppWindowIcon,
  ArrowUpCircleIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  BotIcon,
  ChevronsUpDownIcon,
  DatabaseIcon,
  FolderIcon,
  GaugeIcon,
  GitBranchIcon,
  InboxIcon,
  InfoIcon,
  KeyboardIcon,
  LayersIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  SearchIcon,
  ShieldIcon,
  UserRoundIcon,
  BellIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../../appChrome";
import { isElectron, isHostedHubMode } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useAppSidebarCollapsed } from "../../hooks/useAppSidebarCollapsed";
import { useSettingsPageTarget } from "../../hooks/useSettingsPageTarget";
import { navigateHub } from "../../hostedHub/hubRoutes";
import { useHostedNodePageDemand } from "../../hostedHub/useHostedNodePageDemand";
import { cn } from "../../lib/utils";
import { retainDesktopWorkspaceInteractiveScope } from "../../platform/desktopWorkspace";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { DeviceIcon } from "../DeviceIcon";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useActiveIndicator } from "../ui/useActiveIndicator";
import { KEYBINDING_SEARCH_ENTRIES } from "./keybindingSearchEntries";
import {
  preloadSettingsSection,
  SettingsDevicePage,
  settingsDeviceReady,
  SettingsPartsProvider,
  SettingsSectionPanel,
} from "./SettingsSectionPanels";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  resolveSettingsPageSection,
  settingsSection,
  type SettingsPageSectionId,
} from "./settingsRegistry";
import {
  describeSettingsSearchEntry,
  filterSettingsSearchEntries,
  readSettingsReach,
  readSettingsSearchScope,
  SETTINGS_SEARCH_INDEX,
  settingsSearchEntryDestination,
  type SettingsSearchEntry,
} from "./settingsSearchIndex";
import {
  takeSettingsReveal,
  useSettingsSearchRevealStore,
  type SettingsSearchTarget,
} from "./settingsSearchReveal";
import {
  settingsSectionAppOnly,
  settingsSectionListed,
  settingsStorageReachable,
  type SettingsReach,
} from "./settingsSections.logic";
import { SettingsCard, SettingsChip, SettingsEmpty } from "./settingsLayout";
import type { SettingsNodeStatus } from "./settingsDevices.logic";
import {
  SETTINGS_NODE_STATUS_LABELS,
  useSettingsDevices,
  type SettingsDeviceChoice,
  type SettingsDevicesModel,
} from "./useSettingsDevices";
import { useSettingsSubsections } from "./useSettingsSubsections";

/** Each section's nav icon. Typed over every section, so a new one fails typecheck until drawn. */
const SETTINGS_SECTION_ICONS: Readonly<Record<SettingsPageSectionId, LucideIcon>> = {
  appearance: PaletteIcon,
  keybindings: KeyboardIcon,
  notifications: BellIcon,
  account: UserRoundIcon,
  chat: MessageSquareIcon,
  inbox: InboxIcon,
  projects: FolderIcon,
  "source-control": GitBranchIcon,
  providers: BlocksIcon,
  usage: GaugeIcon,
  plugins: PlugIcon,
  "agent-control": BotIcon,
  devices: LayoutGridIcon,
  device: MonitorIcon,
  updates: ArrowUpCircleIcon,
  data: DatabaseIcon,
  diagnostics: ActivityIcon,
  about: InfoIcon,
};

export { preloadSettingsSection } from "./SettingsSectionPanels";

/** Whether a section shows the device bar: it keeps rows on a device. */
function sectionUsesDevice(section: SettingsPageSectionId): boolean {
  return (
    section !== "device" &&
    settingsSection(section).parts.some(
      (storage) => storage === "device" || storage === "device-read",
    )
  );
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

const ESCAPE_OWNER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * An open popup takes Escape before the page. Some popups stay mounted while
 * closed, inert (the sidebar Omnifield's menu), and must not hold the key.
 */
function hasOpenEscapeOwner(): boolean {
  return Array.from(document.querySelectorAll(ESCAPE_OWNER_SELECTOR)).some(
    (element) => element.closest("[inert]") === null,
  );
}

/** A nav entry: a section, or one device's page. */
type NavKey = SettingsPageSectionId | `device:${string}`;

function deviceNavKey(environmentId: EnvironmentId): NavKey {
  return `device:${environmentId}`;
}

const STATUS_DOT_CLASS: Record<"online" | SettingsNodeStatus, string> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-muted-foreground/50",
};

function DeviceStatusDot({ status }: { readonly status: SettingsNodeStatus | null }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status ?? "online"])}
    />
  );
}

const NAV_ITEM_CLASS =
  "group/nav flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] outline-hidden transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring";

function NavButton(props: {
  readonly navKey: NavKey;
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly trailing?: ReactNode;
  readonly className?: string;
  readonly onSelect: () => void;
  readonly onIntent?: () => void;
  readonly subsections: ReturnType<typeof useSettingsSubsections>;
}) {
  const { subsections } = props;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-nav-key={props.navKey}
        onClick={props.onSelect}
        onPointerEnter={props.onIntent}
        onFocus={props.onIntent}
        aria-current={props.active ? "page" : undefined}
        className={cn(
          NAV_ITEM_CLASS,
          props.active
            ? "font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          props.className,
        )}
      >
        {props.icon}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.trailing}
      </button>
      {props.active && subsections.sections.length > 1 ? (
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
                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
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
}

function SettingsNav({
  sections,
  devices,
  primaryEnvironmentId,
  activeKey,
  subsections,
  onSelectSection,
  onSelectDevice,
}: {
  readonly sections: ReadonlyArray<SettingsPageSectionId>;
  readonly devices: ReadonlyArray<SettingsDeviceChoice>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly activeKey: NavKey;
  readonly subsections: ReturnType<typeof useSettingsSubsections>;
  readonly onSelectSection: (section: SettingsPageSectionId) => void;
  readonly onSelectDevice: (environmentId: EnvironmentId) => void;
}) {
  const { listRef, rect, animate } = useActiveIndicator(activeKey);
  const iconClass = (active: boolean) =>
    cn(
      "size-4 shrink-0 transition-colors",
      active ? "text-foreground" : "text-muted-foreground/70",
    );
  return (
    <nav
      aria-label="Settings sections"
      className="hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border/70 px-3 pt-4 pb-6 md:flex lg:w-60"
    >
      <div ref={listRef} className="relative isolate flex flex-col">
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 -z-10 rounded-lg bg-accent",
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
        {SETTINGS_GROUPS.map((group, groupIndex) => {
          const groupSections = sections.filter(
            (id) => settingsSection(id).group === group.id && id !== "device",
          );
          const groupDevices = group.id === "devices" ? devices : [];
          if (groupSections.length === 0 && groupDevices.length === 0) return null;
          return (
            <div
              key={group.id}
              role="group"
              aria-label={group.title}
              className={cn("flex flex-col gap-px", groupIndex > 0 && "mt-4")}
            >
              <div className="flex h-7 items-center px-2.5 text-[11px] font-medium text-muted-foreground">
                {group.title}
              </div>
              {groupSections.map((id) => {
                const Icon = SETTINGS_SECTION_ICONS[id];
                const active = activeKey === id;
                const link = settingsSection(id).link === true;
                return (
                  <NavButton
                    key={id}
                    navKey={id}
                    active={active}
                    icon={<Icon className={iconClass(active)} />}
                    label={settingsSection(id).title}
                    trailing={
                      link ? (
                        <ArrowUpRightIcon className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/nav:opacity-60" />
                      ) : undefined
                    }
                    onSelect={() => onSelectSection(id)}
                    onIntent={() => void preloadSettingsSection(id)}
                    subsections={subsections}
                  />
                );
              })}
              {groupDevices.map((device) => {
                const key = deviceNavKey(device.environmentId);
                const active = activeKey === key;
                return (
                  <NavButton
                    key={key}
                    navKey={key}
                    active={active}
                    className="pl-[1.375rem]"
                    icon={<DeviceStatusDot status={device.status} />}
                    label={device.label}
                    trailing={
                      device.environmentId === primaryEnvironmentId && !isHostedHubMode() ? (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground">
                          this
                        </span>
                      ) : undefined
                    }
                    onSelect={() => onSelectDevice(device.environmentId)}
                    onIntent={() => void preloadSettingsSection("device")}
                    subsections={subsections}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** Narrow widths swap the side nav for a compact section picker. */
function CompactSectionPicker({
  sections,
  devices,
  activeKey,
  activeLabel,
  onSelectSection,
  onSelectDevice,
}: {
  readonly sections: ReadonlyArray<SettingsPageSectionId>;
  readonly devices: ReadonlyArray<SettingsDeviceChoice>;
  readonly activeKey: NavKey;
  readonly activeLabel: string;
  readonly onSelectSection: (section: SettingsPageSectionId) => void;
  readonly onSelectDevice: (environmentId: EnvironmentId) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button variant="outline" size="sm" className="mb-6 w-full justify-between md:hidden">
            <span className="truncate">{activeLabel}</span>
            <ChevronsUpDownIcon className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <MenuPopup align="start" className="max-h-[60dvh] min-w-56 overflow-y-auto">
        {SETTINGS_GROUPS.map((group) => {
          const groupSections = sections.filter(
            (id) => settingsSection(id).group === group.id && id !== "device",
          );
          const groupDevices = group.id === "devices" ? devices : [];
          if (groupSections.length === 0 && groupDevices.length === 0) return null;
          return (
            <MenuRadioGroup key={group.id} value={activeKey}>
              <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.title}
              </div>
              {groupSections.map((id) => (
                <MenuRadioItem
                  key={id}
                  value={id}
                  onClick={() => onSelectSection(id)}
                  onPointerEnter={() => void preloadSettingsSection(id)}
                  onFocus={() => void preloadSettingsSection(id)}
                >
                  {settingsSection(id).title}
                </MenuRadioItem>
              ))}
              {groupDevices.map((device) => (
                <MenuRadioItem
                  key={device.environmentId}
                  value={deviceNavKey(device.environmentId)}
                  onClick={() => onSelectDevice(device.environmentId)}
                >
                  <span className="flex items-center gap-2 pl-2">
                    <DeviceStatusDot status={device.status} />
                    {device.label}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

/**
 * "Values for: [device pills]" at the top of a section with rows stored on a
 * device: the one device those rows read and write. Choosing a pill moves the
 * settings target, as the device menu did; it never opens a second target.
 */
function DeviceBar({ model }: { readonly model: SettingsDevicesModel }) {
  if (model.choices.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Device values shown"
      data-testid="settings-device-bar"
      className="mb-8 flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-2"
    >
      <span className="mr-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <LayersIcon aria-hidden className="size-3.5" />
        Values for
      </span>
      {model.choices.map((choice) => {
        const selected = choice.environmentId === model.value;
        return (
          <button
            key={choice.environmentId}
            type="button"
            aria-pressed={selected}
            disabled={choice.disabled}
            title={choice.status ? SETTINGS_NODE_STATUS_LABELS[choice.status] : undefined}
            onClick={() => model.select(choice.environmentId)}
            className={cn(
              "inline-flex h-6 max-w-56 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              selected
                ? "border-foreground bg-foreground text-background"
                : "border-border text-foreground hover:bg-accent/60",
            )}
          >
            <DeviceStatusDot status={choice.status} />
            <span className="truncate">{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The device list All devices shows: the nav's device items, as rows that open each page. */
function DeviceList({
  devices,
  primaryEnvironmentId,
  onOpen,
}: {
  readonly devices: ReadonlyArray<SettingsDeviceChoice>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly onOpen: (environmentId: EnvironmentId) => void;
}) {
  if (devices.length === 0) {
    return (
      <SettingsCard>
        <SettingsEmpty
          icon={<MonitorIcon />}
          title="No devices yet"
          description="Devices this app connects to show up here."
        />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard>
      {devices.map((device) => (
        <button
          key={device.environmentId}
          type="button"
          disabled={device.disabled}
          onClick={() => onOpen(device.environmentId)}
          className="flex w-full min-w-0 items-center gap-3 border-t border-border/60 px-4 py-3 text-left outline-hidden transition-colors first:border-t-0 hover:bg-accent/40 focus-visible:bg-accent/40 disabled:opacity-50 sm:px-5"
        >
          <DeviceIcon
            environmentId={device.environmentId}
            label={device.label}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">
              {device.label}
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DeviceStatusDot status={device.status} />
              {device.status ? SETTINGS_NODE_STATUS_LABELS[device.status] : "Online"}
              {device.environmentId === primaryEnvironmentId && !isHostedHubMode()
                ? " · This computer"
                : null}
            </span>
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </SettingsCard>
  );
}

// Shortcuts list after the settings themselves, so a word like "new" shows settings first.
const SEARCH_ENTRIES = [...SETTINGS_SEARCH_INDEX, ...KEYBINDING_SEARCH_ENTRIES];

function SearchResults({
  query,
  results,
  deviceLabel,
  onPick,
}: {
  query: string;
  results: ReadonlyArray<SettingsSearchEntry>;
  deviceLabel: string | null;
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
          key={`${entry.storage}:${entry.section}:${entry.title}`}
          type="button"
          onClick={() => onPick(entry)}
          onPointerEnter={() => void preloadSettingsSection(entry.section)}
          onFocus={() => void preloadSettingsSection(entry.section)}
          style={{ "--i": Math.min(index, 12) } as CSSProperties}
          className="settings-search-result group/result flex min-w-0 items-start gap-4 rounded-lg px-3 py-2.5 text-left outline-hidden ring-ring transition-colors hover:bg-accent/60 focus-visible:ring-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-foreground">{entry.title}</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {entry.description}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground/80">
            {describeSettingsSearchEntry(entry, entry.storage === "device" ? deviceLabel : null)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Why the shown device's rows are not on screen, said once under the device bar. */
function DeviceNotice({
  devicePage,
  section,
  reach,
  label,
  environmentId,
  connected,
  status,
  machine,
}: {
  /** A device's page explains each part it cannot show; only its connection is said here. */
  readonly devicePage: boolean;
  readonly section: SettingsPageSectionId;
  readonly reach: SettingsReach;
  readonly label: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly status: SettingsNodeStatus | null;
  readonly machine: { readonly online: boolean; readonly canConnect: boolean } | null;
}) {
  const className =
    "mb-9 rounded-[min(var(--radius-xl),0.875rem)] border border-dashed border-border/80 py-12";
  if (label === null) {
    return (
      <SettingsEmpty
        icon={<MonitorIcon />}
        title="Choose a device"
        description="Pick a device above to see the settings it keeps."
        className={className}
      />
    );
  }
  if (!connected) {
    return (
      <SettingsEmpty
        icon={<DeviceIcon environmentId={environmentId} label={label} />}
        title={
          (machine && !machine.online) || status === "offline"
            ? `${label} is offline`
            : machine?.canConnect || status === "connecting"
              ? `Connecting to ${label}…`
              : `${label} isn't connected`
        }
        description={
          machine && !machine.online
            ? "Its settings will be available when it reconnects."
            : `Connect to ${label} to manage its settings.`
        }
        className={className}
      />
    );
  }
  const deviceParts = settingsSection(section).parts.filter(
    (storage) => storage === "device" || storage === "device-read",
  );
  if (!devicePage && !deviceParts.some((storage) => settingsStorageReachable(storage, reach))) {
    return (
      <SettingsEmpty
        icon={<ShieldIcon />}
        title="No settings you can change"
        description={`Your access to ${label} does not allow changing its settings.`}
        className={className}
      />
    );
  }
  return null;
}

export function SettingsPage() {
  const leaveSettings = useLeaveSettings();
  const appSidebarCollapsed = useAppSidebarCollapsed();
  const storeSection = useSettingsDialogStore((s) => s.section);
  const setSection = useSettingsDialogStore((s) => s.setSection);
  const closeSettings = useSettingsDialogStore((s) => s.closeSettings);
  const hosted = isHostedHubMode();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const pageTarget = useSettingsPageTarget();
  const {
    environmentId: targetEnvironmentId,
    target,
    isPrimary: targetIsPrimary,
    roleFresh,
    desktopWorkspaceMachine,
  } = pageTarget;
  const reach = readSettingsReach(pageTarget);

  const [searchQuery, setSearchQuery] = useState("");
  // One list of devices for the nav's device items and the device bar.
  const devices = useSettingsDevices({
    targetEnvironmentId,
    targetLabel: target?.nodeLabel ?? "",
    targetConnected: target?.connected === true,
    targetMachine: desktopWorkspaceMachine,
    onSelect: () => setSearchQuery(""),
  });

  const listedSections = SETTINGS_SECTIONS.map((section) => section.id).filter(
    (id) => id !== "device" && settingsSectionListed(id, reach),
  );
  const requestedSection = resolveSettingsPageSection(storeSection);
  const sectionShown = (id: SettingsPageSectionId) =>
    id === "device" ? target !== null : listedSections.includes(id) && !settingsSection(id).link;
  const effectiveSection: SettingsPageSectionId = sectionShown(requestedSection)
    ? requestedSection
    : (listedSections.find((id) => !settingsSection(id).link) ?? "appearance");
  const usesDevice = effectiveSection === "device" || sectionUsesDevice(effectiveSection);

  useEffect(() => {
    if (!usesDevice || !isElectron || !targetEnvironmentId || targetIsPrimary) return;
    return retainDesktopWorkspaceInteractiveScope(targetEnvironmentId);
  }, [usesDevice, targetEnvironmentId, targetIsPrimary]);
  // Hosted settings show the node the selection cursor is on, and their address
  // names no node, so the page holds that node's demand while it shows its values.
  useHostedNodePageDemand(usesDevice ? targetEnvironmentId : null);

  useEffect(() => {
    if (hosted && !roleFresh) return;
    if (storeSection !== effectiveSection) setSection(effectiveSection);
  }, [effectiveSection, hosted, roleFresh, setSection, storeSection]);

  // The command palette can ask for a row before this page mounts; a request
  // that arrives while it shows replaces any search in progress.
  const revealRequest = useSettingsSearchRevealStore((state) => state.request);
  const [searchTarget, setSearchTarget] = useState<SettingsSearchTarget | null>(revealRequest);
  if (revealRequest !== null && revealRequest !== searchTarget) {
    setSearchTarget(revealRequest);
    setSearchQuery("");
  }
  useEffect(() => {
    if (revealRequest) takeSettingsReveal(revealRequest);
  }, [revealRequest]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchResults = filterSettingsSearchEntries(
    searchQuery,
    readSettingsSearchScope(pageTarget),
    SEARCH_ENTRIES,
  );

  const [restoreSignal, setRestoreSignal] = useState(0);
  const handleRestored = useCallback(() => setRestoreSignal((value) => value + 1), []);

  const activeKey: NavKey =
    effectiveSection === "device" && targetEnvironmentId
      ? deviceNavKey(targetEnvironmentId)
      : effectiveSection;
  const panelKey = `${effectiveSection}:${usesDevice ? (targetEnvironmentId ?? "") : ""}`;
  const subsections = useSettingsSubsections(panelKey, normalizedQuery.length > 0, searchTarget);
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
    if (!searchTarget) scrollRef.current?.scrollTo({ top: 0 });
  }, [panelKey, searchTarget]);

  const selectSection = (section: SettingsPageSectionId) => {
    if (section === "account") {
      // The Hub account is a Hub page, never a section of this one.
      closeSettings();
      navigateHub({ kind: "account", section: "overview" });
      return;
    }
    setSearchTarget(null);
    setSearchQuery("");
    setSection(section);
  };
  const selectDevice = (environmentId: EnvironmentId) => {
    setSearchTarget(null);
    setSearchQuery("");
    setSection("device");
    devices.select(environmentId);
  };

  // Escape leaves settings unless something on the page wants the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (hasOpenEscapeOwner()) return;
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

  const searching = normalizedQuery.length > 0;
  const definition = settingsSection(effectiveSection);
  const targetLabel = target?.nodeLabel ?? null;
  const targetStatus =
    devices.choices.find((choice) => choice.environmentId === targetEnvironmentId)?.status ?? null;
  const devicePage = effectiveSection === "device" && target !== null;
  const activeLabel = devicePage ? (targetLabel ?? definition.title) : definition.title;

  return (
    <SidebarInset
      data-slot="settings-page"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
    >
      <SettingsPartsProvider
        value={{ reach, target, primaryEnvironmentId, onRestored: handleRestored }}
      >
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
                  setSearchTarget(null);
                  setSearchQuery(event.target.value);
                }}
                placeholder="Search settings"
                aria-label="Search settings"
                className="h-8 w-full rounded-lg border border-transparent bg-muted/60 pr-9 pl-8 text-[13px] outline-hidden transition-[background-color,border-color,box-shadow] placeholder:text-muted-foreground/70 hover:bg-muted focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/20 [&::-webkit-search-cancel-button]:appearance-none"
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
              sections={listedSections}
              devices={devices.choices}
              primaryEnvironmentId={primaryEnvironmentId}
              activeKey={activeKey}
              subsections={subsections}
              onSelectSection={selectSection}
              onSelectDevice={selectDevice}
            />
            <div
              ref={setScrollRef}
              className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
            >
              <div className="mx-auto w-full max-w-[52rem] px-5 pt-8 pb-24 sm:px-8 lg:px-10 lg:pt-10">
                <CompactSectionPicker
                  sections={listedSections}
                  devices={devices.choices}
                  activeKey={activeKey}
                  activeLabel={activeLabel}
                  onSelectSection={selectSection}
                  onSelectDevice={selectDevice}
                />
                {searching ? (
                  <SearchResults
                    query={searchQuery.trim()}
                    results={searchResults}
                    deviceLabel={targetLabel}
                    onPick={(entry) => {
                      const destination = settingsSearchEntryDestination(entry, {
                        target: targetEnvironmentId,
                        primary: primaryEnvironmentId,
                      });
                      setSearchTarget({ targetId: entry.targetId ?? entry.title });
                      setSearchQuery("");
                      setSection(destination.section);
                      if (
                        destination.environmentId &&
                        destination.environmentId !== targetEnvironmentId
                      )
                        devices.select(destination.environmentId);
                    }}
                  />
                ) : (
                  <div key={`${panelKey}:${restoreSignal}`} className="settings-panel-enter">
                    <header className="mb-8 min-w-0">
                      {devicePage ? (
                        <div className="flex items-center gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-[min(var(--radius-lg),0.625rem)] bg-muted text-muted-foreground">
                            <DeviceIcon
                              environmentId={targetEnvironmentId}
                              label={targetLabel ?? ""}
                              className="size-4.5"
                            />
                          </span>
                          <div className="min-w-0">
                            <h2 className="truncate text-xl font-semibold tracking-[-0.015em] text-foreground">
                              {targetLabel}
                            </h2>
                            <p
                              className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground"
                              data-testid="settings-destination-description"
                            >
                              <DeviceStatusDot status={targetStatus} />
                              {targetStatus ? SETTINGS_NODE_STATUS_LABELS[targetStatus] : "Online"}
                              {target?.primary && !hosted ? " · This computer" : null}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h2 className="text-xl font-semibold tracking-[-0.015em] text-foreground">
                            {definition.title}
                          </h2>
                          <p
                            className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground"
                            data-testid="settings-destination-description"
                          >
                            {definition.description}
                            {settingsSectionAppOnly(effectiveSection) ? (
                              <SettingsChip icon={<AppWindowIcon aria-hidden />}>
                                This app
                              </SettingsChip>
                            ) : null}
                          </p>
                        </>
                      )}
                    </header>
                    {usesDevice && !devicePage ? <DeviceBar model={devices} /> : null}
                    {usesDevice && (!devicePage || !settingsDeviceReady(target)) ? (
                      <DeviceNotice
                        devicePage={devicePage}
                        section={effectiveSection}
                        reach={reach}
                        label={targetLabel}
                        environmentId={targetEnvironmentId}
                        connected={settingsDeviceReady(target)}
                        status={targetStatus}
                        machine={desktopWorkspaceMachine}
                      />
                    ) : null}
                    <Suspense fallback={<PanelFallback />}>
                      {effectiveSection === "device" ? (
                        <SettingsDevicePage />
                      ) : effectiveSection === "account" ? null : (
                        <SettingsSectionPanel
                          section={effectiveSection}
                          deviceList={
                            <DeviceList
                              devices={devices.choices}
                              primaryEnvironmentId={primaryEnvironmentId}
                              onOpen={selectDevice}
                            />
                          }
                        />
                      )}
                    </Suspense>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </SettingsPartsProvider>
    </SidebarInset>
  );
}
