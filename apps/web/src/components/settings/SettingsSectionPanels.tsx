import { useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@ryco/contracts";
import { ArrowUpRightIcon, InfoIcon, LayersIcon, RotateCcwIcon } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import type * as AppearanceSettingsModule from "./AppearanceSettings";
import type * as ConnectionsModule from "./ConnectionsSettings";
import type * as NotificationsTestModule from "./NotificationsTestSection";
import type * as ProviderDeviceTableModule from "./ProviderDeviceTable";
import type * as SettingsFileRowsModule from "./SettingsFileRows";
import type * as SourceControlModule from "./SourceControlSettings";
import { useAppPreferencesLabel } from "../../deviceName";
import { isElectron, isHostedHubMode } from "../../env";
import { openHubNodeDetail } from "../../hostedHub/hubNodeDetailRequest";
import { useHostedHubStore } from "../../hostedHub/state";
import { preloadableLazy, type PreloadableModule } from "../../lib/preloadableLazy";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import {
  SettingsEditingScopeProvider,
  SettingsTargetProvider,
  type SettingsTarget,
} from "../../settingsTarget";
import { OnboardingReplaySetting } from "../onboarding/OnboardingReplaySetting";
import { parseStatisticsSearch } from "../statistics/statisticsSearch";
import { Button } from "../ui/button";
import { SlidingTabs, slidingTabId, slidingTabPanelId } from "../ui/sliding-tabs";
import { CliCommandSettings } from "./CliCommandSettings";
import { ComposerSettings, SendShortcutSetting } from "./ComposerSettings";
import { ChatsFolderSettings } from "./ChatsFolderSettings";
import { DesktopConversationCacheRow } from "./DesktopConversationCacheRow";
import { DesktopKeepAwakeRow } from "./DesktopKeepAwakeRow";
import { DeviceIdentitySettings } from "./DeviceIdentitySettings";
import { OpenChatTabsSetting } from "./OpenChatTabsSetting";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import { QuitShortcutSetting } from "./QuitShortcutSetting";
import { ResponseStreamingSettings } from "./ResponseStreamingSettings";
import { SessionImportSettings } from "./SessionImportSettings";
import {
  AboutSettings,
  AgentProcessPrioritySettings,
  SimulatorSettings,
  ArchivedThreadsPanel,
  DefaultEditorSetting,
  DesktopUpdateTrackSettings,
  DeviceLifecycleSuggestionSettings,
  LogsFolderSetting,
  ProjectsAndThreadsSettings,
  ProviderUpdateCheckSettings,
  ThreadConfirmationSettings,
  useSettingsRestore,
} from "./SettingsPanels";
import { DiffDisplaySettings, PullRequestPreferenceSettings } from "./SourceControlPreferences";
import { StorageSettings } from "./StorageSettings";
import { ThreadNotificationSettings } from "./ThreadNotificationSettings";
import { UsageLimitSettings } from "./UsageLimitSettings";
import { UsagePriceSettings } from "./UsagePriceSettings";
import { WindowCaptureSettings, preloadWindowCaptureSettings } from "./WindowCaptureSettings";
import { SettingsDeviceCards, SettingsDeviceFactTiles } from "./SettingsDeviceCards";
import type { SettingsDeviceChoice } from "./useSettingsDevices";
import {
  resolveSettingsPageSection,
  SETTINGS_DEVICE_PARTS,
  type SettingsSectionId,
  type SettingsDevicePartId,
  type SettingsPageSectionId,
  type SettingsStorage,
} from "./settingsRegistry";
import {
  settingsSectionListed,
  settingsStorageReachable,
  type SettingsReach,
} from "./settingsSections.logic";
import { useSharedSettingsMode } from "./sharedSettings/sharedSettingsMode";
import { DeviceSettingsCompare } from "./sharedSettings/DeviceSettingsCompare";
import { DeviceSharingPrompts } from "./sharedSettings/DeviceSharingPrompt";
import { DeviceSharingDifferences } from "./sharedSettings/DeviceSharingDifferences";
import { PER_DEVICE_CHIP } from "./sharedSettings/SharedSettingRow";
import {
  SettingsChip,
  SettingsPageContainer,
  SettingsRow,
  SettingsRowChipProvider,
  SettingsSection,
  SHARED_ROWS_ONLY_CHILDREN_CLASS,
  SharedRowsOnlyProvider,
  DeviceBound,
  useRelativeLabelTick,
} from "./settingsLayout";

/**
 * What every part of the shown section needs to know: who may open which
 * part, and the device whose stored values device parts show.
 */
export interface SettingsPartsValue {
  readonly reach: SettingsReach;
  /** The device the page shows values for: the device bar's choice, or the device page's device. */
  readonly target: SettingsTarget | null;
  /** This app's own device, for parts that only exist on it. */
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** Called after a restore resets values, so the section remounts. */
  readonly onRestored: () => void;
  /**
   * "All devices" while the device bar's device cannot be used and `target` is another device
   * this client may write now: device parts show only their shared rows (`SharedRowsOnlyProvider`),
   * and parts stored on one device wait for it.
   */
  readonly sharedRowsOnly?: boolean;
}

const SettingsPartsContext = createContext<SettingsPartsValue | null>(null);
export const SettingsPartsProvider = SettingsPartsContext.Provider;

function useSettingsParts(): SettingsPartsValue {
  const value = useContext(SettingsPartsContext);
  if (!value) throw new Error("Settings parts render inside SettingsPartsProvider.");
  return value;
}

/**
 * Rows stored in this app. They edit this app's own preferences exactly as the
 * "This app" destination did, whichever device the page shows.
 */
function AppPart({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsEditingScopeProvider value="client">
      <SettingsTargetProvider value={null}>{children}</SettingsTargetProvider>
    </SettingsEditingScopeProvider>
  );
}

/** Whether device parts can show the shown device's values now. */
export function settingsDeviceReady(target: SettingsTarget | null): boolean {
  return target?.connected === true;
}

/**
 * Rows stored on the shown device. They read and write that one device, as
 * the device destination did. Hidden while the reader may not open them or the
 * device is not connected; the page says why once, under the device bar.
 */
function DevicePart({
  storage = "device",
  chip = true,
  children,
}: {
  readonly storage?: Extract<SettingsStorage, "device" | "device-read">;
  /** Mark each row "Per device". A device's own page needs no mark. */
  readonly chip?: boolean;
  readonly children: ReactNode;
}) {
  const { reach, target, sharedRowsOnly = false } = useSettingsParts();
  const { targetLabel } = useSharedSettingsMode();
  // Archived threads and the like belong to one device: they wait for the device bar's device.
  if (sharedRowsOnly && storage !== "device") return null;
  if (!settingsStorageReachable(storage, reach) || !settingsDeviceReady(target)) return null;
  // While "All devices" shows, a row that is not shared still edits the chosen device.
  const rowChip = !chip ? null : targetLabel === null || sharedRowsOnly ? (
    PER_DEVICE_CHIP
  ) : (
    <SettingsChip icon={<LayersIcon aria-hidden />}>On {targetLabel}</SettingsChip>
  );
  return (
    <SettingsEditingScopeProvider value="node">
      <SettingsTargetProvider value={target}>
        <SettingsRowChipProvider value={rowChip}>
          <SharedRowsOnlyProvider value={sharedRowsOnly}>
            {sharedRowsOnly ? (
              <div className={SHARED_ROWS_ONLY_CHILDREN_CLASS}>{children}</div>
            ) : (
              children
            )}
          </SharedRowsOnlyProvider>
        </SettingsRowChipProvider>
      </SettingsTargetProvider>
    </SettingsEditingScopeProvider>
  );
}

// Section bodies render synchronously once loaded: a `React.lazy` boundary
// committed its fallback on every first visit and React then held the section
// for up to 300 ms (its Suspense reveal throttle). Hovering or focusing a nav
// item, and the settings route loader for the open section, preload them.
const LazyAppearanceSettingsPanel = preloadableLazy<
  NonNullable<ComponentProps<typeof AppearanceSettingsModule.AppearanceSettingsPanel>>
>(() => import("./AppearanceSettings").then((module) => module.AppearanceSettingsPanel));
const LazyKeybindingsSettingsPanel = preloadableLazy(() =>
  import("./KeybindingsSettings").then((module) => module.KeybindingsSettingsPanel),
);
const LazyNotificationsTestSection = preloadableLazy<
  NonNullable<ComponentProps<typeof NotificationsTestModule.NotificationsTestSection>>
>(() => import("./NotificationsTestSection").then((module) => module.NotificationsTestSection));
const LazyInboxSettings = preloadableLazy(() =>
  import("./InboxSettings").then((module) => module.InboxSettings),
);
const LazyGitWritingSettingsSection = preloadableLazy(() =>
  import("./GitWritingStyleSettings").then((module) => module.GitWritingSettingsSection),
);
const LazyDiffAppearanceSettings = preloadableLazy(() =>
  import("./DiffAppearanceSettings").then((module) => module.DiffAppearanceSettings),
);
const LazyNodeSourceControlSettingsPanel = preloadableLazy<
  NonNullable<ComponentProps<typeof SourceControlModule.NodeSourceControlSettingsPanel>>
>(() => import("./SourceControlSettings").then((module) => module.NodeSourceControlSettingsPanel));
const LazyProvidersSettingsPanel = preloadableLazy(() =>
  import("./ProvidersSettingsPanel").then((module) => module.ProvidersSettingsPanel),
);
const LazyProviderDeviceTable = preloadableLazy<
  NonNullable<ComponentProps<typeof ProviderDeviceTableModule.ProviderDeviceTable>>
>(() => import("./ProviderDeviceTable").then((module) => module.ProviderDeviceTable));
const LazyOpinionatedPluginsSettingsPanel = preloadableLazy(() =>
  import("./OpinionatedPluginsSettings").then((module) => module.OpinionatedPluginsSettingsPanel),
);
const LazyMcpServersSettings = preloadableLazy(() =>
  import("./McpServersSettings").then((module) => module.McpServersSettings),
);
const LazyAgentControlSettingsPanel = preloadableLazy(() =>
  import("./IntegrationsSettingsPanel").then((module) => module.AgentControlSettingsPanel),
);
// Resolves with this computer's Computer Use controls (their own chunk) loaded,
// so the part's first commit includes them.
const LazyDeviceComputerUseSettings = preloadableLazy(() =>
  import("./IntegrationsSettingsPanel").then((module) => module.loadDeviceComputerUseSettings()),
);
const LazyConnectionsSettings = preloadableLazy<
  NonNullable<ComponentProps<typeof ConnectionsModule.ConnectionsSettings>>
>(() => import("./ConnectionsSettings").then((module) => module.ConnectionsSettings));
const LazyUpdatesSettings = preloadableLazy(() =>
  import("./UpdatesSettings").then((module) => module.UpdatesSettings),
);
const LazyNodeSecuritySettings = preloadableLazy(() =>
  import("./NodeSecuritySettings").then((module) => module.NodeSecuritySettings),
);
const LazyDiagnosticsSettings = preloadableLazy(() =>
  import("./DiagnosticsSettings").then((module) => module.DiagnosticsSettings),
);
const LazyTierPreviewSection = preloadableLazy(() =>
  import("./DiagnosticsSettings").then((module) => module.TierPreviewSection),
);
const LazySettingsFileRows = preloadableLazy<
  NonNullable<ComponentProps<typeof SettingsFileRowsModule.SettingsFileRows>>
>(() => import("./SettingsFileRows").then((module) => module.SettingsFileRows));

/** The code-split pieces each section renders, for its preload. */
const SECTION_CHUNKS: Readonly<Record<SettingsPageSectionId, ReadonlyArray<PreloadableModule>>> = {
  appearance: [LazyAppearanceSettingsPanel],
  keybindings: [LazyKeybindingsSettingsPanel],
  notifications: [LazyNotificationsTestSection],
  account: [],
  chat: [],
  inbox: [LazyInboxSettings],
  projects: [],
  "source-control": [
    LazyGitWritingSettingsSection,
    LazyDiffAppearanceSettings,
    LazyNodeSourceControlSettingsPanel,
  ],
  providers: [LazyProviderDeviceTable, LazyProvidersSettingsPanel],
  usage: [],
  plugins: [LazyOpinionatedPluginsSettingsPanel, LazyMcpServersSettings],
  "agent-control": [LazyAgentControlSettingsPanel],
  devices: [LazyConnectionsSettings],
  device: [LazyConnectionsSettings, LazyNodeSecuritySettings, LazyDeviceComputerUseSettings],
  updates: [LazyUpdatesSettings],
  data: [LazySettingsFileRows],
  diagnostics: [LazyDiagnosticsSettings],
  about: [],
};

/**
 * Starts (or joins) the chunk loads of a section's body, for any id a caller
 * may ask for (old ids load their new home). Never rejects.
 */
export function preloadSettingsSection(requested: SettingsSectionId): Promise<void> {
  const section = resolveSettingsPageSection(requested);
  const chunks = SECTION_CHUNKS[section].map((chunk) => chunk.preload());
  // Chat's Window capture loads a chunk of its own, on desktops that offer it.
  if (section === "chat") chunks.push(preloadWindowCaptureSettings());
  return Promise.all(chunks).then(() => undefined);
}

function RestoreDefaultsRow({ title, description }: { title: string; description: string }) {
  const { onRestored } = useSettingsParts();
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <Button
          size="xs"
          variant="outline"
          aria-label={title}
          disabled={changedSettingLabels.length === 0}
          onClick={() => void restoreDefaults()}
        >
          <RotateCcwIcon />
          Restore defaults
        </Button>
      }
    />
  );
}

