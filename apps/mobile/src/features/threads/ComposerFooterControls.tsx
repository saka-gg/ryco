import type { MenuAction } from "@react-native-menu/menu";
import type { AgentTokenMode, ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
import type { ReactNode } from "react";
import { Pressable } from "react-native";

import { AnchoredMenu } from "../../components/AnchoredMenu";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { composerControlsCaution } from "./composerFooterModel";
import type { ModelOptionControl } from "./modelPickerModel";
import { resolveSessionPolicySelection, type SessionPolicyModel } from "./sessionPolicyModel";
import { tokenModeConfig, tokenModeOptions } from "./sessionPolicyPresentation";

// The desktop composer footer's mode controls (apps/web ComposerFooterModeControls and
// CompactComposerControlsMenu): below the shared 620pt breakpoint mode, access and tokens fold
// into one "More composer controls" menu behind an ellipsis that turns caution-orange under Full
// access; wider (iPad) they are three icon selects. Options the tuning dial does not own (an
// agent, a variant) lead the menu, as the desktop's traits do.

/** The desktop's ghost `icon-xs` trigger: 24pt, with a 44pt touch target. */
const ICON_BUTTON = 24;

export interface ComposerPolicyControlsProps {
  readonly policy: SessionPolicyModel;
  readonly tokenMode: AgentTokenMode;
  /** Absent: the token budget is not offered here. */
  readonly onSelectTokenMode?: ((mode: AgentTokenMode) => void) | undefined;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  /** The model's options the dial does not own. */
  readonly traits: ReadonlyArray<ModelOptionControl>;
  readonly onSelectTrait: (id: string, value: string | boolean) => void;
  readonly disabled: boolean;
  readonly onClose: () => void;
}

const MODE_PREFIX = "mode:";
const ACCESS_PREFIX = "access:";
const TOKENS_PREFIX = "tokens:";
const TRAIT_PREFIX = "trait:";

function sectionTitle(id: string, title: string): MenuAction {
  return { id, title, attributes: { disabled: true } };
}

function traitActions(traits: ReadonlyArray<ModelOptionControl>, disabled: boolean): MenuAction[] {
  return traits.flatMap((trait): MenuAction[] =>
    trait.kind === "select"
      ? [
          sectionTitle(`#title:${trait.id}`, trait.label),
          ...trait.choices.map((choice): MenuAction => ({
            id: `${TRAIT_PREFIX}${trait.id}:${choice.id}`,
            title: choice.label,
            state: choice.selected ? "on" : "off",
            attributes: { disabled },
          })),
        ]
      : [
          {
            id: `${TRAIT_PREFIX}${trait.id}:${trait.enabled ? "off" : "on"}`,
            title: trait.label,
            state: trait.enabled ? "on" : "off",
            attributes: { disabled },
          },
        ],
  );
}

function handleAction(event: string, props: ComposerPolicyControlsProps) {
  if (props.disabled) return;
  if (event.startsWith(MODE_PREFIX) && props.policy.mode) {
    const next = resolveSessionPolicySelection(
      props.policy.mode,
      event.slice(MODE_PREFIX.length) as ProviderInteractionMode,
    );
    if (next) props.onSelectInteractionMode(next);
    return;
  }
  if (event.startsWith(ACCESS_PREFIX)) {
    const next = resolveSessionPolicySelection(
      props.policy.access,
      event.slice(ACCESS_PREFIX.length) as RuntimeMode,
    );
    if (next) props.onSelectRuntimeMode(next);
    return;
  }
  if (event.startsWith(TOKENS_PREFIX)) {
    const next = event.slice(TOKENS_PREFIX.length) as AgentTokenMode;
    if (next !== props.tokenMode) props.onSelectTokenMode?.(next);
    return;
  }
  if (event.startsWith(TRAIT_PREFIX)) {
    const rest = event.slice(TRAIT_PREFIX.length);
    const split = rest.lastIndexOf(":");
    const id = rest.slice(0, split);
    const value = rest.slice(split + 1);
    const trait = props.traits.find((candidate) => candidate.id === id);
    if (!trait) return;
    if (trait.kind === "boolean") props.onSelectTrait(id, value === "on");
    else if (!trait.choices.find((choice) => choice.id === value)?.selected)
      props.onSelectTrait(id, value);
  }
}

function modeActions(props: ComposerPolicyControlsProps): MenuAction[] {
  const group = props.policy.mode;
  if (!group) return [];
  return group.segments.map((segment) => ({
    id: `${MODE_PREFIX}${segment.value}`,
    title: segment.label,
    ...(segment.disabledReason ? { subtitle: segment.disabledReason } : {}),
    state: segment.selected ? "on" : "off",
    attributes: { disabled: props.disabled || segment.disabled },
  }));
}

function accessActions(props: ComposerPolicyControlsProps): MenuAction[] {
  return props.policy.access.segments.map((segment) => ({
    id: `${ACCESS_PREFIX}${segment.value}`,
    title: segment.label,
    ...(segment.disabledReason ? { subtitle: segment.disabledReason } : {}),
    state: segment.selected ? "on" : "off",
    attributes: { disabled: props.disabled || segment.disabled },
  }));
}

function tokenActions(props: ComposerPolicyControlsProps): MenuAction[] {
  return tokenModeOptions.map((mode) => ({
    id: `${TOKENS_PREFIX}${mode}`,
    title: tokenModeConfig[mode].label,
    state: mode === props.tokenMode ? "on" : "off",
    attributes: { disabled: props.disabled || props.policy.readOnly },
  }));
}

function IconTrigger(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly width?: number;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      className="items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
      style={{ width: props.width ?? ICON_BUTTON, height: ICON_BUTTON }}
    >
      {props.children}
    </Pressable>
  );
}

