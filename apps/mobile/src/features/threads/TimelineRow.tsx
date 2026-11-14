import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import type { TimelineEntry } from "@ryco/client-runtime/state/session";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts/base-schemas";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useIsOptimisticUserMessage } from "../../state/optimisticUserMessages";
import { ContextHandoffMarkerRow } from "./ContextHandoffMarkerRow";
import { ForkOriginRow } from "./ForkOriginRow";
import { ProposedPlanCard, type ProposedPlanCardActions } from "./ProposedPlanCard";
import type { TurnHtmlRender } from "./threadActivityFold";
import { ThreadMessage } from "./ThreadMessage";
import { UserInputExchangeRow } from "./UserInputExchangeRow";

/** One timeline entry of the thread feed (activity folds are `ThreadActivityFoldRow`). */
export function TimelineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entry: TimelineEntry;
  readonly turnHtmlRenders?: ReadonlyArray<TurnHtmlRender> | undefined;
  /** Present only on a reply that can be forked right now. */
  readonly onForkFromMessage?: ((message: ChatMessage) => void) | undefined;
  /** Present only on a sent message the thread can be rewound to before right now. */
  readonly onEditFromMessage?: ((message: ChatMessage) => void) | undefined;
  /** Present only on a reply whose turn's file changes can be undone right now. */
  readonly onUndoFileChangesOfReply?: ((reply: ChatMessage) => void) | undefined;
  /** The blank reply a page row stands in for; its fork starts from that reply. */
  readonly forkReply?: ChatMessage | undefined;
  readonly onOpenThread: (threadId: ThreadId, messageId: MessageId | null) => void;
  /** The message a link opened this thread at. */
  readonly highlighted?: boolean | undefined;
  /** This row's plan can be implemented now. */
  readonly planActionable?: boolean | undefined;
  readonly planActions?: ProposedPlanCardActions | undefined;
}) {
  const { entry, onForkFromMessage, onEditFromMessage, onUndoFileChangesOfReply, forkReply } =
    props;
  const pending = useIsOptimisticUserMessage(
    scopedThreadKey(scopeThreadRef(props.environmentId, props.threadId)),
    entry.kind === "message" && entry.message.role === "user" ? entry.message.id : "",
  );
  if (entry.kind === "message") {
    const message = (
      <ThreadMessage
        environmentId={props.environmentId}
        threadId={props.threadId}
        message={entry.message}
        pending={pending}
        turnHtmlRenders={props.turnHtmlRenders}
        onForkFromHere={
          onForkFromMessage ? () => onForkFromMessage(forkReply ?? entry.message) : undefined
        }
        onEditFromHere={onEditFromMessage ? () => onEditFromMessage(entry.message) : undefined}
        onUndoFileChanges={
          onUndoFileChangesOfReply
            ? () => onUndoFileChangesOfReply(forkReply ?? entry.message)
            : undefined
        }
      />
    );
    return props.highlighted ? <View className="bg-primary/10">{message}</View> : message;
  }
  if (entry.kind === "proposed-plan") {
    return (
      <ProposedPlanCard
        plan={entry.proposedPlan}
        actionable={props.planActionable === true}
        actions={props.planActions}
      />
    );
  }
  if (entry.kind === "context-compaction") {
    return (
      <View className="my-3 flex-row items-center gap-2 px-6">
        <View className="h-px flex-1 bg-border" />
        <Text className="text-2xs uppercase tracking-wide text-foreground-muted">
          Context compacted
        </Text>
        <View className="h-px flex-1 bg-border" />
      </View>
    );
  }
  if (entry.kind === "context-handoff") {
    return <ContextHandoffMarkerRow marker={entry.marker} />;
  }
  if (entry.kind === "user-input-exchange") {
    return <UserInputExchangeRow exchange={entry.exchange} />;
  }
  if (entry.kind === "fork-origin") {
    return (
      <ForkOriginRow
        environmentId={props.environmentId}
        marker={entry.marker}
        onOpenSource={props.onOpenThread}
      />
    );
  }
  // Work entries never reach here — buildThreadTimelineRows folds them before
  // the list sees them. This is the remaining unknown-kind fallback.
  return null;
}