function StatisticsLinkSection() {
  const router = useRouter();
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings);
  const { target } = useSettingsParts();
  return (
    <SettingsSection title="Statistics">
      <SettingsRow
        title="Usage and activity"
        description="Tokens, cost and activity over time."
        control={
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              closeSettings();
              void router.navigate({
                to: "/statistics",
                search: parseStatisticsSearch(
                  target ? { environmentIds: [target.environmentId] } : {},
                ),
              });
            }}
          >
            Open statistics
            <ArrowUpRightIcon />
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** What All devices lists: the nav's device items, and how to open one. */
export interface SettingsAllDevices {
  readonly choices: ReadonlyArray<SettingsDeviceChoice>;
  readonly onOpen: (environmentId: EnvironmentId) => void;
  /** Shows a device's values in the section (the bar's device), keeping the bar's view. */
  readonly select: (environmentId: EnvironmentId) => void;
}

function AllDevices({ devices }: { readonly devices: SettingsAllDevices }) {
  const { primaryEnvironmentId } = useSettingsParts();
  const nowMs = useRelativeLabelTick(
    devices.choices.map((device) => device.lastSeenAt ?? undefined),
  );
  return (
    <SettingsSection title="Devices" bare>
      <SettingsDeviceCards
        devices={devices.choices}
        primaryEnvironmentId={primaryEnvironmentId}
        nowMs={nowMs}
        onOpen={devices.onOpen}
      />
    </SettingsSection>
  );
}

