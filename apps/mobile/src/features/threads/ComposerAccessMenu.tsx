import type { ReactNode } from "react";
import type { MenuAction } from "@react-native-menu/menu";
import type { ProviderInteractionMode, RuntimeMode } from "@ryco/contracts";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { resolveSessionPolicySelection, type SessionPolicyModel } from "./sessionPolicyModel";

export function ComposerAccessMenu(props: {
  readonly model: SessionPolicyModel;
  readonly disabled: boolean;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode?: (mode: ProviderInteractionMode) => void;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon");
  const accessColor = useThemeColor("--color-access-caution");
  const segments = [props.model.access, ...(props.model.mode ? [props.model.mode] : [])].flatMap(
    (group) =>
      group.segments.map((segment) => ({ ...segment, id: `${group.key}:${segment.value}` })),
  );
  const actionFor = (id: string): MenuAction => {
    const segment = segments.find((entry) => entry.id === id)!;
    return {
      id,
      title: segment.label,
      subtitle: segment.disabledReason ?? segment.description,
      titleColor: segment.tone === "caution" ? accessColor : undefined,
      state: segment.selected ? "on" : "off",
      attributes: { disabled: props.disabled || segment.disabled },
    };
  };
  const selectedMode = props.model.mode?.segments.find((segment) => segment.selected);
  const actions: MenuAction[] = props.model.access.segments.map((segment) =>
    actionFor(`access:${segment.value}`),
  );
  if (props.model.mode && props.onSelectInteractionMode)
    actions.push({
      id: "mode",
      title: `Mode: ${selectedMode?.label ?? "Build"}`,
      attributes: { disabled: props.disabled || props.model.readOnly },
      subactions: props.model.mode.segments.map((segment) => actionFor(`mode:${segment.value}`)),
    });
  return (
    <AnchoredMenu
      title="Access"
      subtitleStyle={{ fontSize: 11, lineHeight: 15 }}
      menuWidth={320}
      submenuWidth={288}
      actions={actions}
      onClose={props.onClose}
      renderIcon={(action) => {
        const segment =
          action.id === "mode" ? selectedMode : segments.find((entry) => entry.id === action.id);
        return segment ? (
          <SymbolView
            name={segment.icon}
            size={18}
            tintColor={segment.tone === "caution" ? accessColor : iconColor}
            type="monochrome"
          />
        ) : null;
      }}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        const access = props.model.access.segments.find(
          (segment) => `access:${segment.value}` === nativeEvent.event,
        );
        if (access) {
          const next = resolveSessionPolicySelection(props.model.access, access.value);
          if (next) props.onSelectRuntimeMode(next);
        }
        const mode = props.model.mode?.segments.find(
          (segment) => `mode:${segment.value}` === nativeEvent.event,
        );
        if (mode && props.model.mode) {
          const next = resolveSessionPolicySelection(props.model.mode, mode.value);
          if (next) props.onSelectInteractionMode?.(next);
        }
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}
