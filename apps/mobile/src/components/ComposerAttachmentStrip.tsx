import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import type { ChatFileUploadRecord } from "../state/composerFileUpload";
import { isDraftComposerFileAttachment } from "../lib/composerFiles";
import type { DraftComposerAttachment } from "../lib/composerFiles";

export interface ComposerAttachmentStripProps {
  /** Composer attachments to display: image thumbnails and streamed file rows. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Live upload records keyed by attachment id (engine state for file rows). */
  readonly fileUploadRecords?: ReadonlyMap<string, ChatFileUploadRecord>;
  /** Called when the user taps the remove button on an attachment. */
  readonly onRemove: (attachmentId: string) => void;
  /** Called when the user taps "Retry" on a failed file upload. */
  readonly onRetryFileUpload?: (attachmentId: string) => void;
  /** Called when the user taps "Attach again" on a needsReattach file row. */
  readonly onReattachFile?: (attachmentId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

function formatComposerFileBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${Math.round(sizeBytes / 1024)} KB`;
  }
  return `${sizeBytes} B`;
}

/**
 * A horizontally-scrollable strip of composer attachments: image thumbnails
 * with remove buttons, and file rows carrying name/size plus live upload
 * progress, retry, and attach-again states (mirroring the web composer).
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) =>
          isDraftComposerFileAttachment(attachment) ? (
            <ComposerFileAttachmentRow
              key={attachment.id}
              attachment={attachment}
              status={props.fileUploadRecords?.get(attachment.id)?.status}
              onRemove={props.onRemove}
              onRetry={props.onRetryFileUpload}
              onReattach={props.onReattachFile}
            />
          ) : (
            <View
              key={attachment.id}
              className="relative"
              style={{
                paddingTop: removeButtonGutter,
                paddingRight: removeButtonGutter,
              }}
            >
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(attachment.previewUri) : undefined
                }
              >
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                  resizeMode="cover"
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name}`}
                className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
                style={{
                  top: removeButtonPlacement === "gutter" ? 0 : 4,
                  right: removeButtonPlacement === "gutter" ? 0 : 4,
                }}
                hitSlop={6}
                onPress={() => props.onRemove(attachment.id)}
              >
                <SymbolView
                  name="xmark"
                  size={9}
                  tintColor="#ffffff"
                  type="monochrome"
                  weight="bold"
                />
              </Pressable>
            </View>
          ),
        )}
      </View>
    </ScrollView>
  );
}

function ComposerFileAttachmentRow(props: {
  readonly attachment: Extract<DraftComposerAttachment, { type: "file" }>;
  readonly status: ChatFileUploadRecord["status"] | undefined;
  readonly onRemove: (attachmentId: string) => void;
  readonly onRetry?: (attachmentId: string) => void;
  readonly onReattach?: (attachmentId: string) => void;
}) {
  const mutedColor = useThemeColor("--color-foreground-muted");

  const status = props.status;
  const needsReattach =
    status === undefined
      ? props.attachment.readUri.length === 0 &&
        !(
          props.attachment.uploadToken !== undefined &&
          props.attachment.expiresAt !== undefined &&
          Date.now() < Date.parse(props.attachment.expiresAt) - 30_000
        )
      : status.kind === "needsReattach";
  const isUploading = status?.kind === "uploading" || status?.kind === "pending";
  const isUploaded = status?.kind === "uploaded";
  const progress = status?.kind === "uploading" ? status.progress : null;

  return (
    <View className="relative" style={{ paddingTop: 10, paddingRight: 10 }}>
      <View className="h-14 min-w-44 max-w-56 justify-center rounded-2xl bg-subtle px-3 py-2">
        <View className="flex-row items-center gap-1.5">
          <SymbolView name="doc" size={14} tintColor={mutedColor as string} type="monochrome" />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs font-ryco-medium text-foreground">
              {props.attachment.name}
            </Text>
            {needsReattach ? (
              <View className="flex-row items-center gap-1">
                <Text className="text-2xs text-warning" numberOfLines={1}>
                  Attach again to send
                </Text>
                {props.onReattach ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Attach ${props.attachment.name} again`}
                    hitSlop={4}
                    onPress={() => props.onReattach!(props.attachment.id)}
                  >
                    <Text className="text-2xs font-ryco-medium text-warning underline">
                      Attach again
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : status?.kind === "failed" ? (
              <View className="flex-row items-center gap-1">
                <Text
                  className="min-w-0 flex-1 text-2xs text-danger-foreground"
                  numberOfLines={1}
                  accessibilityLabel={status.message}
                >
                  {status.label ?? "Upload failed"}
                </Text>
                {props.onRetry ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Retry uploading ${props.attachment.name}`}
                    hitSlop={4}
                    onPress={() => props.onRetry!(props.attachment.id)}
                  >
                    <Text className="text-2xs font-ryco-medium text-danger-foreground underline">
                      Retry
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : isUploading ? (
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                Uploading{progress !== null ? ` ${Math.round(progress * 100)}%` : "…"}
              </Text>
            ) : (
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                {formatComposerFileBytes(props.attachment.sizeBytes)}
                {isUploaded ? " · Uploaded" : ""}
              </Text>
            )}
          </View>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${props.attachment.name}`}
        className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
        style={{ top: 0, right: 0 }}
        hitSlop={6}
        onPress={() => props.onRemove(props.attachment.id)}
      >
        <SymbolView name="xmark" size={9} tintColor="#ffffff" type="monochrome" weight="bold" />
      </Pressable>
    </View>
  );
}
