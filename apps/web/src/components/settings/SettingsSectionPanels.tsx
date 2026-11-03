import { useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@ryco/contracts";
import { ArrowUpRightIcon, LayersIcon, RotateCcwIcon } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";

import type * as AppearanceSettingsModule from "./AppearanceSettings";
import type * as ConnectionsModule from "./ConnectionsSettings";
import type * as NotificationsTestModule from "./NotificationsTestSection";
import type * as SourceControlModule from "./SourceControlSettings";
import { useAppPreferencesLabel } from "../../deviceName";
import { isHostedHubMode } from "../../env";
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
import {
  resolveSettingsPageSection,
  SETTINGS_DEVICE_PART_TITLES,
  type SettingsSectionId,
  type SettingsDevicePartId,
  type SettingsPageSectionId,
  type SettingsStorage,
} from "./settingsRegistry";
import { settingsStorageReachable, type SettingsReach } from "./settingsSections.logic";
import {
  SettingsChip,
  SettingsPageContainer,
  SettingsRow,
  SettingsRowChipProvider,
  SettingsSection,
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
  const { reach, target } = useSettingsParts();
  if (!settingsStorageReachable(storage, reach) || !settingsDeviceReady(target)) return null;
  return (
    <SettingsEditingScopeProvider value="node">
      <SettingsTargetProvider value={target}>
        <SettingsRowChipProvider value={chip ? PER_DEVICE_CHIP : null}>
          {children}
        </SettingsRowChipProvider>
      </SettingsTargetProvider>
    </SettingsEditingScopeProvider>
  );
}

const PER_DEVICE_CHIP = <SettingsChip icon={<LayersIcon aria-hidden />}>Per device</SettingsChip>;

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
const LazyClientSettingsFileActions = preloadableLazy(() =>
  import("./ClientSettingsFileActions").then((module) => module.ClientSettingsFileActions),
);

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
  providers: [LazyProvidersSettingsPanel],
  usage: [],
  plugins: [LazyOpinionatedPluginsSettingsPanel, LazyMcpServersSettings],
  "agent-control": [LazyAgentControlSettingsPanel],
  devices: [LazyConnectionsSettings],
  device: [LazyConnectionsSettings, LazyNodeSecuritySettings, LazyDeviceComputerUseSettings],
  updates: [LazyUpdatesSettings],
  data: [LazyClientSettingsFileActions],
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

function DeviceListSection({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsSection title="Devices" description="Open a device for its own settings." bare>
      {children}
    </SettingsSection>
  );
}

function SectionBody({
  section,
  deviceList,
}: {
  readonly section: Exclude<SettingsPageSectionId, "device" | "account">;
  readonly deviceList: ReactNode;
}) {
  const desktopBridge = window.desktopBridge;
  const appLabel = useAppPreferencesLabel();
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
            <LazyNodeSourceControlSettingsPanel includeWriting={false} />
          </DevicePart>
        </>
      );
    case "providers":
      return (
        <DevicePart>
          <LazyProvidersSettingsPanel />
        </DevicePart>
      );
    case "usage":
      return (
        <DevicePart>
          <UsageLimitSettings />
          <UsagePriceSettings />
          <StatisticsLinkSection />
        </DevicePart>
      );
    case "plugins":
      return (
        <DevicePart>
          <LazyOpinionatedPluginsSettingsPanel />
          <LazyMcpServersSettings />
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
          <AppPart>
            <DeviceListSection>{deviceList}</DeviceListSection>
          </AppPart>
          {isHostedHubMode() ? null : (
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
            <SessionImportSettings />
            <SettingsSection title="Chats">
              <ChatsFolderSettings />
            </SettingsSection>
            <StorageSettings />
            <DeviceLifecycleSuggestionSettings />
            <SettingsSection title="This device's defaults">
              <RestoreDefaultsRow
                title="Restore defaults"
                description="Reset this device's settings on this page's sections to their defaults."
              />
            </SettingsSection>
          </DevicePart>
          <AppPart>
            <SettingsSection title="Settings file" headerAction={<LazyClientSettingsFileActions />}>
              <RestoreDefaultsRow
                title="Restore defaults"
                description="Reset this app's settings to their defaults. Export a file first to keep a copy."
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
  /** All devices lists the nav's device items again, as rows. */
  readonly deviceList: ReactNode;
}) {
  return (
    <SettingsPageContainer>
      <SectionBody {...props} />
    </SettingsPageContainer>
  );
}

function DevicePagePart({
  part,
  children,
}: {
  readonly part: SettingsDevicePartId;
  readonly children: ReactNode;
}) {
  const title = SETTINGS_DEVICE_PART_TITLES[part];
  return (
    <section
      data-settings-part={title}
      className="flex min-w-0 scroll-mt-6 flex-col gap-4 border-t border-border/70 pt-6 first:border-t-0 first:pt-0"
    >
      <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      <div className="flex min-w-0 flex-col gap-9">{children}</div>
    </section>
  );
}

function DevicePartNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

/**
 * One device's own settings, stacked: identity, access, security, computer
 * use and power. Phase 2 of the settings redesign turns the parts into tabs.
 */
export function SettingsDevicePage() {
  const { reach, target } = useSettingsParts();
  if (!target) return null;
  const label = target.nodeLabel;
  const owner = settingsStorageReachable("device", reach);
  const desktopBridge = window.desktopBridge;
  const thisComputer = target.primary && settingsStorageReachable("this-computer", reach);
  // While the device is not connected the page says so once; its parts wait quietly.
  const ownerOnly = settingsDeviceReady(target) ? (
    <DevicePartNote>Only an owner of {label} can see and change this.</DevicePartNote>
  ) : null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-10">
      <DevicePagePart part="identity">
        {owner ? (
          <DevicePart chip={false}>
            <DeviceIdentitySettings />
          </DevicePart>
        ) : (
          ownerOnly
        )}
      </DevicePagePart>
      <DevicePagePart part="access">
        {thisComputer ? (
          <AppPart>
            <LazyConnectionsSettings part="access" />
          </AppPart>
        ) : (
          <DevicePartNote>
            Network access, pairing links and authorized clients are set on {label} itself. Its
            Security below shows who can reach it.
          </DevicePartNote>
        )}
      </DevicePagePart>
      <DevicePagePart part="security">
        {owner ? (
          <DevicePart chip={false}>
            <LazyNodeSecuritySettings />
          </DevicePart>
        ) : (
          ownerOnly
        )}
      </DevicePagePart>
      <DevicePagePart part="computer-use">
        <SettingsEditingScopeProvider value="node">
          <SettingsTargetProvider value={target}>
            <LazyDeviceComputerUseSettings />
          </SettingsTargetProvider>
        </SettingsEditingScopeProvider>
      </DevicePagePart>
      <DevicePagePart part="power">
        {thisComputer && desktopBridge?.setKeepAwakeMode ? (
          <AppPart>
            <SettingsSection title="Sleep">
              <DesktopKeepAwakeRow desktopBridge={desktopBridge} />
            </SettingsSection>
          </AppPart>
        ) : null}
        {owner ? (
          <DevicePart chip={false}>
            <AgentProcessPrioritySettings />
          </DevicePart>
        ) : (
          ownerOnly
        )}
      </DevicePagePart>
    </div>
  );
}
