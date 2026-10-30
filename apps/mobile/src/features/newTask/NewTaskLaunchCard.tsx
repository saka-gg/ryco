import { ActivityIndicator, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import type { NewTaskLaunchStepView, NewTaskLaunchView } from "./newTaskLaunch";

function StepGlyph(props: { readonly status: NewTaskLaunchStepView["status"] }) {
  const iconColor = String(useThemeColor("--color-icon"));
  const mutedColor = String(useThemeColor("--color-icon-subtle"));
  const dangerColor = String(useThemeColor("--color-danger-foreground"));
  if (props.status === "running") return <ActivityIndicator size="small" color={iconColor} />;
  if (props.status === "done")
    return <SymbolView name="checkmark" size={13} tintColor={iconColor} type="monochrome" />;
  if (props.status === "failed")
    return <SymbolView name="xmark" size={13} tintColor={dangerColor} type="monochrome" />;
  return (
    <SymbolView
      name={props.status === "skipped" ? "minus" : "circle"}
      size={11}
      tintColor={mutedColor}
      type="monochrome"
    />
  );
}

/**
 * A New Task on its thread screen before the node's own thread shows it: the
 * task as sent, the steps the node takes for it, and after a failure Retry.
 * While the node holds nothing for it (queued, or refused) it can also be
 * edited or removed.
 */
export function NewTaskLaunchCard(props: {
  readonly view: NewTaskLaunchView;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { view } = props;
  return (
    <View className="gap-4 px-4 py-6">
      <View className="self-end rounded-[20px] bg-subtle px-4 py-3" style={{ maxWidth: "88%" }}>
        <Text className="font-sans text-base text-foreground" selectable>
          {view.prompt}
        </Text>
        {view.attachmentCount > 0 ? (
          <Text className="mt-1 font-sans text-xs text-foreground-muted">
            {view.attachmentCount === 1 ? "1 image" : `${view.attachmentCount} images`}
          </Text>
        ) : null}
      </View>

      <View className="gap-2 rounded-2xl border border-border bg-card px-4 py-3">
        <Text className="font-ryco-bold text-sm text-foreground">{view.statusLabel}</Text>
        {view.steps.map((step) => (
          <View key={step.id} className="flex-row items-center gap-3">
            <View className="w-4 items-center">
              <StepGlyph status={step.status} />
            </View>
            <Text
              className={`flex-1 font-sans text-sm ${
                step.status === "pending" || step.status === "skipped"
                  ? "text-foreground-muted"
                  : "text-foreground"
              }`}
            >
              {step.label}
              {step.status === "running" && step.percent !== null ? ` · ${step.percent}%` : ""}
            </Text>
          </View>
        ))}
        {view.failureMessage ? (
          <Text className="font-sans text-sm text-danger-foreground">{view.failureMessage}</Text>
        ) : null}
        {view.canRetry || view.canEdit || view.canRemove ? (
          <View className="mt-1 flex-row gap-2">
            {view.canRetry ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onRetry}
                className="h-10 items-center justify-center rounded-full bg-primary px-4"
              >
                <Text className="font-ryco-bold text-sm text-primary-foreground">Retry</Text>
              </Pressable>
            ) : null}
            {view.canEdit ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onEdit}
                className="h-10 items-center justify-center rounded-full bg-subtle px-4"
              >
                <Text className="font-ryco-bold text-sm text-foreground">Edit task</Text>
              </Pressable>
            ) : null}
            {view.canRemove ? (
              <Pressable
                accessibilityRole="button"
                onPress={props.onRemove}
                className="h-10 items-center justify-center rounded-full px-4"
              >
                <Text className="font-ryco-bold text-sm text-danger-foreground">Remove</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