/**
 * Below 620pt: one ellipsis for traits, mode, access and tokens. With `traitsOnly` (wide
 * footers, whose selects carry the policy) it holds the dial-less model options alone, like the
 * desktop menu's `showSessionPolicy={false}`.
 */
export function ComposerMoreControlsMenu(
  props: ComposerPolicyControlsProps & { readonly traitsOnly?: boolean },
) {
  const muted = useThemeColor("--color-icon-muted");
  const caution = useThemeColor("--color-access-caution");
  const traits = traitActions(props.traits, props.disabled);
  const policy = props.traitsOnly !== true;
  const mode = policy ? modeActions(props) : [];
  const tokens = policy && props.onSelectTokenMode ? tokenActions(props) : [];
  const actions: MenuAction[] = [
    ...traits,
    ...(mode.length > 0 ? [sectionTitle("#title:mode", "Mode"), ...mode] : []),
    ...(policy ? [sectionTitle("#title:access", "Access"), ...accessActions(props)] : []),
    ...(tokens.length > 0 ? [sectionTitle("#title:tokens", "Tokens"), ...tokens] : []),
  ];
  const titles = new Set(
    actions.filter((action) => action.id?.startsWith("#title:")).map((a) => a.id!),
  );
  // Every group after the first gets the desktop's divider above its heading.
  const firstTitle = actions[0]?.id;
  const separated = new Set([...titles].filter((id) => id !== firstTitle));
  const cautionTone =
    policy &&
    composerControlsCaution(
      props.policy.access.segments.find((segment) => segment.selected)?.value ??
        "approval-required",
    );
  return (
    <AnchoredMenu
      actions={actions}
      sectionTitleIds={titles}
      separatorBeforeIds={separated}
      menuWidth={240}
      subtitleStyle={{ fontSize: 11, lineHeight: 15 }}
      onClose={props.onClose}
      onPressAction={({ nativeEvent }) => handleAction(nativeEvent.event, props)}
    >
      {(open) => (
        <IconTrigger label="More composer controls" disabled={props.disabled} onPress={open}>
          <SymbolView
            name="ellipsis"
            size={15}
            weight="semibold"
            tintColor={cautionTone ? caution : muted}
            type="monochrome"
          />
        </IconTrigger>
      )}
    </AnchoredMenu>
  );
}

