import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ForkOriginTimelineEntry } from "@ryco/client-runtime/state/session";
import { selectThreadAvailabilityByRef } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useStore } from "../../state/threadsRuntime";
import { buildForkOriginRowModel, type ForkOriginRowModel } from "./forkOriginRowModel";

/**
 * The divider between a fork's inherited history and its own: where it came from, how its
 * provider continues and which files it works on. While the source is on this node the whole
 * divider is a link that opens it at the reply the fork ends at; once the source is known to be
 * gone it says so.
 */
export function ForkOriginRow(props: {
  readonly environmentId: EnvironmentId;
  readonly marker: ForkOriginTimelineEntry;
  readonly onOpenSource: (threadId: ThreadId, messageId: MessageId | null) => void;
}) {
  // Unknown until the environment's shell snapshot arrives: a source this device has not heard
  // of yet is never called gone.
  const source = useStore((state) =>
    selectThreadAvailabilityByRef(
      state,
      scopeThreadRef(props.environmentId, props.marker.sourceThreadId),
    ),
  );
  const model = buildForkOriginRowModel({ marker: props.marker, source });
  const iconColor = String(useThemeColor("--color-icon-subtle"));
  const content = <ForkOriginContent model={model} iconColor={iconColor} />;
  const { sourceThreadId, sourceMessageId } = model;

  return sourceThreadId ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={model.accessibilityLabel}
      onPress={() => props.onOpenSource(sourceThreadId, sourceMessageId)}
      className="my-3 px-4 active:opacity-70"
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={model.accessibilityLabel}
      className="my-3 px-4"
    >
      {content}
    </View>
  );
}

function ForkOriginContent(props: {
  readonly model: ForkOriginRowModel;
  readonly iconColor: string;
}) {
  const { model } = props;
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-2">
        <View className="h-px min-w-2 flex-1 bg-border" />
        <View className="max-w-[82%] flex-row items-center gap-1">
          <SymbolView
            name="arrow.triangle.branch"
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text
            className={`shrink text-[11px] font-ryco-medium ${
              model.sourceThreadId ? "text-primary" : "text-foreground-muted"
            }`}
            numberOfLines={2}
          >
            {model.headline}
          </Text>
        </View>
        <View className="h-px min-w-2 flex-1 bg-border" />
      </View>
      {model.sourceUnavailable ? (
        <Text className="text-center text-[10px] text-foreground-muted">
          {model.sourceUnavailable}
        </Text>
      ) : null}
      <Text className="text-center text-[10px] text-foreground-muted">{model.providerLine}</Text>
      <Text className="text-center text-[10px] text-foreground-muted">{model.checkoutLine}</Text>
      {model.notices.map((notice, index) => (
        <Text
          // The notices are immutable provenance and may repeat; position is stable.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="text-center text-[10px] text-foreground-tertiary"
        >
          {notice}
        </Text>
      ))}
    </View>
  );
}
