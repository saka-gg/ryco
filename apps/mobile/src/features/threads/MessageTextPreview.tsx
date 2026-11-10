// What a very long message the thread window sent as its head
// (`ChatMessage.textPreview`) adds to its row: the control that shows the
// whole text. Only such a message renders it, so ordinary rows run none of
// this. The whole text goes into the store (`setWholeMessageText`); the row
// then renders it like any message and this control disappears.
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  loadWholeMessageText,
  MESSAGE_TEXT_PREVIEW_COPY,
} from "@ryco/client-runtime/state/session";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useStore } from "../../state/threadsRuntime";

interface MessageRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly message: Pick<ChatMessage, "id" | "text" | "textPreview">;
}

/** The whole text of a message, read and put into the store first when it is a preview. */
export function readWholeMessageText(input: MessageRef): Promise<string> {
  if (input.message.textPreview === undefined) return Promise.resolve(input.message.text);
  return loadWholeMessageText({
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.message.id,
    read: ensureEnvironmentApi(input.environmentId).orchestration.getMessageText,
    apply: (text) =>
      useStore
        .getState()
        .setWholeMessageText(
          scopeThreadRef(input.environmentId, input.threadId),
          input.message.id,
          text,
        ),
  }).then((result) => result.text);
}

export function MessageTextPreviewControl(props: MessageRef & { readonly fullLength: number }) {
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "too-long">("idle");
  const show = () => {
    setStatus("loading");
    readWholeMessageText(props).then(
      // A whole text replaces the preview in the store, which unmounts this control.
      (text) => setStatus(text.length < props.fullLength ? "too-long" : "idle"),
      () => setStatus("error"),
    );
  };
  if (status === "loading" || status === "too-long") {
    return (
      <Text className="mt-2 text-2xs text-foreground-tertiary">
        {status === "loading"
          ? MESSAGE_TEXT_PREVIEW_COPY.loading
          : MESSAGE_TEXT_PREVIEW_COPY.tooLong}
      </Text>
    );
  }
  if (status === "error") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${MESSAGE_TEXT_PREVIEW_COPY.failed} ${MESSAGE_TEXT_PREVIEW_COPY.retry}`}
        onPress={show}
        className="mt-2 self-start active:opacity-70"
      >
        <Text className="text-2xs text-danger-foreground">
          {MESSAGE_TEXT_PREVIEW_COPY.failed} Tap to retry.
        </Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={show}
      className="mt-2 min-h-7 justify-center self-start active:opacity-70"
    >
      <Text className="text-xs font-ryco-medium text-foreground-muted">
        {MESSAGE_TEXT_PREVIEW_COPY.show(props.fullLength)}
      </Text>
    </Pressable>
  );
}
