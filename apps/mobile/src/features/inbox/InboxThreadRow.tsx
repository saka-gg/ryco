import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ChangeRequestBadge } from "../../components/ChangeRequestBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { relativeTime } from "../../lib/time";
import type { InboxThreadRow as InboxThreadRowModel, InboxThreadState } from "./inboxModel";

function statusDotClassName(state: InboxThreadState): string {
  switch (state) {
    case "needs-input":
      return "bg-warning";
    case "delivery-unknown":
    case "error":
      return "bg-danger-foreground";
    case "working":
    case "connecting":
      return "bg-accent";
    case "reconnecting":
      return "border-2 border-warning";
    case "offline":
    case "idle":
      return "border border-foreground-tertiary";
    case "settled":
      return "bg-foreground-tertiary";
  }
}

function statusTextClassName(state: InboxThreadState): string {
  switch (state) {
    case "needs-input":
    case "reconnecting":
      return "text-warning";
    case "delivery-unknown":
    case "error":
      return "text-danger-foreground";
    case "working":
    case "connecting":
      return "text-accent-strong";
    case "offline":
    case "idle":
    case "settled":
      return "text-foreground-tertiary";
  }
}

export function InboxThreadRow(props: {
  readonly row: InboxThreadRowModel;
  readonly onPress: () => void;
  readonly onLongPress?: (() => void) | undefined;
}) {
  const settled = props.row.attentionState === "settled";
  // A badge that exists only in pixels is invisible to VoiceOver, so the two
  // provenance markers join the accessible name in the order they are read.
  const accessibilityLabel = [
    props.row.title,
    props.row.contextLabel,
    props.row.statusLabel,
    ...(props.row.roleLabel === null ? [] : [props.row.roleLabel]),
    ...(props.row.trustLabel === null ? [] : [props.row.trustLabel]),
    ...(props.row.providerLabel === null ? [] : [`Provider: ${props.row.providerLabel}`]),
    ...(props.row.focusTitle === null ? [] : [props.row.focusTitle]),
    ...(props.row.focusDetail === null ? [] : [props.row.focusDetail]),
  ].join(", ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      className={`mx-4 mb-2.5 flex-row items-start gap-3 rounded-2xl px-4 active:bg-card-alt ${
        settled ? "bg-subtle py-2.5" : "bg-card py-3.5"
      }`}
    >
      <View className={`mt-1.5 h-2.5 w-2.5 rounded-full ${statusDotClassName(props.row.state)}`} />
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-baseline gap-3">
          <Text
            className="min-w-0 flex-1 font-ryco-medium text-[17px] leading-[22px] text-foreground"
            numberOfLines={1}
          >
            {props.row.title}
          </Text>
          <Text className="font-mono text-2xs text-foreground-tertiary">
            {props.row.snoozedUntil
              ? `Until ${new Date(props.row.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
              : relativeTime(props.row.updatedAt)}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <DeviceIcon environmentId={props.row.environmentId} size={12} />
          <Text
            className="min-w-0 flex-1 font-sans text-xs text-foreground-muted"
            numberOfLines={1}
          >
            {props.row.contextLabel}
          </Text>
        </View>
        {props.row.focusTitle === null ? null : (
          <View className="flex-row items-center gap-1.5">
            <Text className="font-ryco-medium text-xs text-foreground" numberOfLines={1}>
              {props.row.focusTitle}
            </Text>
            {props.row.focusAiGenerated ? (
              <Text className="font-sans text-2xs text-foreground-tertiary">AI</Text>
            ) : null}
            <Text
              className="min-w-0 flex-1 font-sans text-xs text-foreground-muted"
              numberOfLines={1}
            >
              {props.row.focusDetail}
            </Text>
          </View>
        )}
        <View className="flex-row items-center gap-2">
          <Text
            className={`shrink text-xs font-ryco-medium ${statusTextClassName(props.row.state)}`}
            numberOfLines={1}
          >
            {props.row.statusLabel}
          </Text>
          {props.row.roleLabel === null ? null : (
            <Text
              className="shrink text-xs font-ryco-medium text-foreground-tertiary"
              numberOfLines={1}
            >
              {props.row.roleLabel}
            </Text>
          )}
          {/* The danger tone the same label already carries on the hosted pill —
              no second guarantee-to-colour mapping is invented here. */}
          {props.row.trustLabel === null ? null : (
            <Text
              className="shrink text-xs font-ryco-medium text-danger-foreground"
              numberOfLines={1}
            >
              {props.row.trustLabel}
            </Text>
          )}
          {props.row.changeRequest ? <ChangeRequestBadge badge={props.row.changeRequest} /> : null}
          <View
            accessibilityElementsHidden
            className="ml-auto h-6 w-6 shrink-0 items-center justify-center rounded-full bg-subtle"
          >
            <ProviderIcon provider={props.row.providerDriver} size={15} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}
