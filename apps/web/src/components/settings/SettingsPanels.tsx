import { useAppPreferencesLabel } from "../../deviceName";
import { settingsRestorePlan } from "./settingsRestore";
import { selectArchivedSettingsGroups } from "./archivedSettings";
import { SourceControlPreferences } from "./SourceControlPreferences";
import { ComposerSettings } from "./ComposerSettings";
import { QuitShortcutSetting } from "./QuitShortcutSetting";
import { ArchiveIcon, ArchiveX, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ORCHESTRATION_WS_METHODS,
  type DesktopUpdateChannel,
  EDITORS,
  type EditorId,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { DEFAULT_UNIFIED_SETTINGS, WorktreeBranchPrefix } from "@ryco/contracts/settings";
import { Schema } from "effect";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import { RycoLetterMark } from "../RycoLetterMark";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import { EDITOR_ICONS, getEditorLabel } from "./SettingsPanels.editor";
import { settingsScopeLabel } from "./settingsSections.logic";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

function EditorOptionIcon({ editor }: { editor: EditorId }) {
  const IconComponent = EDITOR_ICONS[editor];
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

const REPOSITORY_URL = "https://github.com/sak0a/ryco";

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
          <button
            type="button"
            onClick={() => openExternalLink(REPOSITORY_URL)}
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            github.com/sak0a/ryco
          </button>
        </p>
      </div>
    </div>
  );
}