/**
 * Every device's providers, offline devices too, for the owner of the shown device (as the
 * section's other rows); a cell edits only where this client may change that device.
 */
function ProvidersTable({ devices }: { readonly devices: SettingsAllDevices }) {
  const { reach, target } = useSettingsParts();
  // The table reads every device itself and each cell edits only a device this client may
  // change now, so a bar's device that is offline or still connecting (its role unknown) does
  // not hide it. Hosted, and for a device this reader does not own, the role decides.
  const barDeviceUnknown = !reach.hosted && !settingsDeviceReady(target);
  if (!settingsStorageReachable("device", reach) && !barDeviceUnknown) return null;
  return (
    <LazyProviderDeviceTable choices={devices.choices} target={target} select={devices.select} />
  );
}

function SectionBody({
  section,
  devices,
}: {
  readonly section: Exclude<SettingsPageSectionId, "device" | "account">;
  readonly devices: SettingsAllDevices;
}) {
  const desktopBridge = window.desktopBridge;
  const appLabel = useAppPreferencesLabel();
  const { reach, target } = useSettingsParts();
  switch (section) {
    case "appearance":
      return (
        <AppPart>
          <LazyAppearanceSettingsPanel surface="settings" />
        </AppPart>
      );
    case "keybindings":
      return (
        <AppPart>
          <SettingsSection title="Keys">
            <SendShortcutSetting />
            <QuitShortcutSetting />
          </SettingsSection>
          <LazyKeybindingsSettingsPanel />
        </AppPart>
      );
    case "notifications":
      return (
        <AppPart>
          <ThreadNotificationSettings scope={appLabel} />
          <LazyNotificationsTestSection title="Preview" />
        </AppPart>
      );
    case "chat":
      return (
        <>
          <AppPart>
            <ComposerSettings includeSendShortcut={false} />
          </AppPart>
          <DevicePart>
            <ResponseStreamingSettings />
          </DevicePart>
          <AppPart>
            <SettingsSection title="Tabs">
              <OpenChatTabsSetting />
            </SettingsSection>
            <WindowCaptureSettings scope={appLabel} />
          </AppPart>
        </>
      );
    case "inbox":
      return (
        <>
          <DevicePart>
            <LazyInboxSettings />
          </DevicePart>
          <AppPart>
            <SettingsSection title="Ask before">
              <ThreadConfirmationSettings />
            </SettingsSection>
          </AppPart>
          <DevicePart storage="device-read">
            <ArchivedThreadsPanel includeLifecycle={false} />
          </DevicePart>
        </>
      );
    case "projects":
      return (
        <>
          <DevicePart>
            <ProjectsAndThreadsSettings />
            <ProjectDefaultsSection includeChatsFolder={false} />
          </DevicePart>
          <AppPart>
            <SettingsSection title="Open in">
              <DefaultEditorSetting />
            </SettingsSection>
            <CliCommandSettings scope={appLabel} />
          </AppPart>
        </>
      );
    case "source-control":
      return (
        <>
          <DevicePart>
            <LazyGitWritingSettingsSection />
          </DevicePart>
          <AppPart>
            <PullRequestPreferenceSettings title="Pull requests" />
            <LazyDiffAppearanceSettings />
            <DiffDisplaySettings />
          </AppPart>
          <DevicePart>
            <DeviceBound>
              <LazyNodeSourceControlSettingsPanel includeWriting={false} />
            </DeviceBound>
          </DevicePart>
        </>
      );
    case "providers":
      return (
        <>
          <ProvidersTable devices={devices} />
          <DevicePart>
            <LazyProvidersSettingsPanel />
          </DevicePart>
        </>
      );
    case "usage":
      return (
        <DevicePart>
          <UsageLimitSettings />
          <UsagePriceSettings />
          <DeviceBound>
            <StatisticsLinkSection />
          </DeviceBound>
        </DevicePart>
      );
    case "plugins":
      return (
        <DevicePart>
          <LazyOpinionatedPluginsSettingsPanel />
          <DeviceBound>
            <LazyMcpServersSettings />
          </DeviceBound>
        </DevicePart>
      );
    case "agent-control":
      return (
        <DevicePart>
          <LazyAgentControlSettingsPanel />
        </DevicePart>
      );
    case "devices":
      return (
        <>
          <DeviceSharingPrompts />
          <AppPart>
            <AllDevices devices={devices} />
          </AppPart>
          <DeviceSettingsCompare canOpen={(id) => settingsSectionListed(id, reach)} />
          {isHostedHubMode() ? null : (
            // How this app reaches the devices above: its Hub link and saved environments.
            <AppPart>
              <LazyConnectionsSettings part="devices" />
            </AppPart>
          )}
        </>
      );
    case "updates":
      return (
        <>
          <AppPart>
            <LazyUpdatesSettings />
            <DesktopUpdateTrackSettings />
          </AppPart>
          <DevicePart>
            <ProviderUpdateCheckSettings />
          </DevicePart>
        </>
      );
    case "data":
      return (
        <>
          <DevicePart>
            <DeviceBound>
              <SessionImportSettings />
            </DeviceBound>
            <SettingsSection title="Chats">
              <ChatsFolderSettings />
            </SettingsSection>
            <DeviceBound>
              <StorageSettings />
            </DeviceBound>
            <DeviceLifecycleSuggestionSettings />
            <SettingsSection title="This device's defaults">
              <RestoreDefaultsRow
                title="Restore this device's defaults"
                description="Reset the settings this device keeps on this page's sections to their defaults. This app's settings stay."
              />
            </SettingsSection>
          </DevicePart>
          <AppPart>
            <SettingsSection title="Settings file">
              {/* A backup takes the shown device's value where the devices disagree. */}
              <LazySettingsFileRows shownEnvironmentId={target?.environmentId ?? null} />
              <RestoreDefaultsRow
                title="Restore this app's defaults"
                description="Reset this app's settings to their defaults. Devices keep theirs. Back up first to keep a copy."
              />
              {desktopBridge ? <DesktopConversationCacheRow desktopBridge={desktopBridge} /> : null}
            </SettingsSection>
          </AppPart>
        </>
      );
    case "diagnostics":
      return (
        <>
          <DevicePart>
            <SettingsSection title="Logs">
              <LogsFolderSetting title="Logs folder" />
            </SettingsSection>
            <LazyDiagnosticsSettings />
          </DevicePart>
          {import.meta.env.DEV ? (
            <AppPart>
              <LazyTierPreviewSection />
            </AppPart>
          ) : null}
        </>
      );
    case "about":
      return (
        <AppPart>
          <AboutSettings includeUpdateTrack={false}>
            <OnboardingReplaySetting />
          </AboutSettings>
        </AppPart>
      );
  }
}

