import {
  CWD_RELOCATION_HANDOFF_COPY,
  cwdRelocationHandoffHeadline,
  cwdRelocationHandoffRetryHint,
  FORK_HANDOFF_COPY,
  forkHandoffEndpointLabels,
  forkHandoffHeadline,
  forkHandoffRetryHint,
  isCwdRelocationHandoff,
  isForkHandoff,
  type ContextHandoffTimelineEntry,
} from "@ryco/client-runtime/state/session";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { ContextHandoffEndpointLabel } from "./ContextHandoffEndpointLabel";
import {
  CONTEXT_HANDOFF_ENDPOINT_LABELERS,
  contextHandoffMarkerAccessibilityLabel,
} from "./contextHandoffModel";

export function ContextHandoffMarkerRow(props: { readonly marker: ContextHandoffTimelineEntry }) {
  const { marker } = props;
  const failed = marker.status === "failed";
  const uncertain = marker.status === "delivery-uncertain";
  // A working-folder relocation (a chat turned into a project) and a fork's first session read as
  // a fresh session, not as a model transition; a fork that also switched provider names the
  // model it switched from in its headline (`changedFrom`).
  const relocation = isCwdRelocationHandoff(marker);
  const fork = isForkHandoff(marker);
  const freshSession = relocation || fork;
  const forkLabels = fork
    ? forkHandoffEndpointLabels(marker, CONTEXT_HANDOFF_ENDPOINT_LABELERS)
    : null;
  const headline = relocation
    ? cwdRelocationHandoffHeadline(marker.status)
    : forkLabels
      ? forkHandoffHeadline(marker.status, forkLabels.target, forkLabels.source)
      : "Context handoff";
  const retryHint = relocation
    ? cwdRelocationHandoffRetryHint(marker)
    : fork
      ? forkHandoffRetryHint(marker)
      : null;
  // Why the conversation moved to a fresh session (the web divider's hover card says the same).
  const explanation = relocation
    ? CWD_RELOCATION_HANDOFF_COPY.explanation
    : fork
      ? FORK_HANDOFF_COPY.explanation
      : undefined;
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
      accessibilityHint={explanation}
      className="my-3 flex-row items-center gap-2 px-4"
    >
      <View className={`h-px min-w-2 flex-1 ${dividerClass}`} />
      <View className="max-w-[82%] items-center gap-1">
        <View className="flex-row items-center gap-1">
          <SymbolView
            name={relocation ? "folder" : fork ? "arrow.triangle.branch" : "arrow.left.arrow.right"}
            size={13}
            tintColor={iconColor}
            type="monochrome"
          />
          <Text className={`shrink text-[11px] font-ryco-medium ${textClass}`}>{headline}</Text>
          {/* A fork's headline already says the delivery failed or is unconfirmed. */}
          {(failed || uncertain) && !fork ? (
            <Text className={`text-[10px] font-ryco-medium ${textClass}`}>
              {failed ? "Failed" : "Delivery uncertain"}
            </Text>
          ) : null}
        </View>
        {freshSession ? (
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
