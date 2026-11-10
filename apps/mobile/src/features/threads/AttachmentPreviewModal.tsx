import { readAttachmentBytesFromTransport } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import {
  ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  attachmentPreviewKind,
  formatAttachmentBytes,
} from "@ryco/shared/attachmentPreview";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import { canPreviewAttachment as canPreviewAttachmentOn } from "./attachmentPreviewModel";
import { shareAttachment } from "./attachmentShare";

/**
 * Only iOS's web view renders PDFs; Android's has no PDF viewer and would show a blank sheet, so a
 * PDF there goes to the share sheet.
 */
const PDF_PREVIEW_SUPPORTED = Platform.OS === "ios";

/** Whether a file attachment opens in place here rather than in the share sheet. */
export function canPreviewAttachment(
  attachment: Parameters<typeof canPreviewAttachmentOn>[0],
): boolean {
  return canPreviewAttachmentOn(attachment, { pdf: PDF_PREVIEW_SUPPORTED });
}

/**
 * The cache folder holding the PDF the web view reads. Node-owned content, so it lives only while
 * the preview is open: deleted when it closes, and a copy a crash left behind is cleared by the
 * next preview.
 */
const PDF_PREVIEW_DIRECTORY = "attachment-preview";

function clearPdfPreviewFiles(): void {
  try {
    const directory = new Directory(Paths.cache, PDF_PREVIEW_DIRECTORY);
    if (directory.exists) directory.delete();
  } catch {
    // The next preview clears it.
  }
}

/** Writes the PDF to the cache folder (the bytes once, no base64 copies) and returns its URL. */
function writePdfPreviewFile(attachmentId: string, bytes: Uint8Array): string {
  clearPdfPreviewFiles();
  const directory = new Directory(Paths.cache, PDF_PREVIEW_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `${attachmentId.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`);
  file.write(bytes);
  return file.uri;
}
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
}

type Loaded =
  | { readonly kind: "pdf"; readonly uri: string; readonly directoryUri: string }
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
      if (signal.aborted) return { kind: "failed", message: "The preview was closed." };
      return {
        kind,
        uri: writePdfPreviewFile(attachment.attachmentId, bytes),
        directoryUri: new Directory(Paths.cache, PDF_PREVIEW_DIRECTORY).uri,
      };
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
      if (controller.signal.aborted) {
        if (value.kind === "pdf") clearPdfPreviewFiles();
        return;
      }
      setLoaded({ key, value });
    });
    return () => {
      controller.abort();
      clearPdfPreviewFiles();
    };
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
              if (!attachment) return;
              void shareAttachment({
                environmentId: attachment.environmentId,
                threadId: attachment.threadId,
                messageId: attachment.messageId,
                attachmentId: attachment.attachmentId,
                name: attachment.name,
                sizeBytes: attachment.sizeBytes,
              }).catch(() =>
                Alert.alert("Could not share the file", "Ryco could not load it from the machine."),
              );
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
            source={{ uri: value.uri }}
            originWhitelist={["file://*"]}
            allowingReadAccessToURL={value.directoryUri}
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
