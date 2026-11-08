import type { ReviewDraftComment } from "@ryco/client-runtime/state/pull-request-review";
import type { ChangeRequestReviewThread } from "@ryco/contracts";
import { epochMillis } from "@ryco/shared/changeRequestChecks";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { ActorLine, PullRequestMarkdown } from "./PullRequestParts";

/** What the comment sheet is writing: a new line comment, or an edit of a draft one. */
export type LineCommentTarget =
  | {
      readonly kind: "new";
      readonly line: number;
      readonly side: "left" | "right";
      readonly code: string;
    }
  | { readonly kind: "edit"; readonly comment: ReviewDraftComment; readonly code: string | null };

/**
 * Writes one line comment into the review draft (sent with the review, like
 * the host's "Start a review"). Editing a draft comment can also delete it.
 */
export function LineCommentSheet(props: {
  readonly target: LineCommentTarget | null;
  readonly path: string;
  readonly onSave: (target: LineCommentTarget, body: string) => void;
  readonly onDelete: (comment: ReviewDraftComment) => void;
  readonly onClose: () => void;
}) {
  const { target } = props;
  return (
    <Modal
      visible={target !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {target ? (
        <LineCommentForm
          key={target.kind === "edit" ? target.comment.id : `${target.side}:${target.line}`}
          target={target}
          path={props.path}
          onSave={props.onSave}
          onDelete={props.onDelete}
          onClose={props.onClose}
        />
      ) : null}
    </Modal>
  );
}

function LineCommentForm(props: {
  readonly target: LineCommentTarget;
  readonly path: string;
  readonly onSave: (target: LineCommentTarget, body: string) => void;
  readonly onDelete: (comment: ReviewDraftComment) => void;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const [body, setBody] = useState(target.kind === "edit" ? target.comment.body : "");
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  const line = target.kind === "new" ? target.line : (target.comment.line ?? null);
  const side = target.kind === "new" ? target.side : (target.comment.side ?? "right");
  const code = target.kind === "new" ? target.code : target.code;
  const ready = body.trim().length > 0;
  return (
    <View className="flex-1 bg-screen">
      <View className="flex-row items-center gap-3 px-4 pb-2 pt-4">
        <Pressable
          accessibilityRole="button"
          onPress={props.onClose}
          className="h-11 min-w-16 justify-center active:opacity-60"
        >
          <Text className="text-base text-foreground">Cancel</Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          {target.kind === "edit" ? "Edit comment" : "Comment"}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={!ready}
          onPress={() => props.onSave(target, body.trim())}
          className="h-11 min-w-16 items-end justify-center active:opacity-60 disabled:opacity-30"
        >
          <Text className="text-base font-ryco-bold text-primary">
            {target.kind === "edit" ? "Save" : "Add"}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}
      >
        <View className="gap-1.5 rounded-xl bg-card px-3 py-2.5">
          <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
            {props.path}
            {line !== null ? `:${line}` : ""}
            {side === "left" ? " (removed line)" : ""}
          </Text>
          {code !== null ? (
            <Text className="font-mono text-xs text-foreground" numberOfLines={3}>
              {code.length > 0 ? code : " "}
            </Text>
          ) : null}
        </View>
        <TextInput
          autoFocus
          value={body}
          onChangeText={setBody}
          multiline
          placeholder="Leave a comment on this line"
          placeholderTextColor={placeholder}
          textAlignVertical="top"
          className="min-h-36 rounded-2xl bg-card px-4 py-3 font-sans text-base"
          style={{ color: text }}
        />
        <Text className="px-1 text-xs text-foreground-muted">
          Line comments wait in your review until you send it from the pull request.
        </Text>
        {target.kind === "edit" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => props.onDelete(target.comment)}
            className="h-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <Text className="text-sm font-ryco-bold text-danger-foreground">Delete comment</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** A draft line comment under its line: the viewer's own, not sent yet. */
export function DraftCommentCard(props: {
  readonly comment: ReviewDraftComment;
  readonly outdated: boolean;
  readonly width: number;
  readonly onPress: (comment: ReviewDraftComment) => void;
}) {
  const icon = useThemeColor("--color-icon-muted") as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Edit or delete this draft comment."
      onPress={() => props.onPress(props.comment)}
      style={{ width: props.width }}
      className="px-3 py-1.5"
    >
      <View className="gap-1 rounded-xl border border-dashed border-border bg-card px-3 py-2.5 active:bg-card-alt">
        <View className="flex-row items-center gap-1.5">
          <SymbolView name="pencil" size={11} tintColor={icon} />
          <Text className="text-2xs font-ryco-bold text-foreground-muted">
            Draft{props.outdated ? " · written on an older commit" : ""}
          </Text>
        </View>
        <Text className="text-sm text-foreground">{props.comment.body}</Text>
      </View>
    </Pressable>
  );
}

/** A published review thread under its line. */
export function ThreadCard(props: {
  readonly thread: ChangeRequestReviewThread;
  readonly width: number;
}) {
  const { thread } = props;
  const [open, setOpen] = useState(!thread.isResolved);
  const shown = open ? thread.comments : thread.comments.slice(0, 0);
  return (
    <View style={{ width: props.width }} className="px-3 py-1.5">
      <View className="gap-2 rounded-xl bg-card px-3 py-2.5">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          className="flex-row items-center gap-2"
        >
          <Text className="min-w-0 flex-1 text-2xs font-ryco-bold text-foreground-muted">
            {thread.comments.length} {thread.comments.length === 1 ? "comment" : "comments"}
            {thread.isResolved ? " · Resolved" : ""}
            {thread.isOutdated ? " · Outdated" : ""}
          </Text>
          <Text className="text-2xs text-primary">{open ? "Hide" : "Show"}</Text>
        </Pressable>
        {shown.map((comment, index) => (
          <View
            key={comment.id}
            className={cn("gap-1", index > 0 && "border-t border-border-subtle pt-2")}
          >
            <ActorLine author={comment.author.login} atMs={epochMillis(comment.createdAt)} />
            <PullRequestMarkdown markdown={comment.body} />
          </View>
        ))}
      </View>
    </View>
  );
}