function AboutVersionSection({ scopeLabel }: { readonly scopeLabel: string }) {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .then((state) => {
          setDesktopUpdateState(state);
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

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
      <SettingsRow
        title="Update track"
        description="Stable follows full releases. Nightly follows the nightly desktop channel and can switch back to stable immediately."
        scope={scopeLabel}
        control={
          <Select
            value={selectedUpdateChannel}
            onValueChange={(value) => {
              handleUpdateChannelChange(value as DesktopUpdateChannel);
            }}
          >
            <SelectTrigger
              className="w-full sm:w-40"
              aria-label="Update track"
              disabled={!hasDesktopBridge || isChangingUpdateChannel}
            >
              <SelectValue>
                {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="latest">
                Stable
              </SelectItem>
              <SelectItem hideIndicator value="nightly">
                Nightly
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
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

function LegacyFeaturesSection({
  searchTargetId,
  nodeScopeLabel,
}: {
  searchTargetId: string | null;
  nodeScopeLabel: string;
}) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const targeted = searchTargetId === "legacy-token-streaming";
  const [open, setOpen] = useState(targeted);
  const tokenStreamingRowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targeted) return;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      tokenStreamingRowRef.current?.scrollIntoView({ block: "center" });
      tokenStreamingRowRef.current?.querySelector<HTMLElement>("[role=switch]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [targeted]);

  return (
    <section className="space-y-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-lg px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-block h-px w-3 bg-border" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50 transition-colors group-hover:text-foreground/70">
              Legacy features
            </span>
            <span className="hidden text-[11px] text-muted-foreground/55 sm:inline">
              Compatibility controls
            </span>
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 text-muted-foreground/60 transition-transform duration-200 group-data-panel-open:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-2">
            <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card text-card-foreground shadow-sm/4 dark:shadow-none">
              <div ref={tokenStreamingRowRef} id="legacy-token-streaming">
                <SettingsRow
                  title="Stream token by token (legacy)"
                  description="Paint assistant output token by token instead of in complete chunks. This legacy mode is significantly slower and makes long responses harder to follow."
                  owner="node"
                  scope={nodeScopeLabel}
                  resetAction={
                    settings.enableLegacyTokenStreaming !==
                    DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming ? (
                      <SettingResetButton
                        label="legacy token streaming"
                        onClick={() =>
                          updateSettings({
                            enableLegacyTokenStreaming:
                              DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming,
                          })
                        }
                      />
                    ) : null
                  }
                  control={
                    <Switch
                      checked={settings.enableLegacyTokenStreaming}
                      onCheckedChange={(checked) => {
                        if (!checked) {
                          updateSettings({ enableLegacyTokenStreaming: false });
                          return;
                        }
                        void (async () => {
                          const api = readLocalApi();
                          const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
                            [
                              "Turn on token-by-token output?",
                              "It is significantly slower than buffered output and makes long responses harder to follow. This switch exists only for backwards compatibility.",
                            ].join("\n"),
                          );
                          if (confirmed) {
                            updateSettings({
                              enableLegacyTokenStreaming: true,
                            });
                          }
                        })();
                      }}
                      aria-label="Stream token by token (legacy)"
                    />
                  }
                />
              </div>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function GeneralSettingsPanel({
  searchTargetId = null,
}: {
  searchTargetId?: string | null;
}) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const isPhoneTier = usePresentationTier() === "phone";
  const settingsTarget = useSettingsTarget();
  const editingScope = useSettingsEditingScope();
  const appLabel = useAppPreferencesLabel();
  const scopeOptions = {
    appLabel,
    nativeClient: isElectron,
    nodeLabel: settingsTarget?.nodeLabel ?? null,
  };
  const localScopeLabel = settingsScopeLabel("browser", scopeOptions);
  const deviceScopeLabel = settingsScopeLabel("device", scopeOptions);
  const nodeScopeLabel = settingsScopeLabel("node", scopeOptions);
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
    <SettingsPageContainer>
      <SettingsSection title="Behavior" owner="client">
        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          owner="client"
          scope={localScopeLabel}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

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
              <SelectTrigger className="w-full sm:w-56" aria-label="Default editor">
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
      </SettingsSection>
      {isPhoneTier && <SourceControlPreferences />}
      <SettingsSection title="Provider updates" owner="node">
        <SettingsRow
          title="Provider update checks"
          description="Check installed provider CLIs for newer versions. Disable if you install providers with Nix or another package manager."
          owner="node"
          scope={nodeScopeLabel}
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check providers for updates"
            />
          }
        />
      </SettingsSection>
      {!isPhoneTier && editingScope !== "node" && <ComposerSettings />}
      <SettingsSection title="Projects & threads">
        <SettingsRow
          title="Auto-open overview"
          description="Open the overview automatically when plans, progress, or implementation steps appear."
          owner="client"
          scope={localScopeLabel}
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open overview"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the overview automatically"
            />
          }
        />

        <SettingsRow
          title="New threads"
          description="Pick the default workspace mode for newly created draft threads."
          owner="node"
          scope={nodeScopeLabel}
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="new threads"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
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
          }
        />

        {!isPhoneTier && (
          <SettingsRow
            title="Worktree branch prefix"
            description="Prefix for generated branches on this device. Use a Git namespace such as team/agent, without a trailing slash. Leave empty for no prefix. Existing branches keep their names."
            owner="node"
            scope={nodeScopeLabel}
            resetAction={
              settings.worktreeBranchPrefix !== DEFAULT_UNIFIED_SETTINGS.worktreeBranchPrefix ? (
                <SettingResetButton
                  label="worktree branch prefix"
                  onClick={() =>
                    updateSettings({
                      worktreeBranchPrefix: DEFAULT_UNIFIED_SETTINGS.worktreeBranchPrefix,
                    })
                  }
                />
              ) : null
            }
            control={
              <DraftInput
                className="w-full sm:w-72"
                value={settings.worktreeBranchPrefix}
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
                  updateSettings({ worktreeBranchPrefix: prefix });
                }}
                placeholder="ryco"
                spellCheck={false}
                autoCapitalize="none"
                aria-label="Worktree branch prefix"
              />
            }
          />
        )}

        <SettingsRow
          title="Add project starts in"
          description='Leave empty to use "~/" when the Add Project browser opens.'
          owner="node"
          scope={nodeScopeLabel}
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Confirmations" owner="client">
        {!isPhoneTier && <QuitShortcutSetting />}
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
          description="Ask before deleting a thread and its chat history."
          owner="client"
          scope={localScopeLabel}
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
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
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
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
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="Confirm thread unpinning"
            />
          }
        />
      </SettingsSection>
      {isElectron && (
        <SettingsSection title="Notifications" owner="client">
          <SettingsRow
            title="Turn-complete notifications"
            description="Show a desktop notification when an agent finishes a turn while the Ryco window is unfocused."
            owner="client"
            scope={deviceScopeLabel}
            resetAction={
              settings.notifyOnTurnCompleteWhenUnfocused !==
              DEFAULT_UNIFIED_SETTINGS.notifyOnTurnCompleteWhenUnfocused ? (
                <SettingResetButton
                  label="turn-complete notifications"
                  onClick={() =>
                    updateSettings({
                      notifyOnTurnCompleteWhenUnfocused:
                        DEFAULT_UNIFIED_SETTINGS.notifyOnTurnCompleteWhenUnfocused,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.notifyOnTurnCompleteWhenUnfocused}
                onCheckedChange={(checked) =>
                  updateSettings({
                    notifyOnTurnCompleteWhenUnfocused: Boolean(checked),
                  })
                }
                aria-label="Notify when a turn completes while unfocused"
              />
            }
          />
        </SettingsSection>
      )}

      {!isPhoneTier
        ? editingScope !== "client" && (
            <LegacyFeaturesSection
              searchTargetId={searchTargetId}
              nodeScopeLabel={nodeScopeLabel}
            />
          )
        : null}

      <SettingsSection title="About">
        {editingScope !== "node" && <AboutBrandingHeader />}
        {isElectron && editingScope !== "node" ? (
          <AboutVersionSection scopeLabel={deviceScopeLabel} />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Current version of the application."
            owner="client"
            scope={localScopeLabel}
          />
        )}
        <SettingsRow
          title="Diagnostics"
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
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const target = useSettingsTarget();
  const mutationCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const mutationAllowed =
    mutationCapability.allowed && (!target || (target.connected && target.canMutate !== false));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const archivedGroups = useMemo(
    () => selectArchivedSettingsGroups(projects, threads, target?.environmentId),
    [projects, threads, target?.environmentId],
  );

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      if (!mutationAllowed) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Archived thread is read-only",
            description: mutationCapability.reason ?? "This action is unavailable.",
          }),
        );
        return;
      }
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
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
    [confirmAndDeleteThread, mutationAllowed, mutationCapability.reason, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
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
        archivedGroups.map(({ project, threads: projectThreads }) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            title={project.name}
            icon={
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
                projectId={project.id}
                customAvatarContentHash={project.customAvatarContentHash ?? null}
              />
            }
          >
            {projectThreads.map((thread) => (
              <ArchivedThreadRow
                key={thread.id}
                thread={thread}
                mutationAllowed={mutationAllowed}
                mutationReason={mutationCapability.reason ?? null}
                onOpenMenu={handleArchivedThreadContextMenu}
                onUnarchive={unarchiveThread}
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

/**
 * An archived-thread row. Desktop reaches unarchive/delete via right-click;
 * on the phone tier a long-press presents the same menu through the shared
 * bottom action sheet.
 */
function ArchivedThreadRow(props: {
  thread: {
    readonly id: ScopedThreadRef["threadId"];
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly title: string;
    readonly archivedAt: string | null;
    readonly createdAt: string;
  };
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
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:px-5"
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
        <h3 className="truncate text-sm font-medium text-foreground">{thread.title}</h3>
        <p className="text-xs text-muted-foreground">
          Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
          {" · Created "}
          {formatRelativeTimeLabel(thread.createdAt)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
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
