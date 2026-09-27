import { Alert, Pressable } from "react-native";
import type { OrchestrationThreadActivity } from "@ryco/contracts";
import { latestClaudeCacheObservation } from "@ryco/client-runtime/state/composer";
import { AppText as Text } from "../../components/AppText";
import { describeObservedClaudeCache } from "./claudeCacheReview";

export function ClaudeCacheDetails({
  activities,
}: {
  readonly activities: readonly OrchestrationThreadActivity[];
}) {
  const observation = latestClaudeCacheObservation(activities);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Observed Claude cache usage"
      className="mx-4 mb-2 py-1"
      onPress={() =>
        Alert.alert(
          "Observed Claude cache usage",
          observation
            ? describeObservedClaudeCache(observation)
            : "No authoritative cache usage is available for this context. Next-request cache availability is unknown.",
        )
      }
    >
      <Text className="text-xs text-foreground-muted">
        {observation
          ? `Observed cache · ${observation.cacheReadInputTokens.toLocaleString()} read · ${observation.cacheWriteInputTokens.toLocaleString()} written`
          : "Claude cache · unknown"}
      </Text>
    </Pressable>
  );
}
