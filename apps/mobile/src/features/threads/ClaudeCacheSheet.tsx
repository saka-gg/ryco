import type { ClaudeCacheObservation } from "@ryco/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { BottomSheet } from "../../components/BottomSheet";
import { buildClaudeCacheDetail, CLAUDE_CACHE_UNKNOWN_DETAIL } from "./claudeCacheSummary";

/**
 * What Claude reported about its prompt cache on the thread's last request: behind the ⓘ on
 * the composer's model chip and the context sheet's cache row, out of the conversation's way.
 */
export function ClaudeCacheSheet(props: {
  readonly visible: boolean;
  readonly observation: ClaudeCacheObservation | undefined;
  readonly onClose: () => void;
}) {
  const detail = props.observation ? buildClaudeCacheDetail(props.observation) : null;
  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      accessibilityLabel="Claude prompt cache"
    >
      <View className="gap-1">
        <Text className="text-lg font-ryco-bold text-foreground">Prompt cache</Text>
        <Text className="text-xs text-foreground-tertiary">Observed on Claude's last request</Text>
      </View>
      {detail ? (
        <View className="gap-3 pb-2">
          <View className="gap-1 rounded-2xl bg-card px-4 py-3">
            <Text
              className="font-ryco-medium text-base text-foreground"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {detail.headline}
            </Text>
            <Text className="text-xs text-foreground-muted">{detail.lastRequest}</Text>
          </View>
          {detail.totals ? (
            <Text className="text-sm text-foreground-muted">{detail.totals}</Text>
          ) : null}
          <Text className="text-xs text-foreground-tertiary">{detail.caveat}</Text>
        </View>
      ) : (
        <Text className="pb-2 text-sm text-foreground-muted">{CLAUDE_CACHE_UNKNOWN_DETAIL}</Text>
      )}
    </BottomSheet>
  );
}
