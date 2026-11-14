import type { ThreadHistoryLoadState } from "@ryco/client-runtime/state/threads";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";

/**
 * The thread feed's list header: a spacer the list measures (unlike contentContainerStyle
 * padding), so following the end and anchoring still add up, and the earlier-history button
 * while there is more before.
 */
export function ThreadFeedListHeader(props: {
  /** The header (and any banner) the first message starts under. */
  readonly topInset: number;
  readonly hasMoreBefore: boolean;
  readonly loadStatus: ThreadHistoryLoadState["status"] | undefined;
  readonly onLoadOlder: () => void;
}) {
  const { loadStatus } = props;
  return (
    <>
      <View style={{ height: props.topInset }} />
      {props.hasMoreBefore || loadStatus === "loading" ? (
        <Pressable
          accessibilityRole="button"
          disabled={loadStatus === "loading"}
          onPress={props.onLoadOlder}
          className="items-center px-4 py-3"
        >
          <Text className="text-xs text-muted-foreground">
            {loadStatus === "loading"
              ? "Loading earlier history…"
              : loadStatus === "error"
                ? "Retry earlier history"
                : "Load earlier history"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}

/** The feed with no messages: still loading, or a task without any yet (or the cached copy). */
export function ThreadFeedEmptyState(props: {
  /** The thread's timeline is in the store. */
  readonly loaded: boolean;
  readonly threadTitle: string | null | undefined;
  /** What the cached view says instead (`deriveThreadCachedView`). */
  readonly cachedDetail: string | null;
}) {
  return (
    <View className="px-4 py-16">
      <EmptyState
        variant="plain"
        title={props.loaded ? (props.threadTitle ?? "Task") : "Loading task"}
        detail={
          props.cachedDetail ??
          (props.loaded
            ? "No messages yet. Send one to get started."
            : "Syncing the conversation from the node.")
        }
      />
    </View>
  );
}

/**
 * The header's glass floats over the feed: a fade under it keeps the title and the buttons
 * readable while messages scroll beneath.
 */
export function ThreadHeaderFade(props: {
  readonly height: number;
  /** A 6-digit hex, so the fade can append its alpha. */
  readonly screenColor: string;
}) {
  const { screenColor } = props;
  return (
    <View
      pointerEvents="none"
      className="absolute left-0 right-0 top-0"
      style={{
        height: props.height,
        experimental_backgroundImage: `linear-gradient(to bottom, ${screenColor} 0%, ${screenColor}f5 72%, ${screenColor}00 100%)`,
      }}
    />
  );
}
