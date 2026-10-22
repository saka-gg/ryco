import {
  deriveDisplayedUserMessageContext,
  type FileReference,
  fileReferenceKey,
  formatFileReferenceLabel,
  formatFileReferenceTitle,
  type ParsedTerminalContextEntry,
} from "@ryco/client-runtime/state/composer";
import {
  readHtmlRenderAttachment,
  type HtmlRenderAttachment,
} from "@ryco/client-runtime/state/session";
import {
  isChatImageAttachment,
  THREAD_FORK_COPY,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ChatMessage,
  type ChatUnknownAttachment,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { quoteCitationsToPlainText } from "@ryco/shared/quoteCitations";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEvent } from "expo";
import * as Linking from "expo-linking";
import { useMemo } from "react";
import { Image, Pressable, ScrollView, Share, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { HtmlRenderCards } from "./HtmlRenderCards";
import { ThreadHtmlRender } from "./ThreadHtmlRender";
import type { TurnHtmlRender } from "./threadActivityFold";
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  IMAGE_ATTACHMENT_SLOT_WIDTH,
  isVideoFileAttachment,
  readAttachmentDimensions,
} from "./threadAttachmentModel";
import { threadMessagePresentation } from "./threadPresentation";

const sentTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

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

/**
 * What a sent prompt carried besides its text: lines of workspace files (with
 * the user's note) and terminal output, read back from the blocks the send
 * wrote, the same way web shows them.
 */
