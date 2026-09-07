import {
  isChatImageAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ChatMessage,
  type ChatUnknownAttachment,
} from "@ryco/client-runtime/state/threads";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEvent } from "expo";
import * as Linking from "expo-linking";
import { Image, Pressable, ScrollView, Share, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  IMAGE_ATTACHMENT_SLOT_WIDTH,
  isVideoFileAttachment,
  readAttachmentDimensions,
} from "./threadAttachmentModel";
import { threadMessagePresentation } from "./threadPresentation";

function isChatFileAttachment(
  attachment: ChatFileAttachment | ChatImageAttachment | ChatUnknownAttachment,
): attachment is ChatFileAttachment {
  return attachment.type === "file";
}

async function shareAttachmentFile(previewUrl: string): Promise<void> {
  try {
    await Share.share({ url: previewUrl });
  } catch {
    // The user dismissed the share sheet; nothing to report.
  }
}

function ImageAttachment(props: {
  readonly attachment: ChatImageAttachment;
  readonly previewUrl: string;
}) {
  const dimensions = readAttachmentDimensions(props.attachment);
  return (
    <Image
      source={{ uri: props.previewUrl }}
      style={
        dimensions
          ? {
              width: IMAGE_ATTACHMENT_SLOT_WIDTH,
              aspectRatio: dimensions.width / dimensions.height,
            }
          : undefined
      }
      className={dimensions ? "rounded-2xl bg-subtle" : "h-36 w-36 rounded-2xl bg-subtle"}
      resizeMode="cover"
      accessibilityLabel={props.attachment.name}
    />
  );
}

function VideoAttachmentRow(props: { readonly attachment: ChatFileAttachment }) {
  const dimensions = readAttachmentDimensions(props.attachment);
  const aspectRatio = dimensions
    ? dimensions.width / dimensions.height
    : DEFAULT_MEDIA_ASPECT_RATIO;
  const player = useVideoPlayer({ uri: props.attachment.previewUrl });
  return (
    <View className="w-full rounded-2xl bg-subtle">
      <View style={{ aspectRatio }} className="overflow-hidden rounded-2xl">
        <VideoView
          player={player}
          style={{ width: "100%", height: "100%" }}
          contentFit="contain"
          nativeControls
          accessibilityLabel={props.attachment.name}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${props.attachment.name}`}
        onPress={() => void shareAttachmentFile(props.attachment.previewUrl!)}
        className="flex-row items-center justify-between px-3 py-2"
      >
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.attachment.mimeType} · {Math.ceil(props.attachment.sizeBytes / 1024)} KB
        </Text>
        <Text className="font-ryco-bold text-xs text-foreground">Share</Text>
      </Pressable>
    </View>
  );
}

function AudioAttachmentRow({ attachment }: { readonly attachment: ChatFileAttachment }) {
  const player = useVideoPlayer({ uri: attachment.previewUrl }, (player) => {
    player.timeUpdateEventInterval = 0.5;
  });
  const playing = useEvent(player, "playingChange");
  const progress = useEvent(player, "timeUpdate");
  const status = useEvent(player, "statusChange");
  const isPlaying = playing?.isPlaying ?? player.playing;
  const seconds = Math.floor(progress?.currentTime ?? 0);
  return (
    <View className="w-full gap-2 rounded-2xl bg-subtle px-3 py-3">
      <Text className="font-ryco-bold text-sm text-foreground">{attachment.name}</Text>
      {status?.status === "error" ? (
        <Text className="text-xs text-foreground-muted">
          Audio could not be played. Use Share to open it in another app.
        </Text>
      ) : (
        <View className="flex-row items-center gap-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? "Pause audio" : "Play audio"}
            onPress={() => {
              if (isPlaying) player.pause();
              else {
                if (player.duration > 0 && player.currentTime >= player.duration)
                  player.currentTime = 0;
                player.play();
              }
            }}
            className="min-h-11 justify-center px-2"
          >
            <Text className="font-ryco-bold text-sm text-foreground">
              {isPlaying ? "Pause" : "Play"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rewind 15 seconds"
            onPress={() => {
              player.currentTime = Math.max(0, player.currentTime - 15);
            }}
            className="min-h-11 justify-center px-2"
          >
            <Text className="text-sm text-foreground">−15s</Text>
          </Pressable>
          <Text className="text-xs text-foreground-muted">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Share ${attachment.name}`}
        onPress={() => void shareAttachmentFile(attachment.previewUrl!)}
        className="min-h-11 justify-center"
      >
        <Text className="text-xs text-foreground-muted">Share audio</Text>
      </Pressable>
    </View>
  );
}