function PolicySelect(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly caution?: boolean;
  readonly actions: MenuAction[];
  readonly icons: ReadonlyMap<string, AppSymbolName>;
  readonly controls: ComposerPolicyControlsProps;
}) {
  const muted = useThemeColor("--color-icon-muted");
  const plain = useThemeColor("--color-icon");
  const caution = useThemeColor("--color-access-caution");
  return (
    <AnchoredMenu
      title={props.label.split(":")[0]}
      actions={props.actions}
      menuWidth={260}
      subtitleStyle={{ fontSize: 11, lineHeight: 15 }}
      onClose={props.controls.onClose}
      renderIcon={(action) => {
        const icon = action.id ? props.icons.get(action.id) : undefined;
        return icon ? (
          <SymbolView name={icon} size={15} tintColor={plain} type="monochrome" />
        ) : null;
      }}
      onPressAction={({ nativeEvent }) => handleAction(nativeEvent.event, props.controls)}
    >
      {(open) => (
        <IconTrigger
          label={props.label}
          disabled={props.controls.disabled}
          width={28}
          onPress={open}
        >
          <SymbolView
            name={props.icon}
            size={14}
            tintColor={props.caution ? caution : muted}
            type="monochrome"
          />
        </IconTrigger>
      )}
    </AnchoredMenu>
  );
}

/** 620pt and wider: the desktop's icon selects for mode, access and tokens. */
export function ComposerPolicySelects(props: ComposerPolicyControlsProps) {
  const mode = props.policy.mode;
  const selectedMode = mode?.segments.find((segment) => segment.selected);
  const selectedAccess = props.policy.access.segments.find((segment) => segment.selected);
  const describe = (actions: MenuAction[], descriptions: ReadonlyMap<string, string>) =>
    actions.map((action) => ({
      ...action,
      subtitle: action.subtitle ?? (action.id ? descriptions.get(action.id) : undefined),
    }));
  return (
    <>
      {mode && selectedMode ? (
        <PolicySelect
          label={`Interaction mode: ${selectedMode.shortLabel}`}
          icon={selectedMode.icon as AppSymbolName}
          actions={describe(
            modeActions(props),
            new Map(
              mode.segments.map((segment) => [
                `${MODE_PREFIX}${segment.value}`,
                segment.description,
              ]),
            ),
          )}
          icons={
            new Map(
              mode.segments.map((segment) => [
                `${MODE_PREFIX}${segment.value}`,
                segment.icon as AppSymbolName,
              ]),
            )
          }
          controls={props}
        />
      ) : null}
      {selectedAccess ? (
        <PolicySelect
          label={`Runtime mode: ${selectedAccess.label}`}
          icon={selectedAccess.icon as AppSymbolName}
          caution={selectedAccess.tone === "caution"}
          actions={describe(
            accessActions(props),
            new Map(
              props.policy.access.segments.map((segment) => [
                `${ACCESS_PREFIX}${segment.value}`,
                segment.description,
              ]),
            ),
          )}
          icons={
            new Map(
              props.policy.access.segments.map((segment) => [
                `${ACCESS_PREFIX}${segment.value}`,
                segment.icon as AppSymbolName,
              ]),
            )
          }
          controls={props}
        />
      ) : null}
      {props.onSelectTokenMode ? (
        <PolicySelect
          label={`Token mode: ${tokenModeConfig[props.tokenMode].triggerLabel}`}
          icon={tokenModeConfig[props.tokenMode].icon as AppSymbolName}
          actions={describe(
            tokenActions(props),
            new Map(
              tokenModeOptions.map((value) => [
                `${TOKENS_PREFIX}${value}`,
                tokenModeConfig[value].description,
              ]),
            ),
          )}
          icons={
            new Map(
              tokenModeOptions.map((value) => [
                `${TOKENS_PREFIX}${value}`,
                tokenModeConfig[value].icon as AppSymbolName,
              ]),
            )
          }
          controls={props}
        />
      ) : null}
    </>
  );
}
