import { VoiceInput } from "../../voice/VoiceInput";
import { useRef } from "react";
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
} from "@ryco/contracts";
import { Pressable, TextInput, View } from "react-native";
import { IconGitBranch, IconGitFork } from "@tabler/icons-react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerToolbarButton, ComposerToolbarRow } from "../../components/ComposerToolbarTrigger";
import { DeviceIcon } from "../../components/DeviceIcon";
import { GlassSurface } from "../../components/GlassSurface";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
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
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
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
  readonly onChangeInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly sendDisabledReason: string | null;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPickAttachments: () => void;
  readonly onOpenWorkspace: () => void;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly modelSelection: ModelSelection;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onChangeRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSend: () => void;
}) {
  const promptRef = useRef<TextInput>(null);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const textColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const warningColor = useThemeColor("--color-warning");
  const accessColor = useThemeColor("--color-access-caution");
  const policy = runtimeModeConfig[props.runtimeMode];

  return (
    <View className="gap-3">
      {props.environmentId && (
        <VoiceInput
          draftKey={`new-task:${props.projectId ?? "none"}`}
          environmentId={props.environmentId}
          disabled={props.busy}
          onInsert={(text) =>
            props.onChangePrompt(`${props.prompt}${props.prompt ? "\n" : ""}${text}`)
          }
        />
      )}
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

        <GlassSurface radius={26} style={{ padding: 8 }}>
          <TextInput
            ref={promptRef}
            accessibilityLabel="Task prompt"
            multiline
            value={props.prompt}
            editable={!props.busy}
            onChangeText={props.onChangePrompt}
            placeholder="What should we do?"
            placeholderTextColor={placeholderColor as string}
            className="min-h-24 max-h-36 px-3 py-3 font-sans text-[18px] leading-normal"
            style={{ color: textColor as string, textAlignVertical: "top" }}
          />
          <View className="px-2">
            <ComposerAttachmentStrip
              attachments={props.attachments}
              onRemove={props.onRemoveAttachment}
              imageSize={58}
              imageBorderRadius={13}
            />
          </View>
          <ComposerToolbarRow paddingHorizontal={0} paddingBottom={0} paddingTop={6}>
            <ComposerToolbarButton
              icon="plus"
              accessibilityLabel="Attach images"
              showChevron={false}
              disabled={props.busy}
              onPress={props.onPickAttachments}
            />
            <ComposerModelMenu
              model={buildModelPickerModelFromOptions({
                modelOptions: props.modelOptions,
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
                  accessibilityLabel={[`Model: ${props.modelLabel}`, settings.accessibilitySuffix]
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
            <ComposerToolbarButton
              icon={props.busy ? "ellipsis" : "arrow.up"}
              accessibilityLabel={props.busy ? "Starting task" : "Start task"}
              showChevron={false}
              variant="primary"
              disabled={!props.canSend || props.busy}
              onPress={props.onSend}
            />
          </ComposerToolbarRow>
        </GlassSurface>
        {!props.canSend && props.sendDisabledReason ? (
          <Text className="px-3 text-sm text-danger-foreground">{props.sendDisabledReason}</Text>
        ) : null}
      </View>
    </View>
  );
}