function SentMessageContexts(props: {
  readonly fileReferences: ReadonlyArray<FileReference>;
  readonly terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>;
  readonly spaced: boolean;
}) {
  const subtle = String(useThemeColor("--color-icon-subtle"));
  return (
    <View className={`gap-1.5 ${props.spaced ? "mt-2" : ""}`}>
      {props.fileReferences.map((reference) => (
        <View
          key={fileReferenceKey(reference)}
          accessibilityRole="text"
          accessibilityLabel={
            reference.comment
              ? `${formatFileReferenceTitle(reference)}: ${reference.comment}`
              : formatFileReferenceTitle(reference)
          }
          className="gap-0.5"
        >
          <View className="flex-row items-center gap-1 self-start rounded-full border border-border bg-card-translucent px-2 py-1">
            <SymbolView name="doc.text" size={11} tintColor={subtle} type="monochrome" />
            <Text className="text-[11px] font-ryco-medium text-foreground-muted" numberOfLines={1}>
              {formatFileReferenceLabel(reference)}
            </Text>
          </View>
          {reference.comment ? (
            <Text className="pl-1 text-xs text-foreground-muted" numberOfLines={3}>
              {reference.comment}
            </Text>
          ) : null}
        </View>
      ))}
      {props.terminalContexts.map((context) => (
        <View
          key={context.header}
          accessibilityRole="text"
          accessibilityLabel={context.header}
          className="flex-row items-center gap-1 self-start rounded-full border border-border bg-card-translucent px-2 py-1"
        >
          <SymbolView name="terminal" size={11} tintColor={subtle} type="monochrome" />
          <Text className="text-[11px] font-ryco-medium text-foreground-muted" numberOfLines={1}>
            {context.header}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ThreadMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly message: ChatMessage;
  /** On a turn's settled reply: the pages the turn published, listed at its foot. */
  readonly turnHtmlRenders?: ReadonlyArray<TurnHtmlRender> | undefined;
  /**
   * Present only on a reply that can be forked (the terminal reply of a completed turn, on a
   * thread whose node can fork right now). An explicit footer button rather than a long press,
   * which would fight the reply's text selection.
   */
  readonly onForkFromHere?: (() => void) | undefined;
}) {
  const isUser = props.message.role === "user";
  const sentAt = isUser ? Date.parse(props.message.createdAt) : Number.NaN;
  const sentLabel = Number.isFinite(sentAt) ? sentTimeFormatter.format(sentAt) : null;
  const presentation = threadMessagePresentation(isUser ? "user" : "assistant");
  const bodyText = useScaledTextRole("body");
  const typography = resolveNativeMarkdownTypography(bodyText.fontSize);
  const regularFont = useFontFamily("regular");
  const boldFont = useFontFamily("bold");
  const bodyColor = useThemeColor("--color-md-body");
  const strongColor = useThemeColor("--color-md-strong");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const metadataColor = useThemeColor("--color-foreground-tertiary");
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
  // A sent prompt's context blocks show as chips, not as raw text, and its
  // quotes read as plain quoted lines; copying keeps the text as sent.
  const sentContexts = isUser ? deriveDisplayedUserMessageContext(props.message.text) : null;
  const sentContextCount =
    (sentContexts?.fileReferences.length ?? 0) + (sentContexts?.contexts.length ?? 0);
  const text =
    (sentContexts ? quoteCitationsToPlainText(sentContexts.visibleText) : props.message.text) ||
    (props.message.streaming ? "…" : "");
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
  // An agent's HTML render shows as the page itself. Only assistant messages
  // carry them; on any other message the file keeps its ordinary row. The
  // metadata is validated once per message rather than on each re-render:
  // its thumbnails can run to tens of kilobytes, and the feed re-renders its
  // rows as a reply streams.
  const htmlRenders = useMemo<ReadonlyArray<HtmlRenderAttachment>>(
    () =>
      isUser
        ? []
        : (props.message.attachments ?? []).flatMap((attachment) => {
            const render = readHtmlRenderAttachment(attachment);
            return render === undefined ? [] : [render];
          }),
    [isUser, props.message.attachments],
  );
  const htmlRenderFiles = new Set<unknown>(htmlRenders.map((render) => render.attachment));
  const stripAttachments = attachments.filter(
    (attachment) =>
      !hasVideoPlaybackSource(attachment) &&
      !hasAudioPlaybackSource(attachment) &&
      !htmlRenderFiles.has(attachment),
  );
  // Attachment deliveries carry a placeholder " " body, which would render as
  // a blank line above the attachment.
  const showText = text.trim().length > 0 || (attachments.length === 0 && sentContextCount === 0);

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
        {!showText ? null : isUser || !hasNativeSelectableMarkdownText() ? (
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
        {sentContexts && sentContextCount > 0 ? (
          <SentMessageContexts
            fileReferences={sentContexts.fileReferences}
            terminalContexts={sentContexts.contexts}
            spaced={showText}
          />
        ) : null}
        {htmlRenders.length > 0 ? (
          <View className={`w-full gap-2 ${showText ? "mt-2" : ""}`}>
            {htmlRenders.map(({ attachment, htmlRender }) => (
              <ThreadHtmlRender
                key={attachment.id}
                environmentId={props.environmentId}
                threadId={props.threadId}
                messageId={props.message.id}
                attachment={attachment}
                htmlRender={htmlRender}
              />
            ))}
          </View>
        ) : null}
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
        {!isUser && props.turnHtmlRenders !== undefined && props.turnHtmlRenders.length > 0 ? (
          <HtmlRenderCards
            environmentId={props.environmentId}
            threadId={props.threadId}
            renders={props.turnHtmlRenders}
          />
        ) : null}
      </View>
      {isUser ? (
        <View className="mt-1 max-w-[88%] flex-row items-center gap-1 pr-1">
          {sentLabel ? (
            <Text
              accessibilityLabel={`Sent ${sentLabel}`}
              className="shrink text-2xs text-foreground-tertiary"
            >
              {sentLabel}
            </Text>
          ) : null}
          {props.message.text ? (
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={props.message.text}
              tintColor={metadataColor}
              iconSize={12}
              buttonSize={28}
            />
          ) : null}
        </View>
      ) : props.message.role === "assistant" && props.onForkFromHere ? (
        <View className="mt-1 flex-row items-center pl-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={THREAD_FORK_COPY.action}
            hitSlop={8}
            onPress={props.onForkFromHere}
            className="h-7 flex-row items-center gap-1 rounded-full px-2 active:bg-subtle"
          >
            <SymbolView
              name="arrow.triangle.branch"
              size={12}
              tintColor={metadataColor}
              type="monochrome"
            />
            <Text className="text-2xs font-ryco-medium text-foreground-tertiary">
              {THREAD_FORK_COPY.action}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
