import type { EnvironmentId } from "@ryco/contracts";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ChangeRequestBadge } from "../../components/ChangeRequestBadge";
import { CheckSummaryBadge } from "../../components/CheckSummaryBadge";
import { useThemeColor } from "../../lib/useThemeColor";
import type { CheckSummary } from "./prCheckSummary";
import type { ThreadHeaderModel } from "./threadHeaderModel";

export function ThreadContextBar(props: {
  readonly model: ThreadHeaderModel;
  readonly environmentId: EnvironmentId;
  readonly checks?: CheckSummary | null;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const statusClassName =
    props.model.statusLabel === "Needs approval" || props.model.statusLabel === "Input needed"
      ? "text-warning"
      : props.model.statusLabel === "Running"
        ? "text-accent-strong"
        : "text-foreground-tertiary";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.model.contextAccessibilityLabel}
      onPress={props.onPress}
      className="mx-4 mb-1 min-h-16 flex-row items-center gap-3 rounded-2xl border border-border bg-card-translucent px-4 py-2.5 active:bg-card-alt"
    >
      <View className="h-9 w-9 items-center justify-center rounded-xl bg-subtle">
        <DeviceIcon environmentId={props.environmentId} label={props.model.nodeLabel} size={20} />
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted"
            numberOfLines={1}
          >
            {props.model.nodeLabel}
          </Text>
          <Text className={`text-2xs font-ryco-bold ${statusClassName}`}>
            {props.model.statusLabel}
          </Text>
        </View>
        <View className="mt-0.5 flex-row items-center gap-2">
          <Text className="shrink text-sm font-ryco-medium text-foreground" numberOfLines={1}>
            {props.model.projectLabel} · {props.model.worktreeLabel}
          </Text>
          {props.model.changeRequest ? (
            <ChangeRequestBadge badge={props.model.changeRequest} />
          ) : null}
          {props.checks ? <CheckSummaryBadge summary={props.checks} /> : null}
        </View>
      </View>
      <SymbolView
        name="chevron.right"
        size={13}
        tintColor={iconColor as string}
        type="monochrome"
      />
    </Pressable>
  );
}
