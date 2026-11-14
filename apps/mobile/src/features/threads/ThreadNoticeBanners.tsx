import type { HostedDeliveryNotice } from "@ryco/client-runtime/authorization";
import type { FailedTurnNotice } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts/base-schemas";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import type { ThreadCachedViewBanner } from "./threadCachedViewModel";
import { ThreadFindBar } from "./ThreadFindBar";
import type { ThreadFindMessage } from "./threadFindModel";

/**
 * The cached / degraded strip. Sits with ErrorBanner between the context bar
 * and the timeline, and carries the context bar's `mx-4` so the three read as
 * one column. Copy and tone are decided in threadCachedViewModel.ts. The quiet
 * restart interruption line uses it too.
 */
export function ThreadCachedBanner(props: {
  readonly text: string;
  readonly tone: "info" | "warning";
  readonly testID?: string;
}) {
  const warning = props.tone === "warning";
  return (
    <View
      accessibilityRole="alert"
      testID={props.testID ?? "thread-cached-banner"}
      className={`mx-4 rounded-2xl px-3.5 py-3 ${warning ? "bg-warning-bg" : "bg-card"}`}
    >
      <Text
        className={`font-ryco-medium text-sm ${warning ? "text-warning" : "text-foreground-muted"}`}
      >
        {props.text}
      </Text>
    </View>
  );
}

/**
 * An action sent to this machine may not have arrived before its connection
 * dropped. Sits with the cached strip so it is seen where a retry would start;
 * copy and readiness come from threadDeliveryNoticeModel.ts.
 */
export function ThreadDeliveryBanner(props: {
  readonly notice: HostedDeliveryNotice;
  readonly onContinue: () => void;
}) {
  const { notice } = props;
  return (
    <View
      accessibilityRole="alert"
      testID="thread-delivery-banner"
      className="mx-4 rounded-2xl bg-warning-bg px-3.5 py-3"
    >
      <Text className="font-ryco-bold text-sm text-warning">{notice.title}</Text>
      <Text className="mt-1 font-ryco-medium text-sm text-warning">{notice.description}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !notice.canAcknowledge }}
        disabled={!notice.canAcknowledge}
        onPress={props.onContinue}
        className={`mt-2 self-start rounded-full px-3 py-1.5 ${
          notice.canAcknowledge ? "bg-subtle-strong active:opacity-70" : "bg-subtle opacity-60"
        }`}
      >
        <Text className="font-ryco-bold text-sm text-foreground">{notice.actionLabel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * A failed last turn, with Continue (a plain message, `CONTINUE_AFTER_FAILURE_PROMPT`) and
 * Dismiss (kept per turn by the screen).
 */
export function ThreadFailedTurnBanner(props: {
  readonly notice: FailedTurnNotice;
  readonly onContinue: () => void;
  readonly onDismiss: (turnId: string) => void;
}) {
  const { notice } = props;
  return (
    <View
      accessibilityRole="alert"
      testID="thread-failed-turn-banner"
      className="mx-4 gap-2 rounded-2xl bg-danger px-3.5 py-3"
    >
      <Text className="font-ryco-medium text-sm text-danger-foreground">{notice.title}</Text>
      {notice.detail ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={4}>
          {notice.detail}
        </Text>
      ) : null}
      <Text className="text-2xs text-foreground-tertiary">
        To try another model, pick it in the composer first.
      </Text>
      <View className="flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          onPress={props.onContinue}
          className="rounded-full bg-foreground px-3 py-1.5 active:opacity-70"
        >
          <Text className="font-ryco-medium text-xs text-background">Continue</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onDismiss(notice.turnId)}
          className="rounded-full border border-border px-3 py-1.5 active:opacity-70"
        >
          <Text className="font-ryco-medium text-xs text-foreground">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The notices that float under the header, the feed starting below them: find in chat, the
 * cached strip, an unconfirmed delivery, the error, a failed turn and a restart interruption.
 * The screen decides which show (and whether the stack shows at all); it measures the stack's
 * height through `onHeightChange`.
 */
export function ThreadBannerStack(props: {
  readonly top: number;
  readonly onHeightChange: (height: number) => void;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly findOpen: boolean;
  readonly findMessages: ReadonlyArray<ThreadFindMessage>;
  readonly onFindGoTo: (messageId: MessageId) => void;
  readonly onFindClose: () => void;
  readonly cachedBanner: ThreadCachedViewBanner | null;
  readonly deliveryNotice: HostedDeliveryNotice | null;
  readonly onContinueDelivery: () => void;
  readonly errorMessage: string | null;
  readonly failedNotice: FailedTurnNotice | null;
  readonly onContinueFailedTurn: () => void;
  readonly onDismissFailedTurn: (turnId: string) => void;
  readonly restartNotice: string | null;
}) {
  const { cachedBanner, deliveryNotice, errorMessage, failedNotice, restartNotice } = props;
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 gap-1"
      style={{ top: props.top }}
      onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
    >
      {props.findOpen ? (
        <ThreadFindBar
          environmentId={props.environmentId}
          threadId={props.threadId}
          messages={props.findMessages}
          onGoTo={props.onFindGoTo}
          onClose={props.onFindClose}
        />
      ) : null}
      {cachedBanner ? (
        <ThreadCachedBanner text={cachedBanner.text} tone={cachedBanner.tone} />
      ) : null}
      {deliveryNotice ? (
        <ThreadDeliveryBanner notice={deliveryNotice} onContinue={props.onContinueDelivery} />
      ) : null}
      {errorMessage ? <ErrorBanner message={errorMessage} /> : null}
      {failedNotice ? (
        <ThreadFailedTurnBanner
          notice={failedNotice}
          onContinue={props.onContinueFailedTurn}
          onDismiss={props.onDismissFailedTurn}
        />
      ) : null}
      {restartNotice ? (
        <ThreadCachedBanner text={restartNotice} tone="info" testID="thread-restart-banner" />
      ) : null}
    </View>
  );
}