export function ThreadMessage(props: { readonly message: ChatMessage }) {
  const isUser = props.message.role === "user";
  const presentation = threadMessagePresentation(isUser ? "user" : "assistant");
  const bodyText = useScaledTextRole("body");
  const typography = resolveNativeMarkdownTypography(bodyText.fontSize);
  const regularFont = useFontFamily("regular");
  const boldFont = useFontFamily("bold");
  const bodyColor = useThemeColor("--color-md-body");
  const strongColor = useThemeColor("--color-md-strong");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const linkColor = useThemeColor("--color-md-link");
  const codeColor = useThemeColor("--color-md-code-text");
  const codeBackground = useThemeColor("--color-md-code-bg");
  const codeBlockBackground = useThemeColor("--color-card-alt");
  const fileTextColor = useThemeColor("--color-md-link");
  const skillTextColor = useThemeColor("--color-inline-skill-foreground");
  const quoteMarkerColor = useThemeColor("--color-md-blockquote-border");
  const dividerColor = useThemeColor("--color-md-hr");
  const markdownStyle: NativeMarkdownTextStyle = {
    color: String(bodyColor),
    strongColor: String(strongColor),
    mutedColor: String(mutedColor),
    linkColor: String(linkColor),
    inlineCodeColor: String(codeColor),
    codeColor: String(codeColor),
    codeBackgroundColor: String(codeBackground),
    codeBlockBackgroundColor: String(codeBlockBackground),
    fileTextColor: String(fileTextColor),
    skillTextColor: String(skillTextColor),
    quoteMarkerColor: String(quoteMarkerColor),
    dividerColor: String(dividerColor),
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    fontFamily: regularFont,
    headingFontFamily: boldFont,
    boldFontFamily: boldFont,
    headingFontSizes: typography.headingFontSizes,
  };
  const text = props.message.text || (props.message.streaming ? "…" : "");
  const attachments = props.message.attachments ?? [];
  const hasVideoPlaybackSource = (
    attachment: ChatFileAttachment | ChatImageAttachment | ChatUnknownAttachment,
  ): attachment is ChatFileAttachment =>
    isVideoFileAttachment(attachment) && attachment.previewUrl !== undefined;
  const videoAttachments = attachments.filter(hasVideoPlaybackSource);
  const hasAudioPlaybackSource = (
    attachment: ChatFileAttachment | ChatImageAttachment | ChatUnknownAttachment,
  ): attachment is ChatFileAttachment =>
    isChatFileAttachment(attachment) &&
    attachment.mimeType.toLowerCase().startsWith("audio/") &&
    attachment.previewUrl !== undefined;
  const audioAttachments = attachments.filter(hasAudioPlaybackSource);
  const stripAttachments = attachments.filter(
    (attachment) => !hasVideoPlaybackSource(attachment) && !hasAudioPlaybackSource(attachment),
  );

  return (
    <View className={`px-4 py-2 ${isUser ? "items-end" : "items-start"}`}>
      <View
        className={
          isUser
            ? `max-w-[88%] rounded-[20px] px-4 py-3 ${presentation.bubbleClassName}`
            : "w-full px-1 py-1"
        }
      >
        {isUser && props.message.dispatchMode === "steer" ? (
          <Text className="mb-1 text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            Steered
          </Text>
        ) : null}
        {isUser || !hasNativeSelectableMarkdownText() ? (
          <Text
            selectable
            className={`font-sans text-base leading-normal ${presentation.textClassName}`}
          >
            {text}
          </Text>
        ) : (
          <SelectableMarkdownText
            markdown={text}
            textStyle={markdownStyle}
            preserveSoftBreaks
            marginTop={0}
            marginBottom={0}
            onLinkPress={(href) => {
              void Linking.openURL(href).catch(() => undefined);
            }}
          />
        )}
        {audioAttachments.length > 0 ? (
          <View className="mt-2 w-full gap-2">
            {audioAttachments.map((attachment) => (
              <AudioAttachmentRow key={attachment.id} attachment={attachment} />
            ))}
          </View>
        ) : null}
        {videoAttachments.length > 0 ? (
          <View className="mt-2 w-full gap-2">
            {videoAttachments.map((attachment) => (
              <VideoAttachmentRow key={attachment.id} attachment={attachment} />
            ))}
          </View>
        ) : null}
        {stripAttachments.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-2 grow-0">
            <View className="flex-row gap-2">
              {stripAttachments.map((attachment) =>
                isChatImageAttachment(attachment) && attachment.previewUrl ? (
                  <ImageAttachment
                    key={attachment.id}
                    attachment={attachment}
                    previewUrl={attachment.previewUrl}
                  />
                ) : isChatFileAttachment(attachment) && attachment.previewUrl ? (
                  <Pressable
                    key={attachment.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${attachment.name}`}
                    onPress={() => void shareAttachmentFile(attachment.previewUrl!)}
                    className="min-h-20 w-44 justify-center rounded-2xl bg-subtle px-3 py-2"
                  >
                    <Text className="font-ryco-bold text-sm text-foreground" numberOfLines={2}>
                      {attachment.name}
                    </Text>
                    <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
                      {attachment.mimeType} · {Math.ceil(attachment.sizeBytes / 1024)} KB · Tap to
                      open
                    </Text>
                  </Pressable>
                ) : (
                  <View
                    key={attachment.id ?? attachment.type}
                    className="min-h-20 w-44 justify-center rounded-2xl bg-subtle px-3 py-2"
                  >
                    <Text className="font-ryco-bold text-sm text-foreground" numberOfLines={2}>
                      {attachment.name ?? attachment.type}
                    </Text>
                    <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
                      {attachment.mimeType ?? "file"} ·{" "}
                      {attachment.sizeBytes !== undefined
                        ? Math.ceil(attachment.sizeBytes / 1024)
                        : 0}{" "}
                      KB
                    </Text>
                  </View>
                ),
              )}
            </View>
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}
