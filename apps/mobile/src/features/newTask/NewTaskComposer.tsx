import { useLayoutEffect, useRef } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import { ComposerAccessMenu } from "../threads/ComposerAccessMenu";
import { buildSessionPolicyModel } from "../threads/sessionPolicyModel";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { ProjectEnvironment } from "../projects/projectsModel";
import { NewTaskProjectMenu } from "./NewTaskProjectMenu";
import type {
  EnvironmentId,
  ProjectId,
  RuntimeMode,
  ModelSelection,
  ProviderInteractionMode,
  ServerProvider,
} from "@ryco/contracts";
import { Pressable, View } from "react-native";
import { IconGitBranch, IconGitFork } from "../../components/icons";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerToolbarButton, ComposerToolbarRow } from "../../components/ComposerToolbarTrigger";
import { DeviceIcon } from "../../components/DeviceIcon";
import { GlassSurface } from "../../components/GlassSurface";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { ComposerAttachMenu } from "../../components/ComposerAttachMenu";
import type { ComposerAttachmentSource, DraftComposerAttachment } from "../../lib/composerFiles";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../native/ComposerEditor";
import type { ChatFileUploadRecord } from "../../state/composerFileUpload";
import { ComposerCommandPopover } from "../threads/ComposerCommandPopover";
import {
  ComposerDictationBar,
  ComposerDictationButton,
  ComposerDictationError,
} from "../dictation/ComposerDictationControls";
import { useComposerDictation } from "../dictation/useComposerDictation";
import {
  useComposerCommandMenu,
  type ComposerCommandMenuContext,
} from "../threads/useComposerCommandMenu";
import { useThemeColor } from "../../lib/useThemeColor";
import { runtimeModeConfig } from "../threads/sessionPolicyPresentation";
import { ComposerModelMenu } from "../threads/ComposerModelMenu";
import { buildModelPickerModelFromOptions } from "../threads/modelPickerModel";
import type { ModelOption } from "../../lib/modelOptions";
import { NewTaskDeviceMenu } from "./NewTaskDeviceMenu";

