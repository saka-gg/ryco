import {
  describeQueueHold,
  type FollowUpQueueEditAttachment,
  type FollowUpQueueRow,
  type QueueHold,
} from "@ryco/client-runtime/state/message-queue";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { QueuedThreadMessage } from "../../state/threadOutboxModel";

/** Rows move only among rows of their own kind (the node's, or this device's). */
function movableRange(rows: ReadonlyArray<FollowUpQueueRow>, index: number) {
  const source = rows[index]!.source;
  return {
    first: index === 0 || rows[index - 1]!.source !== source,
    last: index === rows.length - 1 || rows[index + 1]!.source !== source,
  };
}

/**
 * The queued messages of a thread: the node's queue where the node keeps one, adds on their way
 * ("Queuing…"), then this device's outbox. Rows and hold come from the shared view model
 * (`deriveFollowUpQueueView`), the same one web's composer shows.
 */
export function ThreadQueuedMessages(props: {
  readonly rows: ReadonlyArray<FollowUpQueueRow>;
  /** This device's outbox messages by id, for their own retry states. */
  readonly localMessages: ReadonlyMap<string, QueuedThreadMessage>;
  /** A recorded pause (Stop, error, stalled start); shared copy with web. */
  readonly hold?: QueueHold | null;
  readonly onResume?: () => void;
  /** Pauses the node's queue; only where the node keeps it. */
  readonly onPause?: () => void;
  readonly getSteerUnavailableReason: (row: FollowUpQueueRow) => string | null;
  readonly onSteer: (row: FollowUpQueueRow) => void;
  readonly onRetryReview?: (messageId: string) => void;
  /** Retries a message held after a steer the provider may have received. */
  readonly onRetryHeld?: (messageId: string) => void;
  /** Retries the node's failed entry. */
  readonly onRetry?: (row: FollowUpQueueRow) => void;
  readonly onRemove: (row: FollowUpQueueRow) => void;
  /** Pulls the message into the composer for editing. */
  readonly onEdit: (row: FollowUpQueueRow) => void;
  readonly getEditUnavailableReason: (row: FollowUpQueueRow) => string | null;
  /** Reorders the node's entries. */
  readonly onMove?: (row: FollowUpQueueRow, direction: "up" | "down") => void;
  /** The node's entry the composer is editing; the next send saves it. */
  readonly editingId?: string | null;
  /** The edited entry's stored attachments that stay with it. */
  readonly editingAttachments?: ReadonlyArray<FollowUpQueueEditAttachment>;
  /** Drops a stored attachment from the edit (absent while saving). */
  readonly onDropEditingAttachment?: (attachmentId: string) => void;
  readonly onCancelEdit?: () => void;
}) {
  const iconColor = String(useThemeColor("--color-icon"));
  const mutedColor = String(useThemeColor("--color-icon-subtle"));
  const { rows } = props;
  if (rows.length === 0) return null;
  const held = props.hold ? describeQueueHold(props.hold) : null;

  return (
    <View className="mx-4 mb-1 rounded-2xl border border-border bg-subtle/70 px-3 py-2">
      {held ? (
        <View className="mb-1 flex-row items-center gap-2">
          <Text className="text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            {held.title} · {rows.length}
          </Text>
          <Text numberOfLines={1} className="flex-1 text-2xs text-foreground-muted">
            {held.detail ?? ""}
          </Text>
          {props.onResume ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Resume queued messages"
              onPress={props.onResume}
              className="h-8 justify-center rounded-full px-2 active:opacity-70"
            >
              <Text className="text-xs font-ryco-bold text-foreground">Resume</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View className="mb-1 flex-row items-center gap-2">
          <Text className="flex-1 text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            Queued · {rows.length}
          </Text>
          {props.onPause ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Pause queued messages"
              onPress={props.onPause}
              className="h-8 justify-center rounded-full px-2 active:opacity-70"
            >
              <Text className="text-xs font-ryco-bold text-foreground">Pause</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {rows.map((row, index) => {
        const local = row.source === "local" ? props.localMessages.get(row.id) : undefined;
        // On its way to the node's queue: an add of this device, or an outbox message moving
        // there. Nothing can be done to it until it landed.
        const queuing = row.status === "queuing" || row.status === "moving";
        const editing = props.editingId != null && row.id === props.editingId;
        const steering = row.status === "steering";
        const unavailableReason = queuing || editing ? null : props.getSteerUnavailableReason(row);
        const editUnavailableReason =
          queuing || editing ? null : props.getEditUnavailableReason(row);
        const range = movableRange(rows, index);
        const movable = props.onMove !== undefined && row.source === "server";
        return (
          <View key={row.id} className="flex-row flex-wrap items-center gap-2 py-1">
            <Text className="flex-1 text-sm text-foreground">{row.summary}</Text>
            {local?.resumeReviewError && (
              <View className="flex-1 gap-1">
                <Text className="text-xs text-foreground-muted">{local.resumeReviewError}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Review and retry queued message"
                  onPress={() => props.onRetryReview?.(row.id)}
                >
                  <Text className="text-sm font-ryco-bold text-foreground">Review and retry</Text>
                </Pressable>
              </View>
            )}
            {local?.uncertainSteerError && (
              <View className="flex-1 gap-1">
                <Text className="text-xs text-foreground-muted">{local.uncertainSteerError}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send the held queued message again"
                  onPress={() => props.onRetryHeld?.(row.id)}
                >
                  <Text className="text-sm font-ryco-bold text-foreground">Send again</Text>
                </Pressable>
              </View>
            )}
            {row.source === "server" && row.status === "failed" && props.onRetry ? (
              <View className="flex-1 gap-1">
                <Text className="text-xs text-foreground-muted">
                  {row.failureDetail ?? "This message was not sent. Retry or remove it."}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Retry queued message"
                  onPress={() => props.onRetry?.(row)}
                >
                  <Text className="text-sm font-ryco-bold text-foreground">Retry</Text>
                </Pressable>
              </View>
            ) : null}
            {queuing ? <Text className="text-xs text-foreground-muted">Queuing…</Text> : null}
            {editing ? (
              <>
                <Text className="text-xs text-foreground-muted">Editing</Text>
                {props.onCancelEdit ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel editing queued message"
                    onPress={props.onCancelEdit}
                    className="h-9 justify-center rounded-full px-2 active:opacity-70"
                  >
                    <Text className="text-xs font-ryco-bold text-foreground">Cancel</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
            {queuing || editing ? null : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    unavailableReason ??
                    (steering ? "Steering queued message" : "Steer queued message into active turn")
                  }
                  disabled={unavailableReason !== null || steering}
                  onPress={() => props.onSteer(row)}
                  className="h-9 flex-row items-center justify-center gap-1 rounded-full bg-subtle-strong px-3 active:opacity-70 disabled:opacity-40"
                >
                  <SymbolView
                    name="arrow.turn.left.up"
                    size={14}
                    tintColor={steering ? mutedColor : iconColor}
                    type="monochrome"
                  />
                  <Text className="text-xs font-ryco-bold text-foreground">
                    {steering ? "Steering…" : "Steer"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={editUnavailableReason ?? "Edit queued message"}
                  disabled={editUnavailableReason !== null}
                  onPress={() => props.onEdit(row)}
                  className="h-9 w-9 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
                >
                  <SymbolView name="pencil" size={15} tintColor={mutedColor} type="monochrome" />
                </Pressable>
              </>
            )}
            {movable && !(range.first && range.last) ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Move queued message up"
                  disabled={range.first || editing}
                  onPress={() => props.onMove?.(row, "up")}
                  className="h-9 w-7 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
                >
                  <SymbolView
                    name="chevron.up"
                    size={13}
                    tintColor={mutedColor}
                    type="monochrome"
                  />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Move queued message down"
                  disabled={range.last || editing}
                  onPress={() => props.onMove?.(row, "down")}
                  className="h-9 w-7 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
                >
                  <SymbolView
                    name="chevron.down"
                    size={13}
                    tintColor={mutedColor}
                    type="monochrome"
                  />
                </Pressable>
              </>
            ) : null}
            {queuing ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove queued message"
                disabled={editing}
                onPress={() => props.onRemove(row)}
                className="h-9 w-9 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
              >
                <SymbolView name="xmark" size={15} tintColor={mutedColor} type="monochrome" />
              </Pressable>
            )}
            {editing && props.editingAttachments && props.editingAttachments.length > 0 ? (
              <View className="w-full flex-row flex-wrap gap-1.5">
                {props.editingAttachments.map((attachment) => (
                  <View
                    key={attachment.id}
                    className="max-w-[60%] flex-row items-center gap-1 rounded-full border border-border py-0.5 pl-2.5 pr-1"
                  >
                    <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                      {attachment.name}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Drop ${attachment.name} from the queued message`}
                      disabled={props.onDropEditingAttachment === undefined}
                      onPress={() => props.onDropEditingAttachment?.(attachment.id)}
                      className="h-7 w-7 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
                    >
                      <SymbolView name="xmark" size={11} tintColor={mutedColor} type="monochrome" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
