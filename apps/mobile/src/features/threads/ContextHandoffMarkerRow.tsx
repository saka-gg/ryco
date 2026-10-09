import {
  CWD_RELOCATION_HANDOFF_COPY,
  cwdRelocationHandoffHeadline,
  cwdRelocationHandoffRetryHint,
  isCwdRelocationHandoff,
  type ContextHandoffTimelineEntry,
} from "@ryco/client-runtime/state/session";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { ContextHandoffEndpointLabel } from "./ContextHandoffEndpointLabel";
import { contextHandoffMarkerAccessibilityLabel } from "./contextHandoffModel";

export function ContextHandoffMarkerRow(props: { readonly marker: ContextHandoffTimelineEntry }) {
  const { marker } = props;
  const failed = marker.status === "failed";
  const uncertain = marker.status === "delivery-uncertain";
  // A working-folder relocation (a chat turned into a project) keeps its model: it reads as a
  // fresh session in the new folder, not as a model transition.
  const relocation = isCwdRelocationHandoff(marker);
  const retryHint = cwdRelocationHandoffRetryHint(marker);
  // Why the conversation moved to a fresh session (the web divider's hover card says the same).
  const relocationExplanation = relocation ? CWD_RELOCATION_HANDOFF_COPY.explanation : undefined;
  const iconColor = String(
    useThemeColor(
      failed ? "--color-danger-foreground" : uncertain ? "--color-warning" : "--color-icon-subtle",
    ),
  );
  const dividerClass = failed
    ? "bg-danger-foreground/40"
    : uncertain
      ? "bg-warning/40"
      : "bg-border";
  const textClass = failed
    ? "text-danger-foreground"
    : uncertain
      ? "text-warning"
      : "text-foreground-muted";

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={contextHandoffMarkerAccessibilityLabel(marker)}
      accessibilityHint={relocationExplanation}
      className="my-3 flex-row items-center gap-2 px-4"
    >
      <View className={`h-px min-w-2 flex-1 ${dividerClass}`} />
      <View className="max-w-[82%] items-center gap-1">
        <View className="flex-row items-center gap-1">
          <SymbolView
            name={relocation ? "folder" : "arrow.left.arrow.right"}
            size={13}
            tintColor={iconColor}
            type="monochrome"
          />
          <Text className={`shrink text-[11px] font-ryco-medium ${textClass}`}>
            {relocation ? cwdRelocationHandoffHeadline(marker.status) : "Context handoff"}
          </Text>
          {failed || uncertain ? (
            <Text className={`text-[10px] font-ryco-medium ${textClass}`}>
              {failed ? "Failed" : "Delivery uncertain"}
            </Text>
          ) : null}
        </View>
        {relocation ? (
          retryHint ? (
            <Text className="text-center text-[10px] text-foreground-muted">{retryHint}</Text>
          ) : null
        ) : (
          <ModelTransition marker={marker} iconColor={iconColor} textClass={textClass} />
        )}
      </View>
      <View className={`h-px min-w-2 flex-1 ${dividerClass}`} />
    </View>
  );
}

function ModelTransition(props: {
  readonly marker: ContextHandoffTimelineEntry;
  readonly iconColor: string;
  readonly textClass: string;
}) {
  const { marker, iconColor, textClass } = props;
  return (
    <View className="max-w-full flex-row items-center justify-center gap-1.5">
      {marker.sources.slice(0, 1).map((source) => (
        <ContextHandoffEndpointLabel
          key={`${source.providerInstanceId}:${source.modelSlug}`}
          endpoint={source}
        />
      ))}
      {marker.sources.length > 1 ? (
        <Text className={`text-[10px] font-ryco-medium ${textClass}`}>
          +{marker.sources.length - 1}
        </Text>
      ) : null}
      <SymbolView name="arrow.right" size={12} tintColor={iconColor} type="monochrome" />
      <ContextHandoffEndpointLabel endpoint={marker.target} emphasized />
    </View>
  );
}