export function NewTaskComposer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly projectTitle: string;
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly onSelectProject: (
    project: { environmentId: EnvironmentId; projectId: ProjectId } | null,
  ) => void;
  readonly customAvatarContentHash?: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly fileUploadRecords?: ReadonlyMap<string, ChatFileUploadRecord>;
  readonly onRetryFileUpload?: (attachmentId: string) => void;
  /** Where `/`, `$` and `@` look things up; null until a machine is chosen. */
  readonly commandMenuContext: ComposerCommandMenuContext | null;
  readonly machineLabel: string;
  readonly locationLabel: string;
  readonly branchLabel: string | null;
  readonly newWorktree: boolean;
  readonly newBranchName: string | null;
  readonly usesWorktree: boolean;
  readonly modelLabel: string;
  readonly modelProviderDriver: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly interactionModeSupported: boolean;
  readonly askModeSupported: boolean;
  readonly autoModeUnavailableReason: string | null;
  readonly onChangeInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly sendDisabledReason: string | null;
  /** Set while the task will wait for its machine instead of starting now. */
  readonly queueNotice?: string | null;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPickAttachments: (source: ComposerAttachmentSource) => void;
  readonly onOpenWorkspace: () => void;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  /** The node's provider snapshots, for the notices naming the update a model needs. */
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly modelSelection: ModelSelection;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onChangeRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSend: () => void;
}) {
  const promptRef = useRef<ComposerEditorHandle>(null);
  const modelMenuRef = useRef<AnchoredMenuHandle>(null);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const iconColor = useThemeColor("--color-icon");
  const warningColor = useThemeColor("--color-warning");
  const accessColor = useThemeColor("--color-access-caution");
  const policy = runtimeModeConfig[props.runtimeMode];
  const restoreFocus = () => {
    if (keyboardVisible) promptRef.current?.focus();
  };
  // Dictation lands at the command menu's caret, read when listening starts.
  const caretRef = useRef<ComposerEditorSelection>({ start: 0, end: 0 });
  const dictation = useComposerDictation({
    text: props.prompt,
    readSelection: () => caretRef.current,
    onChangeText: props.onChangePrompt,
    onChangeSelection: (selection) => commandMenu.onSelectionChange(selection),
  });
  const commandMenu = useComposerCommandMenu({
    text: props.prompt,
    onChangeText: props.onChangePrompt,
    context: props.commandMenuContext,
    offers: {
      model: !props.busy,
      interactionMode: !props.busy && props.interactionModeSupported,
      sideChat: false,
    },
    enabled: !props.busy && !dictation.active,
    onAction: (action) => {
      if (action.kind === "interaction-mode") props.onChangeInteractionMode(action.mode);
      else if (action.kind === "open-model-picker") modelMenuRef.current?.open();
    },
  });
  useLayoutEffect(() => {
    caretRef.current = commandMenu.selection;
  });

  return (
    <View className="gap-3">
      <View className="items-center gap-2">
        <Text className="text-base text-foreground-muted">Work in</Text>
        <View className="w-full items-center gap-1">
          <NewTaskProjectMenu
            projects={props.projects}
            environments={props.environments}
            environmentId={props.environmentId}
            projectId={props.projectId}
            disabled={props.busy}
            onSelect={props.onSelectProject}
            onClose={() => {
              if (keyboardVisible) promptRef.current?.focus();
            }}
          >
            {(open) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Project: ${props.projectTitle}`}
                disabled={props.busy}
                onPress={open}
                className="min-h-12 max-w-full flex-row items-center gap-2 rounded-2xl px-2 py-1 active:bg-subtle disabled:opacity-40"
              >
                {props.environmentId && props.projectId ? (
                  <ProjectFavicon
                    environmentId={props.environmentId}
                    projectId={props.projectId}
                    customAvatarContentHash={props.customAvatarContentHash}
                    projectTitle={props.projectTitle}
                    size={32}
                  />
                ) : (
                  <SymbolView name="folder" size={28} tintColor={iconColor} type="monochrome" />
                )}
                <Text
                  className="shrink text-[24px] font-ryco-medium text-foreground"
                  numberOfLines={1}
                >
                  {props.projectTitle}
                </Text>
                <SymbolView name="chevron.down" size={14} tintColor={iconColor} type="monochrome" />
              </Pressable>
            )}
          </NewTaskProjectMenu>
          <NewTaskDeviceMenu
            environments={props.environments}
            environmentId={props.environmentId}
            disabled={props.busy}
            onSelect={props.onSelectEnvironment}
            onClose={() => {
              if (keyboardVisible) promptRef.current?.focus();
            }}
          >
            {(open) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Machine: ${props.machineLabel}`}
                disabled={props.busy}
                onPress={open}
                className="min-h-11 max-w-full shrink flex-row items-center gap-1.5 rounded-full px-2 active:bg-subtle disabled:opacity-40"
              >
                {props.environmentId ? (
                  <DeviceIcon
                    environmentId={props.environmentId}
                    label={props.machineLabel}
                    size={14}
                  />
                ) : null}
                <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
                  {props.machineLabel}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={10}
                  tintColor={placeholderColor}
                  type="monochrome"
                />
              </Pressable>
            )}
          </NewTaskDeviceMenu>
        </View>
      </View>

      <View className="gap-3">
        <View className="flex-row flex-wrap items-center justify-center gap-2">
          <ComposerToolbarButton
            icon={props.usesWorktree ? undefined : "folder"}
            iconNode={
              props.usesWorktree ? <IconGitFork size={16} color={iconColor as string} /> : undefined
            }
            label={props.locationLabel}
            accessibilityLabel={`Workspace: ${props.locationLabel}`}
            maxWidth={280}
            disabled={props.busy}
            onPress={props.onOpenWorkspace}
          />
          {props.branchLabel ? (
            <>
              {props.newWorktree ? (
                <Text className="text-sm text-foreground-muted">from</Text>
              ) : null}
              <ComposerToolbarButton
                iconNode={<IconGitBranch size={16} color={iconColor as string} />}
                label={props.branchLabel}
                accessibilityLabel={`${props.newWorktree ? "Base branch" : "Branch"}: ${props.branchLabel}`}
                maxWidth={280}
                disabled={props.busy}
                onPress={props.onOpenWorkspace}
              />
            </>
          ) : null}
        </View>

        {props.newBranchName ? (
          <Text className="text-center text-xs text-foreground-muted">
            as <Text className="font-mono text-foreground">{props.newBranchName}</Text>
          </Text>
        ) : null}

        <View>
          {commandMenu.trigger &&
          (commandMenu.items.length > 0 || commandMenu.trigger.kind === "path") ? (
            <View className="absolute inset-x-0 bottom-full z-10 mb-2">
              <ComposerCommandPopover
                items={commandMenu.items}
                triggerKind={commandMenu.trigger.kind}
                isLoading={commandMenu.isLoading}
                onSelect={commandMenu.onSelect}
              />
            </View>
          ) : null}
          <GlassSurface radius={26} style={{ padding: 8 }}>
            <ComposerEditor
              ref={promptRef}
              value={props.prompt}
              onChangeText={props.onChangePrompt}
              skills={commandMenu.skills}
              threadTitles={commandMenu.threadTitles}
              selection={commandMenu.selection}
              onSelectionChange={commandMenu.onSelectionChange}
              placeholder="What should we do?"
              accessibilityLabel="Task prompt"
              multiline
              editable={!props.busy && !dictation.active}
              contentInsetVertical={12}
              style={{ minHeight: 96, maxHeight: 144, marginHorizontal: 12 }}
              textStyle={{ fontSize: 18, lineHeight: 26 }}
            />
            <View className="px-2">
              <ComposerAttachmentStrip
                attachments={props.attachments}
                onRemove={props.onRemoveAttachment}
                fileUploadRecords={props.fileUploadRecords}
                onRetryFileUpload={props.onRetryFileUpload}
                imageSize={58}
                imageBorderRadius={13}
              />
            </View>
            {dictation.active ? (
              <View className="pt-1.5">
                <ComposerDictationBar dictation={dictation} />
              </View>
            ) : (
              <ComposerToolbarRow paddingHorizontal={0} paddingBottom={0} paddingTop={6}>
                <ComposerAttachMenu
                  disabled={props.busy}
                  onPick={props.onPickAttachments}
                  onClose={restoreFocus}
                >
                  {(open) => (
                    <ComposerToolbarButton
                      icon="plus"
                      accessibilityLabel="Attach files"
                      showChevron={false}
                      disabled={props.busy}
                      onPress={open}
                    />
                  )}
                </ComposerAttachMenu>
                <ComposerModelMenu
                  ref={modelMenuRef}
                  model={buildModelPickerModelFromOptions({
                    modelOptions: props.modelOptions,
                    providers: props.providers,
                    currentSelection: props.modelSelection,
                  })}
                  selection={props.modelSelection}
                  disabled={props.busy}
                  onSelect={props.onSelectModel}
                  onClose={() => {
                    if (keyboardVisible) promptRef.current?.focus();
                  }}
                >
                  {(open, settings) => (
                    <ComposerToolbarButton
                      iconNode={<ProviderIcon provider={props.modelProviderDriver} size={14} />}
                      label={props.modelLabel}
                      suffixLabel={settings.reasoningLabel ?? undefined}
                      suffixIcon={settings.fastEnabled ? "bolt.fill" : undefined}
                      suffixIconColor={warningColor as string}
                      accessibilityLabel={[
                        `Model: ${props.modelLabel}`,
                        settings.accessibilitySuffix,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      className="min-w-0 max-w-full flex-1"
                      disabled={props.busy}
                      onPress={open}
                    />
                  )}
                </ComposerModelMenu>
                <ComposerAccessMenu
                  model={buildSessionPolicyModel({
                    runtimeMode: props.runtimeMode,
                    interactionMode: props.interactionMode,
                    interactionModeSupported: props.interactionModeSupported,
                    askModeSupported: props.askModeSupported,
                    autoModeUnavailableReason: props.autoModeUnavailableReason,
                  })}
                  disabled={props.busy}
                  onSelectRuntimeMode={props.onChangeRuntimeMode}
                  onSelectInteractionMode={props.onChangeInteractionMode}
                  onClose={() => {
                    if (keyboardVisible) promptRef.current?.focus();
                  }}
                >
                  {(open) => (
                    <ComposerToolbarButton
                      onPress={open}
                      iconNode={
                        <SymbolView
                          name={policy.icon}
                          size={17}
                          tintColor={policy.tone === "caution" ? accessColor : iconColor}
                          type="monochrome"
                        />
                      }
                      accessibilityLabel={`Access: ${policy.label}`}
                      showChevron={false}
                      active={policy.tone === "caution"}
                      disabled={props.busy}
                    />
                  )}
                </ComposerAccessMenu>
                <ComposerDictationButton dictation={dictation} disabled={props.busy} />
                <ComposerToolbarButton
                  icon={props.busy ? "ellipsis" : "arrow.up"}
                  accessibilityLabel={
                    props.busy ? "Starting task" : props.queueNotice ? "Queue task" : "Start task"
                  }
                  showChevron={false}
                  variant="primary"
                  disabled={!props.canSend || props.busy}
                  onPress={props.onSend}
                />
              </ComposerToolbarRow>
            )}
          </GlassSurface>
        </View>
        <ComposerDictationError dictation={dictation} />
        {!props.canSend && props.sendDisabledReason ? (
          <Text className="px-3 text-sm text-danger-foreground">{props.sendDisabledReason}</Text>
        ) : props.queueNotice ? (
          <Text className="px-3 text-sm text-foreground-muted">{props.queueNotice}</Text>
        ) : null}
      </View>
    </View>
  );
}
