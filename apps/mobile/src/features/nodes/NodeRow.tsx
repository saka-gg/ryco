import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { cn } from "../../lib/cn";

export interface NodeRowAction {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}

export interface NodeRowProps {
  readonly label: string;
  readonly detail: string;
  readonly transportLabel: string;
  readonly statusTone: StatusTone;
  readonly selected: boolean;
  readonly selectable?: boolean;
  readonly disabled?: boolean;
  readonly showDivider?: boolean;
  readonly onPress?: () => void;
  readonly actions?: ReadonlyArray<NodeRowAction>;
}

function NodeRowContent(props: NodeRowProps) {
  return (
    <View className="flex-row items-start gap-3 px-4 py-4">
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-base font-ryco-medium text-foreground"
            numberOfLines={1}
          >
            {props.label}
          </Text>
          {props.selected ? (
            <Text className="text-2xs font-ryco-bold uppercase tracking-wide text-accent-strong">
              Selected
            </Text>
          ) : null}
        </View>
        <Text className="text-xs font-ryco-medium text-foreground-muted" numberOfLines={2}>
          {props.transportLabel} · {props.detail}
        </Text>
      </View>
      <StatusPill
        size="compact"
        label={props.statusTone.label}
        pillClassName={props.statusTone.pillClassName}
        textClassName={props.statusTone.textClassName}
      />
    </View>
  );
}

function NodeRowActions(props: Pick<NodeRowProps, "actions" | "label">) {
  return props.actions && props.actions.length > 0 ? (
    <View className="flex-row flex-wrap gap-2 px-4 pb-4">
      {props.actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={`${action.label} ${props.label}`}
          disabled={action.disabled}
          onPress={action.onPress}
          className={cn(
            "h-11 items-center justify-center rounded-xl border px-3 active:bg-subtle disabled:opacity-40",
            action.destructive ? "border-danger-border" : "border-border",
          )}
        >
          <Text
            className={cn(
              "text-xs font-ryco-bold",
              action.destructive ? "text-danger-foreground" : "text-foreground",
            )}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  ) : null;
}

export function NodeRow(props: NodeRowProps) {
  const className = cn(
    props.showDivider && "border-t border-border-subtle",
    props.disabled && "opacity-45",
  );
  const accessibilityLabel = `${props.label}, ${props.transportLabel}, ${props.detail}, ${props.statusTone.label}`;

  return (
    <View className={className}>
      {props.selectable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled: props.disabled, selected: props.selected }}
          disabled={props.disabled}
          onPress={props.onPress}
          className="active:bg-subtle"
        >
          <NodeRowContent {...props} />
        </Pressable>
      ) : (
        <NodeRowContent {...props} />
      )}
      <NodeRowActions label={props.label} actions={props.actions} />
    </View>
  );
}
