import type { EnvironmentId } from "@ryco/contracts";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, TextInput, View } from "react-native";

import type { RuntimeMode } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { useThemeColor } from "../../lib/useThemeColor";
import { runtimeModeConfig, runtimeModeOptions } from "../threads/sessionPolicyPresentation";

// Access vocabulary comes from the shared table, not a local copy. The old
// local labels were wrong twice over: "Ask" is also the name of an
// interaction-mode value, so the same word named two different controls, and
// "Auto edit" matched neither the web label nor its short form.
const RUNTIME_OPTIONS = runtimeModeOptions.map((value) => ({
  value,
  label: runtimeModeConfig[value].triggerLabel,
  caution: runtimeModeConfig[value].tone === "caution",
}));

export function NewTaskComposer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly contextLabel: string;
  readonly machineLabel: string;
  readonly modelLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly sendDisabledReason: string | null;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onPickAttachments: () => void;
  readonly onOpenContext: () => void;
  readonly onOpenModel: () => void;
  readonly onChangeRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSend: () => void;
}) {
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const primaryForeground = useThemeColor("--color-primary-foreground");

  return (
    <View className="gap-16">
      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Machine: ${props.machineLabel}`}
          disabled={props.busy}
          onPress={props.onOpenContext}
          className="h-12 flex-row items-center gap-3 rounded-2xl bg-card px-4 active:bg-card-alt disabled:opacity-40"
        >
          <Text className="flex-1 text-sm font-ryco-bold text-foreground">Machine</Text>
          <Text className="text-sm font-ryco-medium text-foreground-muted" numberOfLines={1}>
            {props.machineLabel}
          </Text>
          <SymbolView
            name="chevron.right"
            size={15}
            tintColor={iconColor as string}
            type="monochrome"
          />
        </Pressable>

        <TextInput
          autoFocus
          multiline
          value={props.prompt}
          editable={!props.busy}
          onChangeText={props.onChangePrompt}
          placeholder="What should Ryco work on?"
          placeholderTextColor={placeholderColor as string}
          className="min-h-40 rounded-[22px] border border-border bg-card px-5 py-4 font-sans text-[18px] leading-normal"
          style={{ color: textColor as string, textAlignVertical: "top" }}
        />
        <ComposerAttachmentStrip
          attachments={props.attachments}
          onRemove={props.onRemoveAttachment}
          removeButtonPlacement="gutter"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Attach images"
          disabled={props.busy}
          onPress={props.onPickAttachments}
          className="h-11 flex-row items-center gap-2 self-start rounded-full bg-subtle px-4 active:bg-subtle-strong disabled:opacity-40"
        >
          <SymbolView
            name="paperclip"
            size={17}
            tintColor={iconColor as string}
            type="monochrome"
          />
          <Text className="text-sm font-ryco-bold text-foreground">Attach images</Text>
        </Pressable>
        {!props.canSend && props.sendDisabledReason ? (
          <Text className="px-2 text-center font-sans text-xs text-danger-foreground">
            {props.sendDisabledReason}
          </Text>
        ) : null}
      </View>

      <View className="gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Context: ${props.contextLabel}`}
          disabled={props.busy}
          onPress={props.onOpenContext}
          className="min-h-16 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3 active:bg-card-alt disabled:opacity-40"
        >
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-subtle">
            {props.environmentId ? (
              <DeviceIcon
                environmentId={props.environmentId}
                label={props.machineLabel}
                size={20}
              />
            ) : (
              <SymbolView
                name="server.rack"
                size={18}
                tintColor={iconColor as string}
                type="monochrome"
              />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-tertiary">
              Working in
            </Text>
            <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={2}>
              {props.contextLabel}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={15}
            tintColor={iconColor as string}
            type="monochrome"
          />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Model: ${props.modelLabel}`}
          disabled={props.busy}
          onPress={props.onOpenModel}
          className="h-12 flex-row items-center gap-3 rounded-2xl bg-card px-4 active:bg-card-alt disabled:opacity-40"
        >
          <Text className="flex-1 text-sm font-ryco-bold text-foreground">Model</Text>
          <Text className="text-sm font-ryco-medium text-foreground-muted" numberOfLines={1}>
            {props.modelLabel}
          </Text>
          <SymbolView
            name="chevron.right"
            size={15}
            tintColor={iconColor as string}
            type="monochrome"
          />
        </Pressable>

        <View className="gap-2">
          <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">Access</Text>
          <View className="flex-row rounded-2xl bg-subtle p-1">
            {RUNTIME_OPTIONS.map((option) => {
              const selected = option.value === props.runtimeMode;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  disabled={props.busy}
                  onPress={() => props.onChangeRuntimeMode(option.value)}
                  className={`h-11 flex-1 items-center justify-center rounded-xl px-2 ${
                    selected ? (option.caution ? "bg-warning-bg" : "bg-card") : ""
                  }`}
                >
                  <Text
                    className={`text-xs font-ryco-bold ${
                      selected
                        ? option.caution
                          ? "text-warning"
                          : "text-foreground"
                        : "text-foreground-muted"
                    }`}
                    numberOfLines={1}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start task"
          disabled={!props.canSend || props.busy}
          onPress={props.onSend}
          className="h-14 flex-row items-center justify-center gap-2 rounded-full bg-primary px-6 active:opacity-80 disabled:opacity-40"
        >
          <Text className="text-base font-ryco-bold text-primary-foreground">
            {props.busy ? "Starting…" : "Start task"}
          </Text>
          <SymbolView
            name="arrow.up"
            size={18}
            tintColor={primaryForeground as string}
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
}
