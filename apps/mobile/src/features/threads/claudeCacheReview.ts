import type { ClaudeCacheObservation } from "@ryco/contracts";
import { Alert, type AlertButton } from "react-native";
import type { ClaudeCacheReviewPresentation } from "@ryco/client-runtime/state/composer";

import { updatePreferences } from "../../state/preferencesStore";

export function describeObservedClaudeCache(evidence: ClaudeCacheObservation): string {
  return `Observed ${new Date(evidence.observedAt).toLocaleString()}: ${evidence.directInputTokens.toLocaleString()} direct input, ${evidence.cacheReadInputTokens.toLocaleString()} cache reads, ${evidence.cacheWriteInputTokens.toLocaleString()} cache writes. ${evidence.mainLoopTotals ? `Cumulative main-loop output: ${evidence.mainLoopTotals.outputTokens.toLocaleString()} tokens (a different scope from this request). ` : ""}Subagent usage is separate. Next-request cache availability is unknown; savings are not guaranteed. ${evidence.observedTtlSeconds ? `This write reported a ${evidence.observedTtlSeconds / 60}-minute lifetime.` : "No cache lifetime was reported."}`;
}

export const mobileClaudeCacheReview: ClaudeCacheReviewPresentation = {
  review: (review) =>
    new Promise((resolve) => {
      const evidence = review.observation;
      const compactUnavailable = review.compactUnavailableReason;
      const continueButton: AlertButton = {
        text: "Continue with full context",
        onPress: () => resolve("continue"),
      };
      const cancelButton: AlertButton = {
        text: "Cancel",
        style: "cancel",
        onPress: () => resolve("cancel"),
      };
      const dontAskAgainButton: AlertButton = {
        text: "Don't ask again",
        onPress: () => {
          updatePreferences({ claudeResumeReview: false });
          resolve("continue");
        },
      };
      Alert.alert(
        "Review large Claude resume",
        `${review.reason}\n\n${describeObservedClaudeCache(evidence)} ${compactUnavailable ?? "Compaction summarizes context and can consume tokens."}\n\nSettings → Defaults turns this review on or off for this device.`,
        // iOS shows the cancel button last whatever its position here. Android shows
        // the first three buttons and gives the last of them its positive (rightmost,
        // or top when stacked) slot, so Cancel stays third: the permanent opt-out never
        // takes the slot Android users tap to confirm. With compaction on offer that
        // leaves "Don't ask again" out on Android; Settings → Defaults still has it.
        compactUnavailable === null
          ? [
              continueButton,
              { text: "Compact then send", onPress: () => resolve("compact") },
              cancelButton,
              dontAskAgainButton,
            ]
          : [continueButton, dontAskAgainButton, cancelButton],
        { cancelable: true, onDismiss: () => resolve("cancel") },
      );
    }),
};