/** The body of a section that is not a device's page. */
export function SettingsSectionPanel(props: {
  readonly section: Exclude<SettingsPageSectionId, "device" | "account">;
  /** All devices lists the nav's device items again, as cards. */
  readonly devices: SettingsAllDevices;
}) {
  return (
    <SettingsPageContainer>
      <SectionBody {...props} />
    </SettingsPageContainer>
  );
}

/** A hosted device's page on the Hub: its details, name, version and access. */
function HubDeviceLink({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const node = useHostedHubStore((state) =>
    state.nodes.find((candidate) => candidate.environmentId === environmentId),
  );
  if (!node) return null;
  return (
    <SettingsSection title="On the Hub">
      <SettingsRow
        title="Device details"
        description={`See ${label}'s version and when it was last seen, rename it or remove its access.`}
        control={
          <Button size="sm" variant="outline" onClick={() => openHubNodeDetail(node.id)}>
            Open on Hub
            <ArrowUpRightIcon />
          </Button>
        }
      />
    </SettingsSection>
  );
}

function DevicePartNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

const DEVICE_TABS_ID = "settings-device";

/** Each tab's code-split pieces, warmed when its tab is hovered or focused. */
const DEVICE_TAB_CHUNKS: Readonly<Record<SettingsDevicePartId, ReadonlyArray<PreloadableModule>>> =
  {
    overview: [],
    access: [LazyConnectionsSettings],
    security: [LazyNodeSecuritySettings],
    "computer-use": [LazyDeviceComputerUseSettings],
    simulators: [],
    power: [],
  };

/** Computer use is the desktop app's: its permissions are granted there (spec: desktop only). */
const DEVICE_TABS = SETTINGS_DEVICE_PARTS.filter(
  (part) => part.id !== "computer-use" || isElectron,
).map((part) => ({ id: part.id, label: part.title }));

/**
 * One device's own settings, a tab at a time: Overview (facts and identity),
 * Access, Security, Computer use and Power. The tab is part of where settings
 * are (`deviceTab` in the settings store, `tab` in the address), so a search
 * result, the command palette and Back open the same one.
 */
export function SettingsDevicePage({
  tab,
  onTabChange,
}: {
  readonly tab: SettingsDevicePartId;
  readonly onTabChange: (tab: SettingsDevicePartId) => void;
}) {
  const { reach, target } = useSettingsParts();
  if (!target) return null;
  // A tab this app does not offer (Computer use outside the desktop app) opens Overview.
  const shownTab: SettingsDevicePartId = DEVICE_TABS.some((entry) => entry.id === tab)
    ? tab
    : "overview";
  const label = target.nodeLabel;
  const ready = settingsDeviceReady(target);
  const owner = settingsStorageReachable("device", reach);
  const desktopBridge = window.desktopBridge;
  const thisComputer = target.primary && settingsStorageReachable("this-computer", reach);
  // Stored on the device: shown while it is connected, to its owners.
  const ownerPart = (children: ReactNode) =>
    !ready ? (
      <DevicePartNote>Shown when {label} is connected.</DevicePartNote>
    ) : owner ? (
      <DevicePart chip={false}>{children}</DevicePart>
    ) : (
      <DevicePartNote>Only an owner of {label} can see and change this.</DevicePartNote>
    );
  let body: ReactNode;
  switch (shownTab) {
    case "overview":
      body = (
        <>
          <DeviceSharingDifferences environmentId={target.environmentId} />
          <SettingsDeviceFactTiles environmentId={target.environmentId} />
          {ownerPart(<DeviceIdentitySettings />)}
        </>
      );
      break;
    case "access":
      body = thisComputer ? (
        <AppPart>
          <LazyConnectionsSettings part="access" />
        </AppPart>
      ) : (
        <>
          <DevicePartNote>
            Network access, pairing links and authorized clients are set on {label} itself. Its
            Security tab shows who can reach it.
          </DevicePartNote>
          {isHostedHubMode() ? (
            <HubDeviceLink environmentId={target.environmentId} label={label} />
          ) : null}
        </>
      );
      break;
    case "security":
      body = ownerPart(<LazyNodeSecuritySettings />);
      break;
    case "computer-use":
      body = (
        <SettingsEditingScopeProvider value="node">
          <SettingsTargetProvider value={target}>
            <LazyDeviceComputerUseSettings />
          </SettingsTargetProvider>
        </SettingsEditingScopeProvider>
      );
      break;
    case "simulators":
      body = ownerPart(<SimulatorSettings />);
      break;
    case "power":
      body = (
        <>
          {thisComputer && desktopBridge?.setKeepAwakeMode ? (
            <AppPart>
              <SettingsSection title="Sleep">
                <DesktopKeepAwakeRow desktopBridge={desktopBridge} />
              </SettingsSection>
            </AppPart>
          ) : null}
          {ownerPart(<AgentProcessPrioritySettings />)}
        </>
      );
      break;
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-7">
      <SlidingTabs
        tabs={DEVICE_TABS}
        activeId={shownTab}
        onSelect={(id) => onTabChange(id as SettingsDevicePartId)}
        onTabIntent={(id) => {
          for (const chunk of DEVICE_TAB_CHUNKS[id as SettingsDevicePartId]) void chunk.preload();
        }}
        variant="underline"
        idPrefix={DEVICE_TABS_ID}
        aria-label={`${label} settings`}
        className="h-9 gap-2 border-b border-border/70"
        tabClassName="text-[13px]"
      />
      <div
        key={shownTab}
        role="tabpanel"
        id={slidingTabPanelId(DEVICE_TABS_ID, shownTab)}
        aria-labelledby={slidingTabId(DEVICE_TABS_ID, shownTab)}
        className="settings-panel-enter flex min-w-0 flex-col gap-9"
      >
        {body}
      </div>
    </div>
  );
}

/** The offline banner a device page shows above its tabs. */
export function SettingsDeviceOfflineBanner({ label }: { readonly label: string }) {
  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-2.5 rounded-[min(var(--radius-lg),0.625rem)] bg-muted px-3 py-2.5 text-xs leading-relaxed text-foreground"
    >
      <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
      <span>
        {label} is offline. Its own settings show again when it reconnects; shared settings you
        change meanwhile reach it then.
      </span>
    </div>
  );
}
