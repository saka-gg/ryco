import { Schema } from "effect";
import { useServerConfig } from "../../rpc/serverState";
import { ProjectDefaultsSection } from "./ProjectDefaultsSection";
import { StorageSettings } from "./StorageSettings";
import { DeviceHostsSettings } from "./DeviceHostsSettings";
import { DeviceIdentitySettings } from "./DeviceIdentitySettings";
import { SessionImportSettings } from "./SessionImportSettings";
import { useAppPreferencesLabel } from "../../deviceName";
import { settingsRestorePlan } from "./settingsRestore";
import { selectArchivedThreadGroups } from "@ryco/client-runtime/state/threads/archivedThreadGroups";
import { OnboardingReplaySetting } from "../onboarding/OnboardingReplaySetting";
import { SourceControlPreferences } from "./SourceControlPreferences";
import { ComposerSettings } from "./ComposerSettings";
import { TimeFormatSetting } from "./TimeFormatSetting";
import { QuitShortcutSetting } from "./QuitShortcutSetting";
import { ThreadNotificationSettings } from "./ThreadNotificationSettings";
import { WindowCaptureSettings } from "./WindowCaptureSettings";
import { CliCommandSettings } from "./CliCommandSettings";
import { UsageLimitSettings } from "./UsageLimitSettings";
import { UsagePriceSettings } from "./UsagePriceSettings";
import { ResponseStreamingSettings } from "./ResponseStreamingSettings";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";
import { ArchiveIcon, ArchiveX, MessageCircleDashedIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ORCHESTRATION_WS_METHODS,
  EDITORS,
  type EditorId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { CHAT_PROJECT_LABEL } from "@ryco/client-runtime/state/composer";
import { DEFAULT_UNIFIED_SETTINGS, WorktreeBranchPrefix } from "@ryco/contracts/settings";
import { APP_BASE_NAME, APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import {
  isEditorPreferenceEligible,
  resolveAndPersistPreferredEditor,
} from "../../editorPreferences";
import { isElectron } from "../../env";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { useLongPress } from "../../hooks/useLongPress";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { setDesktopUpdateState, useDesktopUpdateState } from "../../rpc/desktopUpdateAtoms";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsNotice,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { LifecycleSuggestionSettings } from "./LifecycleSettings";
import { LIFECYCLE_RETENTION_COPY } from "@ryco/client-runtime/state/lifecycle";
import { ProjectFavicon } from "../ProjectFavicon";
import { RycoLetterMark } from "../RycoLetterMark";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import { describeDesktopUpdateTrack } from "./desktopUpdateTrack";
import { NightlyAppSettings } from "./NightlyAppSettings";
import { getEditorIcon, getEditorLabel } from "./SettingsPanels.editor";
import { isNodeSettingsTargetReadOnly, settingsScopeLabel } from "./settingsSections.logic";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";

function EditorOptionIcon({ editor }: { editor: EditorId }) {
  const IconComponent = getEditorIcon(editor, navigator.platform);
  if (!IconComponent) return null;
  return <IconComponent aria-hidden="true" className="size-4 text-muted-foreground" />;
}

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

const REPOSITORY_URL = "https://github.com/saka-gg/ryco";

function openExternalLink(url: string) {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open link",
          description: error instanceof Error ? error.message : "Failed to open external link.",
        }),
      );
    });
}

function AboutBrandingHeader() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 pt-6 pb-5 text-center sm:px-5">
      <RycoLetterMark className="h-14 text-foreground" />
      <h3 className="text-base font-semibold tracking-tight text-foreground">{APP_BASE_NAME}</h3>
      <div className="space-y-0.5 text-[11px] text-muted-foreground">
        <p>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => openExternalLink(REPOSITORY_URL)}
          >
            github.com/saka-gg/ryco
          </Button>
        </p>
      </div>
    </div>
  );
}

function UpdateTrackRow({ scopeLabel }: { readonly scopeLabel: string }) {
  const updateState = useDesktopUpdateState();
  const updateTrack = describeDesktopUpdateTrack({
    channel: updateState?.channel ?? "latest",
    currentVersion: updateState?.currentVersion ?? "",
  });
  return (
    <SettingsRow
      title="Update track"
      description={updateTrack.description}
      scope={scopeLabel}
      control={<span className="text-sm text-muted-foreground">{updateTrack.label}</span>}
    />
  );
}

