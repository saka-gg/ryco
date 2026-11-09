import type { MenuAction } from "@react-native-menu/menu";
import type { ModelSelection, ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import type { ReactNode, Ref } from "react";
import { Pressable, View } from "react-native";

import { AnchoredMenu, type AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useThemeColor } from "../../lib/useThemeColor";
import { ComposerAccessMenu } from "./ComposerAccessMenu";
import { ComposerModelMenu } from "./ComposerModelMenu";
import {
  composerAccessGlyph,
  composerCaptionLabel,
  composerEffortControl,
  composerModeGlyph,
} from "./composerCaptionModel";
import {
  applyModelOption,
  listModelPickerEntries,
  resolveModelPillFastMode,
  type ModelPickerModel,
} from "./modelPickerModel";
import { resolveSessionPolicySelection, type SessionPolicyModel } from "./sessionPolicyModel";

// The prototype's caption: 28pt icon targets, then the model in small muted text.
const TARGET = 28;

function CaptionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean | undefined;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      className="items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
      style={{ width: TARGET, height: TARGET }}
    >
      {props.children}
    </Pressable>
  );
}

/** The selected model's effort, as its own small menu behind the gauge. */
function ComposerEffortMenu(props: {
  readonly model: ModelPickerModel;
  readonly selection: ModelSelection;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const effort = composerEffortControl(props.model);
  const iconColor = useThemeColor("--color-icon");
  if (!effort) return null;
  const selectedKey = `${props.selection.instanceId}:${props.selection.model}`;
  const capabilities = listModelPickerEntries(props.model).find(
    (entry) => entry.key === selectedKey,
  )?.capabilities;
  const actions: MenuAction[] = effort.choices.map((choice) => ({
    id: choice.id,
    title: choice.label,
    state: choice.selected ? "on" : "off",
    attributes: { disabled: props.disabled },
  }));
  return (
    <AnchoredMenu
      title={effort.label}
      menuWidth={220}
      actions={actions}
      onClose={props.onClose}
      renderIcon={() => (
        <SymbolView
          name="gauge.with.dots.needle.33percent"
          size={16}
          tintColor={iconColor}
          type="monochrome"
        />
      )}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const choice = effort.choices.find((candidate) => candidate.id === nativeEvent.event);
        if (choice && !choice.selected)
          props.onSelect(applyModelOption(props.selection, capabilities, effort.id, choice.id));
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}

/** Build / Plan (and Ask where the provider has it) behind the mode icon. */
function ComposerModeMenu(props: {
  readonly policy: SessionPolicyModel;
  readonly disabled: boolean;
  readonly onSelect: (mode: ProviderInteractionMode) => void;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon");
  const group = props.policy.mode;
  if (!group) return null;
  const actions: MenuAction[] = group.segments.map((segment) => ({
    id: segment.value,
    title: segment.label,
    subtitle: segment.disabledReason ?? segment.description,
    state: segment.selected ? "on" : "off",
    attributes: { disabled: props.disabled || segment.disabled },
  }));
  return (
    <AnchoredMenu
      title={group.label}
      menuWidth={280}
      subtitleStyle={{ fontSize: 11, lineHeight: 15 }}
      actions={actions}
      onClose={props.onClose}
      renderIcon={(action) => {
        const segment = group.segments.find((candidate) => candidate.value === action.id);
        return segment ? (
          <SymbolView name={segment.icon} size={17} tintColor={iconColor} type="monochrome" />
        ) : null;
      }}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const segment = group.segments.find((candidate) => candidate.value === nativeEvent.event);
        const next = segment ? resolveSessionPolicySelection(group, segment.value) : null;
        if (next) props.onSelect(next);
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}

/**
 * The quiet line above the composer capsule: the provider's logo (the model picker, with fast
 * mode and the prompt cache inside it), the effort gauge, the mode and the access, each its own
 * tap target, then "Opus 5.5 · High".
 */
export function ComposerCaption({
  ref,
  ...props
}: {
  /** The model menu, for the `/model` command. */
  readonly ref?: Ref<AnchoredMenuHandle>;
  readonly policyModel: SessionPolicyModel;
  readonly policyDisabled: boolean;
  readonly modelPicker: ModelPickerModel | null;
  readonly modelSelection: ModelSelection | null;
  readonly fastModeNotice: FastModeNotice | null | undefined;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly onOpenCacheInfo: (() => void) | undefined;
  readonly onMenuClose: () => void;
}) {
  const muted = useThemeColor("--color-icon-muted");
  const plain = useThemeColor("--color-icon");
  const planColor = useThemeColor("--color-accent-strong");
  const accessColor = useThemeColor("--color-access-caution");
  const warningColor = useThemeColor("--color-warning");
  const subtle = useThemeColor("--color-icon-subtle");
  const { modelPicker, modelSelection, policyModel } = props;
  const access = composerAccessGlyph(policyModel);
  const mode = composerModeGlyph(policyModel);
  const fast = modelPicker ? resolveModelPillFastMode(modelPicker, props.fastModeNotice) : null;
  return (
    <View
      className="flex-row items-center"
      style={{ gap: 2, paddingHorizontal: 6, paddingBottom: 4 }}
    >
      {modelPicker && modelSelection ? (
        <ComposerModelMenu
          ref={ref}
          model={modelPicker}
          selection={modelSelection}
          disabled={props.policyDisabled}
          onSelect={props.onSelectModel}
          onOpenCacheInfo={props.onOpenCacheInfo}
          onClose={props.onMenuClose}
          anchorClassName=""
        >
          {(open) => (
            <CaptionButton
              accessibilityLabel={fast?.accessibilityLabel ?? modelPicker.pillAccessibilityLabel}
              disabled={props.policyDisabled}
              onPress={open}
            >
              <ProviderIcon provider={modelPicker.pillProviderDriver} size={14} />
            </CaptionButton>
          )}
        </ComposerModelMenu>
      ) : null}
      {modelPicker && modelSelection ? (
        <ComposerEffortMenu
          model={modelPicker}
          selection={modelSelection}
          disabled={props.policyDisabled}
          onSelect={props.onSelectModel}
          onClose={props.onMenuClose}
        >
          {(open) => (
            <CaptionButton
              accessibilityLabel={`Effort: ${modelPicker.pillReasoningLabel ?? "default"}`}
              disabled={props.policyDisabled}
              onPress={open}
            >
              <SymbolView
                name="gauge.with.dots.needle.33percent"
                size={15}
                tintColor={muted}
                type="monochrome"
              />
            </CaptionButton>
          )}
        </ComposerEffortMenu>
      ) : null}
      {mode ? (
        <ComposerModeMenu
          policy={policyModel}
          disabled={props.policyDisabled}
          onSelect={props.onSelectInteractionMode}
          onClose={props.onMenuClose}
        >
          {(open) => (
            <CaptionButton
              accessibilityLabel={`Mode: ${mode.label}`}
              disabled={props.policyDisabled}
              onPress={open}
            >
              <SymbolView
                name={mode.icon as AppSymbolName}
                size={14}
                tintColor={mode.plan ? planColor : plain}
                type="monochrome"
              />
            </CaptionButton>
          )}
        </ComposerModeMenu>
      ) : null}
      <ComposerAccessMenu
        model={policyModel}
        disabled={props.policyDisabled}
        onSelectRuntimeMode={props.onSelectRuntimeMode}
        onClose={props.onMenuClose}
      >
        {(open) => (
          <CaptionButton
            accessibilityLabel={policyModel.pillAccessibilityLabel}
            disabled={props.policyDisabled}
            onPress={open}
          >
            <SymbolView
              name={access.icon as AppSymbolName}
              size={13}
              tintColor={access.caution ? accessColor : plain}
              type="monochrome"
            />
          </CaptionButton>
        )}
      </ComposerAccessMenu>
      {modelPicker ? (
        <View className="min-w-0 flex-1 flex-row items-center" style={{ marginLeft: 4, gap: 4 }}>
          <Text
            className="shrink text-foreground-tertiary"
            style={{ fontSize: 11.5 }}
            numberOfLines={1}
          >
            {composerCaptionLabel(modelPicker)}
          </Text>
          {fast?.icon ? (
            <SymbolView
              name={fast.icon}
              size={10}
              tintColor={fast.muted ? subtle : warningColor}
              type="monochrome"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
