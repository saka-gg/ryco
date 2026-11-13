import { derivePromptSuggestion, type PromptSuggestion } from "@ryco/client-runtime/state/session";
import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ServerConfig,
} from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { useEnvironmentServerConfigSelector } from "../../hooks/useChatsAvailability";
import { useMediaQuery } from "../../hooks/useMediaQuery";

// Suggestions Escape dismissed, keyed by environment, thread and turn, shared by every mounted
// composer (split panes) and kept across remounts. Turn ids repeat across threads and nodes.
let dismissedKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const readDismissed = () => dismissedKeys;
const dismissKey = (environmentId: EnvironmentId, threadId: string, turnId: string) =>
  `${environmentId}\u0000${threadId}\u0000${turnId}`;

// Older nodes decode the missing setting as false, so true also proves they write suggestions.
const selectPromptSuggestionsEnabled = (config: ServerConfig | null): boolean =>
  config?.settings.promptSuggestions === true;

/** Test seam: forget every dismissal. */
export function resetDismissedPromptSuggestionsForTests(): void {
  dismissedKeys = new Set();
  for (const listener of listeners) listener();
}

/**
 * The provider's predicted next prompt for the thread's latest completed turn, while the node's
 * `promptSuggestions` setting is on and Escape has not dismissed it. Null on devices without a
 * mouse or trackpad: Tab is the only way to accept one.
 */
export function usePromptSuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity> | undefined;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null;
}): { readonly suggestion: PromptSuggestion | null; readonly dismiss: () => void } {
  const enabled = useEnvironmentServerConfigSelector(
    input.environmentId,
    selectPromptSuggestionsEnabled,
  );
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed);
  const { environmentId, threadId, activities, latestTurn } = input;
  // Cheap: the newest suggestion activity sits at the end of the list.
  const offered =
    enabled && hasFinePointer && threadId !== null
      ? derivePromptSuggestion({ activities, latestTurn })
      : null;
  const suggestion =
    offered !== null &&
    threadId !== null &&
    !dismissed.has(dismissKey(environmentId, threadId, offered.turnId))
      ? offered
      : null;
  return {
    suggestion,
    dismiss: () => {
      if (suggestion === null || threadId === null) return;
      dismissedKeys = new Set(dismissedKeys).add(
        dismissKey(environmentId, threadId, suggestion.turnId),
      );
      for (const listener of listeners) listener();
    },
  };
}