function AboutVersionSection({
  scopeLabel,
  includeUpdateTrack,
}: {
  readonly scopeLabel: string;
  readonly includeUpdateTrack: boolean;
}) {
  const updateState = useDesktopUpdateState();

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: error instanceof Error ? error.message : "Download failed.",
            }),
          );
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateState(result.state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateState(result.state);
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: "Download",
    install: "Install",
  };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        scope={scopeLabel}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {includeUpdateTrack ? <UpdateTrackRow scopeLabel={scopeLabel} /> : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const editingScope = useSettingsEditingScope();
  const plan = settingsRestorePlan(settings, theme, editingScope);
  const changedSettingLabels = plan.labels;
  const restoreDefaults = useCallback(async () => {
    if (plan.labels.length === 0) return;
    const confirmed = await (readLocalApi() ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${plan.labels.join(", ")}.`].join("\n"),
    );
    if (!confirmed) return;
    if (plan.resetTheme) setTheme("system");
    updateSettings(plan.patch);
    onRestored?.();
  }, [plan, onRestored, setTheme, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

/** The scope labels a General block's rows carry, for this app and the device shown. */
function useGeneralScopeLabels() {
  const settingsTarget = useSettingsTarget();
  const appLabel = useAppPreferencesLabel();
  const scopeOptions = {
    appLabel,
    nativeClient: isElectron,
    nodeLabel: settingsTarget?.nodeLabel ?? null,
  };
  return {
    local: settingsScopeLabel("browser", scopeOptions),
    device: settingsScopeLabel("device", scopeOptions),
    node: settingsScopeLabel("node", scopeOptions),
  };
}

/** The editor that opens folders and files. Projects & worktrees on the settings page. */
export function DefaultEditorSetting() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const availableEditors = useServerAvailableEditors();
  const localScopeLabel = useGeneralScopeLabels().local;
  return (
    <SettingsRow
      title="Default editor"
      description={
        (availableEditors ?? []).length > 0
          ? "Pin which editor opens directories and files. Auto uses your last selection from the Open menu."
          : "No installed editors detected. Install a supported IDE to pick a default."
      }
      owner="client"
      scope={localScopeLabel}
      resetAction={
        settings.preferredEditor !== DEFAULT_UNIFIED_SETTINGS.preferredEditor ? (
          <SettingResetButton
            label="default editor"
            onClick={() =>
              updateSettings({
                preferredEditor: DEFAULT_UNIFIED_SETTINGS.preferredEditor,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={settings.preferredEditor ?? "__auto__"}
          onValueChange={(value) => {
            if (value === "__auto__") {
              updateSettings({ preferredEditor: null });
              return;
            }
            const match = EDITORS.find((e) => e.id === value);
            if (match) updateSettings({ preferredEditor: match.id as EditorId });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Default editor">
            {settings.preferredEditor ? (
              <EditorOptionIcon editor={settings.preferredEditor} />
            ) : null}
            <SelectValue>
              {settings.preferredEditor
                ? getEditorLabel(settings.preferredEditor, navigator.platform)
                : "Auto (last used)"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="__auto__">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="size-4" />
                Auto (last used)
              </span>
            </SelectItem>
            {EDITORS.filter(
              (editor) =>
                (availableEditors ?? []).includes(editor.id) &&
                isEditorPreferenceEligible(editor.id),
            ).map((editor) => (
              <SelectItem key={editor.id} hideIndicator value={editor.id}>
                <span className="inline-flex items-center gap-2">
                  <EditorOptionIcon editor={editor.id} />
                  {getEditorLabel(editor.id, navigator.platform)}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Whether the device checks its provider CLIs for updates. Updates on the settings page. */
export function ProviderUpdateCheckSettings() {
  return (
    <SettingsSection title="Provider updates" owner="node">
      <SharedSettingRow
        settingKey="enableProviderUpdateChecks"
        description="Check installed provider CLIs for newer versions. Disable if you install providers with Nix or another package manager."
        defaultValue={DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks}
        resetLabel="provider update checks"
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Check providers for updates", control)}
          />
        )}
      />
    </SettingsSection>
  );
}

/** Agent CPU priority on the device. A device page's Power on the settings page. */
export function AgentProcessPrioritySettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const supportsAgentProcessPriority =
    serverConfig?.environment.capabilities.agentProcessPriority === true;
  const settingsTarget = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  // As for usage-limit recovery: an older node would drop the key, and client-only editing or an
  // unreachable or read-only node cannot change it.
  const agentProcessPriorityDisabled =
    !supportsAgentProcessPriority || isNodeSettingsTargetReadOnly(editingScope, settingsTarget);
  const nodeScopeLabel = useGeneralScopeLabels().node;
  return (
    <SettingsSection title="Agent processes" owner="node">
      <SettingsRow
        title="Lower agent CPU priority"
        description="Run agents and everything they start (tests, builds, browsers) at a lower CPU priority, so Ryco, its UI and Git stay responsive when agents load this machine. Applies to agents started after the change (OpenCode: when its shared server restarts)."
        owner="node"
        scope={nodeScopeLabel}
        status={
          supportsAgentProcessPriority
            ? undefined
            : "This node does not support agent priority. Update the node to change this setting."
        }
        resetAction={
          !agentProcessPriorityDisabled &&
          settings.lowerAgentProcessPriority !==
            DEFAULT_UNIFIED_SETTINGS.lowerAgentProcessPriority ? (
            <SettingResetButton
              label="lower agent CPU priority"
              onClick={() =>
                updateSettings({
                  lowerAgentProcessPriority: DEFAULT_UNIFIED_SETTINGS.lowerAgentProcessPriority,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.lowerAgentProcessPriority}
            disabled={agentProcessPriorityDisabled}
            onCheckedChange={(checked) =>
              updateSettings({ lowerAgentProcessPriority: Boolean(checked) })
            }
            aria-label="Lower agent CPU priority"
          />
        }
      />
    </SettingsSection>
  );
}

/**
 * Simulators and emulators on the device: whether Ryco uses them at all, and whether agents get
 * the device tools. A device page's Simulators tab on the settings page.
 */
export function SimulatorSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const supported = serverConfig?.environment.capabilities.deviceSettings === true;
  const settingsTarget = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  // An older node would drop the keys, and client-only editing or an unreachable or read-only
  // node cannot change them.
  const disabled = !supported || isNodeSettingsTargetReadOnly(editingScope, settingsTarget);
  const nodeScopeLabel = useGeneralScopeLabels().node;
  const status = supported
    ? undefined
    : "This node does not support these settings. Update the node to change them.";
  const resetFor = (key: "devicesEnabled" | "agentDevicesEnabled", label: string) =>
    !disabled && settings[key] !== DEFAULT_UNIFIED_SETTINGS[key] ? (
      <SettingResetButton
        label={label}
        onClick={() => updateSettings({ [key]: DEFAULT_UNIFIED_SETTINGS[key] })}
      />
    ) : null;
  return (
    <>
      <SettingsSection title="Simulators" owner="node">
        <SettingsRow
          title="Use simulators"
          description="Run iOS Simulators and Android Emulators from Ryco: the device pane in chats, and the device tools agents use. Off stops new boots and attaches; running devices keep running until you shut them down."
          owner="node"
          scope={nodeScopeLabel}
          status={status}
          resetAction={resetFor("devicesEnabled", "use simulators")}
          control={
            <Switch
              checked={settings.devicesEnabled}
              disabled={disabled}
              onCheckedChange={(checked) => updateSettings({ devicesEnabled: Boolean(checked) })}
              aria-label="Use simulators"
            />
          }
        />
        <SettingsRow
          title="Agents can use simulators"
          description="Give agents Ryco's device tools to read the screen, tap, type and launch apps on simulators. Applies to agent sessions started after the change; a running session is refused at its next device call once this is off."
          owner="node"
          scope={nodeScopeLabel}
          status={
            status ?? (settings.devicesEnabled ? undefined : "Off while Use simulators is off.")
          }
          resetAction={resetFor("agentDevicesEnabled", "agents can use simulators")}
          control={
            <Switch
              checked={settings.devicesEnabled && settings.agentDevicesEnabled}
              disabled={disabled || !settings.devicesEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ agentDevicesEnabled: Boolean(checked) })
              }
              aria-label="Agents can use simulators"
            />
          }
        />
      </SettingsSection>
      <DeviceHostsSettings />
    </>
  );
}

/** New threads and worktree defaults stored on the device. Projects & worktrees on the settings page. */
export function ProjectsAndThreadsSettings() {
  const isPhoneTier = usePresentationTier() === "phone";
  const serverConfig = useServerConfig();
  const supportsProjectPreferences =
    serverConfig?.environment.capabilities.projectPreferences === true;
  return (
    <SettingsSection title="Projects & threads">
      {(!supportsProjectPreferences || isPhoneTier) && (
        <>
          <SharedSettingRow
            settingKey="defaultThreadEnvMode"
            description="Pick the default workspace mode for newly created draft threads."
            defaultValue={DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode}
            resetLabel="new threads"
            render={(control) => (
              <Select
                value={control.value}
                disabled={control.disabled}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") control.onChange(value);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-44"
                  aria-label={sharedControlLabel("Default thread mode", control)}
                >
                  <SelectValue>
                    {control.value === "worktree" ? "New worktree" : "Local"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="local">
                    Local
                  </SelectItem>
                  <SelectItem hideIndicator value="worktree">
                    New worktree
                  </SelectItem>
                </SelectPopup>
              </Select>
            )}
          />

          {!isPhoneTier && (
            <SharedSettingRow
              settingKey="worktreeBranchPrefix"
              description="Prefix for generated branches on this device. Use a Git namespace such as team/agent, without a trailing slash. Leave empty for no prefix. Existing branches keep their names."
              defaultValue={DEFAULT_UNIFIED_SETTINGS.worktreeBranchPrefix}
              resetLabel="worktree branch prefix"
              render={(control) => (
                <DraftInput
                  className="w-full sm:w-72"
                  value={control.value}
                  disabled={control.disabled}
                  onCommit={(next) => {
                    const prefix = next.trim();
                    if (!Schema.is(WorktreeBranchPrefix)(prefix)) {
                      toastManager.add({
                        type: "error",
                        title: "Invalid worktree branch prefix",
                        description:
                          "Use a valid Git namespace of up to 128 characters without a trailing slash, or leave it empty.",
                      });
                      return;
                    }
                    control.onChange(prefix);
                  }}
                  placeholder="ryco"
                  spellCheck={false}
                  autoCapitalize="none"
                  aria-label={sharedControlLabel("Worktree branch prefix", control)}
                />
              )}
            />
          )}
        </>
      )}

      {/* Every node has it, also one with project defaults, where a project may override it. */}
      {!isPhoneTier && (
        <SharedSettingRow
          settingKey="worktreeBranchChangeTypes"
          description="Generated worktree branches start with the kind of change, such as fix/ or feat/, instead of the prefix. The prefix still names a new worktree's temporary branch until its first message is named."
          defaultValue={DEFAULT_UNIFIED_SETTINGS.worktreeBranchChangeTypes}
          resetLabel="change type branch names"
          render={(control) => (
            <Switch
              checked={control.value}
              disabled={control.disabled}
              onCheckedChange={(checked) => control.onChange(Boolean(checked))}
              aria-label={sharedControlLabel("Name worktree branches by change type", control)}
            />
          )}
        />
      )}

      {!isPhoneTier && (
        <SharedSettingRow
          settingKey="continueThreadsAfterRestart"
          description="When Ryco restarts while an agent is working, send “Continue where you left off.” automatically. Threads you stopped, threads waiting for your approval, and restarts more than 30 minutes later are not continued."
          defaultValue={DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterRestart}
          resetLabel="continue after restart"
          render={(control) => (
            <Switch
              checked={control.value}
              disabled={control.disabled}
              onCheckedChange={(checked) => control.onChange(Boolean(checked))}
              aria-label={sharedControlLabel(
                "Continue threads automatically after a restart",
                control,
              )}
            />
          )}
        />
      )}

      <SharedSettingRow
        settingKey="addProjectBaseDirectory"
        description='Leave empty to use "~/" when the Add Project browser opens.'
        defaultValue={DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory}
        resetLabel="add project base directory"
        render={(control) => (
          <DraftInput
            className="w-full sm:w-72"
            value={control.value}
            disabled={control.disabled}
            onCommit={(next) => control.onChange(next)}
            placeholder="~/"
            spellCheck={false}
            aria-label={sharedControlLabel("Add project base directory", control)}
          />
        )}
      />
    </SettingsSection>
  );
}

/** Ask before archiving, deleting or unpinning a thread. Rows of a confirmations section. */
export function ThreadConfirmationSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const localScopeLabel = useGeneralScopeLabels().local;
  return (
    <>
      <SettingsRow
        title="Archive confirmation"
        description="Require a second click on the inline archive action before a thread is archived."
        owner="client"
        scope={localScopeLabel}
        resetAction={
          settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
            <SettingResetButton
              label="archive confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadArchive}
            onCheckedChange={(checked) =>
              updateSettings({ confirmThreadArchive: Boolean(checked) })
            }
            aria-label="Confirm thread archiving"
          />
        }
      />

      <SettingsRow
        title="Delete confirmation"
        description="Ask before deleting a thread. Undo stays available for a few seconds either way."
        owner="client"
        scope={localScopeLabel}
        resetAction={
          settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
            <SettingResetButton
              label="Delete confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadDelete}
            onCheckedChange={(checked) => updateSettings({ confirmThreadDelete: Boolean(checked) })}
            aria-label="Confirm thread deletion"
          />
        }
      />

      <SettingsRow
        title="Unpin confirmation"
        description="Ask before removing a thread from the pinned section."
        owner="client"
        scope={localScopeLabel}
        resetAction={
          settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
            <SettingResetButton
              label="unpin confirmation"
              onClick={() =>
                updateSettings({
                  confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmThreadUnpin}
            onCheckedChange={(checked) => updateSettings({ confirmThreadUnpin: Boolean(checked) })}
            aria-label="Confirm thread unpinning"
          />
        }
      />
    </>
  );
}

/** Ryco's name, version and source. About & help on the settings page. */
export function AboutSettings({
  includeUpdateTrack,
  children,
}: {
  /** The settings page shows the update track and Nightly under Updates. */
  readonly includeUpdateTrack: boolean;
  readonly children?: ReactNode;
}) {
  const isPhoneTier = usePresentationTier() === "phone";
  const editingScope = useSettingsEditingScope();
  const labels = useGeneralScopeLabels();
  return (
    <SettingsSection title="About">
      {editingScope !== "node" && <AboutBrandingHeader />}
      {isElectron && editingScope !== "node" ? (
        <AboutVersionSection scopeLabel={labels.device} includeUpdateTrack={includeUpdateTrack} />
      ) : (
        <SettingsRow
          title={<AboutVersionTitle />}
          description="Current version of the application."
          owner="client"
          scope={labels.local}
        />
      )}
      {includeUpdateTrack && isElectron && !isPhoneTier && editingScope !== "node" && (
        <NightlyAppSettings scope={labels.device} />
      )}
      {children}
    </SettingsSection>
  );
}

/** The update track and Ryco Nightly of this desktop app. Updates on the settings page. */
export function DesktopUpdateTrackSettings() {
  const labels = useGeneralScopeLabels();
  if (!isElectron) return null;
  return (
    <SettingsSection title="This app">
      <UpdateTrackRow scopeLabel={labels.device} />
      <NightlyAppSettings scope={labels.device} />
    </SettingsSection>
  );
}

/** Where the device writes its logs, and a way to open them. */
export function LogsFolderSetting({ title = "Diagnostics" }: { readonly title?: string } = {}) {
  const settingsTarget = useSettingsTarget();
  const nodeScopeLabel = useGeneralScopeLabels().node;
  const [openingPathByTarget, setOpeningPathByTarget] = useState({
    logsDirectory: false,
  });
  const [openPathErrorByTarget, setOpenPathErrorByTarget] = useState<
    Partial<Record<"logsDirectory", string | null>>
  >({});

  const availableEditors = useServerAvailableEditors();
  const observability = useServerObservability();
  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
  const canOpenNodePathLocally = !settingsTarget || settingsTarget.primary;
  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const openInPreferredEditor = useCallback(
    (target: "logsDirectory", path: string | null, failureMessage: string) => {
      if (!path) return;
      setOpenPathErrorByTarget((existing) => ({ ...existing, [target]: null }));
      setOpeningPathByTarget((existing) => ({ ...existing, [target]: true }));

      const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
      if (!editor) {
        setOpenPathErrorByTarget((existing) => ({
          ...existing,
          [target]: "No available editors found.",
        }));
        setOpeningPathByTarget((existing) => ({
          ...existing,
          [target]: false,
        }));
        return;
      }

      void ensureLocalApi()
        .shell.openInEditor(path, editor)
        .catch((error) => {
          setOpenPathErrorByTarget((existing) => ({
            ...existing,
            [target]: error instanceof Error ? error.message : failureMessage,
          }));
        })
        .finally(() => {
          setOpeningPathByTarget((existing) => ({
            ...existing,
            [target]: false,
          }));
        });
    },
    [availableEditors],
  );

  const openLogsDirectory = useCallback(() => {
    openInPreferredEditor("logsDirectory", logsDirectoryPath, "Unable to open logs folder.");
  }, [logsDirectoryPath, openInPreferredEditor]);

  const openDiagnosticsError = openPathErrorByTarget.logsDirectory ?? null;
  const isOpeningLogsDirectory = openingPathByTarget.logsDirectory;

  return (
    <SettingsRow
      title={title}
      description={diagnosticsDescription}
      owner="node"
      scope={nodeScopeLabel}
      status={
        <>
          <span className="block break-all font-mono text-[11px] text-foreground">
            {logsDirectoryPath ?? "Resolving logs directory..."}
          </span>
          {openDiagnosticsError ? (
            <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
          ) : !canOpenNodePathLocally ? (
            <span className="mt-1 block">
              This path is on {settingsTarget?.nodeLabel}; open it from that machine.
            </span>
          ) : null}
        </>
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={!canOpenNodePathLocally || !logsDirectoryPath || isOpeningLogsDirectory}
          onClick={openLogsDirectory}
        >
          {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
        </Button>
      }
    />
  );
}

/**
 * The retired General section, for the frozen web phone tier only
 * (`PhoneSettingsSurface`; AGENTS.md: that tier is not extended). The settings
 * page shows these blocks in their new sections instead.
 */
export function GeneralSettingsPanel() {
  const isPhoneTier = usePresentationTier() === "phone";
  const editingScope = useSettingsEditingScope();
  const deviceScopeLabel = useGeneralScopeLabels().device;
  return (
    <SettingsPageContainer>
      <DeviceIdentitySettings />
      <SessionImportSettings />
      <SettingsSection title="Behavior" owner="client">
        <OnboardingReplaySetting />
        <TimeFormatSetting />
        <DefaultEditorSetting />
      </SettingsSection>
      {isPhoneTier && <SourceControlPreferences />}
      {!isPhoneTier && <ResponseStreamingSettings />}
      <ProviderUpdateCheckSettings />
      {!isPhoneTier && <AgentProcessPrioritySettings />}
      {!isPhoneTier && <UsageLimitSettings />}
      {!isPhoneTier && <UsagePriceSettings />}
      {!isPhoneTier && editingScope !== "node" && <ComposerSettings />}
      {!isPhoneTier && <ProjectDefaultsSection />}
      {!isPhoneTier && <StorageSettings />}
      <ProjectsAndThreadsSettings />
      <SettingsSection title="Confirmations" owner="client">
        {!isPhoneTier && <QuitShortcutSetting />}
        <ThreadConfirmationSettings />
      </SettingsSection>
      {!isPhoneTier && editingScope !== "node" && (
        <ThreadNotificationSettings scope={deviceScopeLabel} />
      )}

      {!isPhoneTier && editingScope !== "node" && (
        <WindowCaptureSettings scope={deviceScopeLabel} />
      )}

      {!isPhoneTier && editingScope !== "node" && <CliCommandSettings scope={deviceScopeLabel} />}

      <AboutSettings includeUpdateTrack>
        <LogsFolderSetting />
      </AboutSettings>
    </SettingsPageContainer>
  );
}

/**
 * Lifecycle suggestions, shared across devices; each device's row is writable while this
 * client may change that device's settings. Data & backup on the settings page.
 */
export function DeviceLifecycleSuggestionSettings() {
  return <LifecycleSuggestionSettings disabled={false} />;
}

export function ArchivedThreadsPanel({
  includeLifecycle = true,
}: {
  /** The settings page shows lifecycle suggestions under Data & backup. */
  readonly includeLifecycle?: boolean;
} = {}) {
  const target = useSettingsTarget();
  const targetAllowsMutation = !target || (target.connected && target.canMutate !== false);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(
    () => selectArchivedThreadGroups(projects, threads, target?.environmentId),
    [projects, threads, target?.environmentId],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (
      threadRef: ScopedThreadRef,
      position: { x: number; y: number },
      mutation: ArchivedThreadMutation,
    ) => {
      if (!mutation.allowed) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Archived thread is read-only",
            description: mutation.reason ?? "This action is unavailable.",
          }),
        );
        return;
      }
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete…", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      <SettingsNotice tone="info" title="Retention">
        {LIFECYCLE_RETENTION_COPY.archive} {LIFECYCLE_RETENTION_COPY.permanentDelete}
      </SettingsNotice>
      {archivedGroups.length === 0 ? (
        <SettingsSection title="Archived threads">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
              <EmptyDescription>Archived threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        archivedGroups.map((group) => (
          <SettingsSection
            key={group.key}
            title={group.kind === "project" ? group.project.name : CHAT_PROJECT_LABEL}
            icon={
              group.kind === "project" ? (
                <ProjectFavicon
                  environmentId={group.project.environmentId}
                  cwd={group.project.cwd}
                  projectId={group.project.id}
                  customAvatarContentHash={group.project.customAvatarContentHash ?? null}
                />
              ) : (
                <MessageCircleDashedIcon aria-hidden />
              )
            }
          >
            <ArchivedThreadRows
              environmentId={
                group.kind === "project" ? group.project.environmentId : group.environmentId
              }
              threads={group.threads}
              targetAllowsMutation={targetAllowsMutation}
              onOpenMenu={handleArchivedThreadContextMenu}
              onUnarchive={unarchiveThread}
            />
          </SettingsSection>
        ))
      )}
      {includeLifecycle ? <DeviceLifecycleSuggestionSettings /> : null}
    </SettingsPageContainer>
  );
}

interface ArchivedThread {
  readonly id: ScopedThreadRef["threadId"];
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly title: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

/** Whether an archived thread can be changed, and why not. */
interface ArchivedThreadMutation {
  readonly allowed: boolean;
  readonly reason: string | null;
}

/**
 * The rows of one archive section. Its threads live on one node, which decides
 * whether they can be changed: the node's own role and connection, not the
 * selected node's.
 */
function ArchivedThreadRows(props: {
  environmentId: EnvironmentId;
  threads: ReadonlyArray<ArchivedThread>;
  targetAllowsMutation: boolean;
  onOpenMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    mutation: ArchivedThreadMutation,
  ) => Promise<void>;
  onUnarchive: (threadRef: ScopedThreadRef) => Promise<void>;
}) {
  const capability = useHostedRpcCapability(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    props.environmentId,
  );
  const nodeLabel = useHostedHubStore((state) =>
    hostedSwitchTargetLabel(state, props.environmentId),
  );
  const mutation: ArchivedThreadMutation = {
    allowed: props.targetAllowsMutation && capability.allowed,
    reason: hostedCapabilityCopy(capability, nodeLabel),
  };
  return (
    <>
      {props.threads.map((thread) => (
        <ArchivedThreadRow
          key={thread.id}
          thread={thread}
          mutationAllowed={mutation.allowed}
          mutationReason={mutation.reason}
          onOpenMenu={(threadRef, position) => props.onOpenMenu(threadRef, position, mutation)}
          onUnarchive={props.onUnarchive}
        />
      ))}
    </>
  );
}

/**
 * An archived-thread row. Desktop reaches unarchive/delete via right-click;
 * on the phone tier a long-press presents the same menu through the shared
 * bottom action sheet.
 */
function ArchivedThreadRow(props: {
  thread: ArchivedThread;
  mutationAllowed: boolean;
  mutationReason: string | null;
  onOpenMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => Promise<void>;
  onUnarchive: (threadRef: ScopedThreadRef) => Promise<void>;
}) {
  const { thread, mutationAllowed, mutationReason, onOpenMenu, onUnarchive } = props;
  const isPhoneTier = usePresentationTier() === "phone";
  const longPress = useLongPress(
    (point) => {
      void onOpenMenu(scopeThreadRef(thread.environmentId, thread.id), point);
    },
    { disabled: !isPhoneTier },
  );

  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3.5 first:border-t-0 sm:px-5"
      {...longPress}
      onContextMenu={(event) => {
        longPress.onContextMenu(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        void onOpenMenu(scopeThreadRef(thread.environmentId, thread.id), {
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[13px] font-medium text-foreground">{thread.title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
          {" · Created "}
          {formatRelativeTimeLabel(thread.createdAt)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        disabled={!mutationAllowed}
        title={mutationReason ?? undefined}
        onClick={() =>
          void onUnarchive(scopeThreadRef(thread.environmentId, thread.id)).catch((error) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to unarchive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          })
        }
      >
        <ArchiveX className="size-3.5" />
        <span>Unarchive</span>
      </Button>
    </div>
  );
}
