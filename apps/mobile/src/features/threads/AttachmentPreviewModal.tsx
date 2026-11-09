import { readAttachmentBytesFromTransport } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "@ryco/shared/attachmentPreview";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Share, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { encodeBytesBase64 } from "../../lib/base64";
import { useThemeColor } from "../../lib/useThemeColor";
import { canPreviewAttachment } from "./attachmentPreviewModel";

export { canPreviewAttachment };
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useNativeMarkdownTextStyle } from "../../native/useNativeMarkdownTextStyle";

export interface PreviewableAttachment {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** The file's URL, for Share. */
  readonly previewUrl: string;
}

type Loaded =
  | { readonly kind: "pdf"; readonly dataUrl: string }
  | { readonly kind: "markdown" | "text"; readonly text: string }
  | { readonly kind: "too-large" }
  | { readonly kind: "failed"; readonly message: string };

/** Reads the attachment over the node's authorized chunk RPC and prepares it for display. */
async function loadPreview(
  attachment: PreviewableAttachment,
  signal: AbortSignal,
): Promise<Loaded> {
  const kind = attachmentPreviewKind(attachment);
  if (kind === null) return { kind: "failed", message: "This file has no preview." };
  if (kind !== "pdf" && attachment.sizeBytes > ATTACHMENT_TEXT_PREVIEW_MAX_BYTES) {
    return { kind: "too-large" };
  }
  try {
    const bytes = await readAttachmentBytesFromTransport({
      reference: {
        threadId: attachment.threadId,
        messageId: attachment.messageId,
        attachmentId: attachment.attachmentId,
      },
      sizeBytes: attachment.sizeBytes,
      signal,
      currentTransport: () => readEnvironmentApi(attachment.environmentId)?.attachments,
    });
    if (kind === "pdf") {
      return { kind, dataUrl: `data:application/pdf;base64,${encodeBytesBase64(bytes)}` };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return { kind: "failed", message: "This file is not text." };
    return { kind, text };
  } catch (cause) {
    return {
      kind: "failed",
      message:
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message
          : "The file could not be loaded.",
    };
  }
}

const PREVIEW_LABEL = { pdf: "PDF", markdown: "Markdown", text: "Text" } as const;

/**
 * A file the agent or the user attached, read in place: a PDF in a web view (from memory, never a
 * URL with the app's credentials), Markdown rendered, any other text as is. Share passes the
 * file on.
 */
export function AttachmentPreviewModal(props: {
  readonly attachment: PreviewableAttachment | null;
  readonly onClose: () => void;
}) {
  const { attachment } = props;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: Loaded } | null>(
    null,
  );
  const markdownStyle = useNativeMarkdownTextStyle();
  const backgroundColor = useThemeColor("--color-screen") as string;
  const key = attachment ? `${attachment.messageId}:${attachment.attachmentId}` : null;

  useEffect(() => {
    if (!attachment || key === null) return;
    const controller = new AbortController();
    void loadPreview(attachment, controller.signal).then((value) => {
      if (!controller.signal.aborted) setLoaded({ key, value });
    });
    return () => controller.abort();
  }, [attachment, key]);

  const value = loaded !== null && loaded.key === key ? loaded.value : null;
  const kind = attachment ? attachmentPreviewKind(attachment) : null;

  return (
    <Modal
      visible={attachment !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center gap-3 px-4 pb-3 pt-5">
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="h-11 justify-center rounded-full px-1 active:opacity-60"
          >
            <Text className="text-base font-ryco-medium text-foreground">Done</Text>
          </Pressable>
          <View className="min-w-0 flex-1 items-center">
            <Text className="text-base font-ryco-bold text-foreground" numberOfLines={1}>
              {attachment?.name ?? ""}
            </Text>
            {attachment && kind ? (
              <Text className="text-xs text-foreground-muted">
                {formatAttachmentBytes(attachment.sizeBytes)} · {PREVIEW_LABEL[kind]} preview
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!attachment}
            onPress={() => {
              if (attachment) void Share.share({ url: attachment.previewUrl }).catch(() => {});
            }}
            className="h-11 justify-center rounded-full px-1 active:opacity-60"
          >
            <Text className="text-base font-ryco-medium text-foreground">Share</Text>
          </Pressable>
        </View>
        {value === null ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : value.kind === "pdf" ? (
          <WebView
            source={{ uri: value.dataUrl }}
            originWhitelist={["data:*"]}
            javaScriptEnabled={false}
            style={{ flex: 1, backgroundColor }}
          />
        ) : value.kind === "markdown" || value.kind === "text" ? (
          <ScrollView className="flex-1" contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
            {value.kind === "markdown" && hasNativeSelectableMarkdownText() ? (
              <SelectableMarkdownText
                markdown={value.text}
                textStyle={markdownStyle}
                preserveSoftBreaks
                marginTop={0}
                marginBottom={0}
              />
            ) : (
              <Text className="font-mono text-xs text-foreground" selectable>
                {value.text}
              </Text>
            )}
          </ScrollView>
        ) : (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-center text-sm text-foreground-muted">
              {value.kind === "failed"
                ? `${value.message} Share it to open it elsewhere.`
                : "Text previews are limited to 512 KB. Share this file to open it."}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
