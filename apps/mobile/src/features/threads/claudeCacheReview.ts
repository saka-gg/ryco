import type { ClaudeCacheObservation } from "@ryco/contracts";
import { Alert } from "react-native";
import type { ClaudeCacheReviewPresentation } from "@ryco/client-runtime/state/composer";

export function describeObservedClaudeCache(evidence: ClaudeCacheObservation): string {
  return `Observed ${new Date(evidence.observedAt).toLocaleString()}: ${evidence.directInputTokens.toLocaleString()} direct input, ${evidence.cacheReadInputTokens.toLocaleString()} cache reads, ${evidence.cacheWriteInputTokens.toLocaleString()} cache writes. ${evidence.mainLoopTotals ? `Cumulative main-loop output: ${evidence.mainLoopTotals.outputTokens.toLocaleString()} tokens (a different scope from this request). ` : ""}Subagent usage is separate. Next-request cache availability is unknown; savings are not guaranteed. ${evidence.observedTtlSeconds ? `This write reported a ${evidence.observedTtlSeconds / 60}-minute lifetime.` : "No cache lifetime was reported."}`;
}

export const mobileClaudeCacheReview: ClaudeCacheReviewPresentation = {
  review: (review) =>
    new Promise((resolve) => {
      const evidence = review.observation;
      Alert.alert(
        "Review large Claude resume",
        `${review.reason}\n\n${describeObservedClaudeCache(evidence)} Compaction summarizes context and can consume tokens.`,
        [
          { text: "Continue with full context", onPress: () => resolve("continue") },
          { text: "Compact then send", onPress: () => resolve("compact") },
          { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
        ],
        { cancelable: true, onDismiss: () => resolve("cancel") },
      );
    }),
};
