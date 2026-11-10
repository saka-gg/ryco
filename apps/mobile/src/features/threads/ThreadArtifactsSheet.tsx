import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  canHtmlRenderSendFromMessage,
  deriveThreadArtifacts,
  type ThreadArtifact,
  type ThreadFileArtifact,
  type ThreadPageArtifact,
} from "@ryco/client-runtime/state/session";
import {
  isChatImageAttachment,
  selectThreadLiveDetailLoaded,
  type ChatMessage,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { attachmentPreviewKind, formatAttachmentBytes } from "@ryco/shared/attachmentPreview";
import { htmlRenderThumbnail } from "@ryco/shared/htmlRender";
import { Image as ExpoImage } from "expo-image";
import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  useColorScheme,
  View,
} from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useStore } from "../../state/threadsRuntime";
import {
  AttachmentPreviewModal,
  canPreviewAttachment,
  type PreviewableAttachment,
} from "./AttachmentPreviewModal";
import { ATTACHMENT_FILE_AUTO_LOAD_MAX_BYTES } from "./attachmentFiles";
import { shareAttachment } from "./attachmentShare";
import {
  HTML_RENDER_CARD_THUMBNAIL,
  HTML_RENDER_CARD_THUMBNAIL_BACKGROUND,
} from "./HtmlRenderCards";
import { useHtmlRenderFullScreenModal } from "./HtmlRenderFullScreen";
import { useImageGalleryModal } from "./ImageGalleryModal";
import { galleryImage, type GalleryImage } from "./messageImageGallery";
import { useAttachmentFile } from "./useAttachmentFile";
import {
  useEarlierThreadArtifacts,
  type EarlierThreadArtifacts,
} from "./useEarlierThreadArtifacts";

const NO_ARTIFACT_SOURCES: ReadonlyArray<ChatMessage> = [];

function artifactReference(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  artifact: ThreadFileArtifact,
) {
  return {
    environmentId,
    threadId,
    messageId: artifact.messageId,
    attachmentId: artifact.attachment.id,
    name: artifact.attachment.name,
    sizeBytes: artifact.attachment.sizeBytes,
  };
}

function fileSymbol(artifact: ThreadFileArtifact): AppSymbolName {
  const kind = attachmentPreviewKind(artifact.attachment);
  if (kind === "pdf") return "doc.richtext";
  if (kind === "markdown" || kind === "text") return "doc.text";
  return "doc";
}

/** A box the size of a page card's thumbnail, so every row lines up. */
function RowThumbnail(props: { readonly children: ReactNode; readonly tinted?: string }) {
  return (
    <View
      style={[HTML_RENDER_CARD_THUMBNAIL, props.tinted ? { backgroundColor: props.tinted } : null]}
      className={cn(
        "items-center justify-center overflow-hidden rounded-lg border border-border-subtle",
        props.tinted ? "" : "bg-subtle",
      )}
    >
      {props.children}
    </View>
  );
}

/** An image artifact's own pixels, read over its machine's connection while the sheet shows it. */
function ImageThumbnail(props: { readonly image: GalleryImage; readonly sizeBytes: number }) {
  const iconColor = useThemeColor("--color-icon-muted") as string;
  const file = useAttachmentFile({
    reference: props.image.reference,
    auto: props.sizeBytes <= ATTACHMENT_FILE_AUTO_LOAD_MAX_BYTES,
    uri: props.image.uri,
  });
  return (
    <RowThumbnail>
      {file.status === "ready" ? (
        <Image
          source={{ uri: file.uri }}
          style={HTML_RENDER_CARD_THUMBNAIL}
          resizeMode="cover"
          accessible={false}
        />
      ) : file.status === "loading" ? (
        <ActivityIndicator size="small" />
      ) : (
        <SymbolView name="photo" size={18} tintColor={iconColor} type="monochrome" />
      )}
    </RowThumbnail>
  );
}

function ArtifactRow(props: {
  readonly first: boolean;
  readonly title: string;
  readonly detail: string;
  readonly thumbnail: ReactNode;
  readonly openLabel: string;
  readonly busy?: boolean;
  readonly onOpen: () => void;
  readonly onShowInThread: () => void;
}) {
  return (
    <View
      className={cn(
        "min-h-16 flex-row items-center gap-3 px-3 py-2.5",
        props.first ? "" : "border-t border-border",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.openLabel}
        accessibilityState={{ busy: props.busy === true }}
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-60"
      >
        {props.thumbnail}
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={1}>
            {props.title}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.detail}
          </Text>
        </View>
        {props.busy ? <ActivityIndicator size="small" /> : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show ${props.title} in chat`}
        hitSlop={6}
        onPress={props.onShowInThread}
        className="h-8 justify-center rounded-full bg-subtle px-3 active:opacity-70"
      >
        <Text className="text-xs font-ryco-medium text-foreground">Show</Text>
      </Pressable>
    </View>
  );
}

function Section(props: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <View className="gap-2">
      <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
        {props.title} · {props.count}
      </Text>
      <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>
    </View>
  );
}

function EarlierArtifacts(props: { readonly earlier: EarlierThreadArtifacts }) {
  const { earlier } = props;
  if (earlier.loading) {
    return (
      <View className="flex-row items-center justify-center gap-2 py-2">
        <ActivityIndicator size="small" />
        <Text className="text-sm text-foreground-muted">Looking further back…</Text>
      </View>
    );
  }
  if (!earlier.failed && !earlier.hasMore) return null;
  return (
    <View className="items-center gap-1 py-1">
      {earlier.failed ? (
        <Text className="text-center text-sm text-foreground-muted">
          Unable to look further back in this chat.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={earlier.loadMore}
        className="h-11 justify-center rounded-full px-4 active:bg-subtle"
      >
        <Text className="text-sm font-ryco-medium text-foreground">
          {earlier.failed ? "Retry" : "Show earlier artifacts"}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * What the agent published in this chat (web's Artifacts panel): pages it
 * rendered and files it attached, newest first, from the loaded messages and
 * from further back in the chat. A page opens full screen, an image in the
 * zoomable gallery, a PDF or text file in place, anything else in the share
 * sheet; each can also be shown where it sits in the chat. Every byte is read
 * over the chat's machine's own connection, directly paired or through the Hub.
 */
export function ThreadArtifactsSheet(props: {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onShowInThread: (messageId: MessageId) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props;
  const [previewing, setPreviewing] = useState<PreviewableAttachment | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const iconColor = useThemeColor("--color-icon") as string;
  const appearance = useColorScheme() === "light" ? "light" : "dark";
  // This sheet is its own native modal: full screen and the gallery present from inside it.
  const fullScreen = useHtmlRenderFullScreenModal();
  const gallery = useImageGalleryModal();
  // Messages restored from the device's saved copy carry no attachments, so
  // only a live thread can say what it published.
  const live = useStore((state) =>
    selectThreadLiveDetailLoaded(state, scopeThreadRef(environmentId, threadId)),
  );
  const history = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadHistoryByThreadId?.[threadId]?.messages,
  );
  const earlier = useEarlierThreadArtifacts({
    environmentId,
    threadId,
    startCursor: history?.hasMoreBefore ? history.oldestCursor : null,
    enabled: props.visible && live,
  });
  const messages = props.visible ? props.messages : NO_ARTIFACT_SOURCES;
  const artifacts = useMemo(
    () => deriveThreadArtifacts(messages, earlier.messages),
    [earlier.messages, messages],
  );
  const pages = artifacts.filter(
    (artifact): artifact is ThreadPageArtifact => artifact.kind === "page",
  );
  const files = artifacts.filter(
    (artifact): artifact is ThreadFileArtifact => artifact.kind === "file",
  );
  const images = files.flatMap((artifact) =>
    isChatImageAttachment(artifact.attachment)
      ? [
          {
            key: artifact.key,
            image: galleryImage(
              { environmentId, threadId, messageId: artifact.messageId },
              artifact.attachment,
            ),
          },
        ]
      : [],
  );

  const showInThread = (artifact: ThreadArtifact) => {
    props.onClose();
    props.onShowInThread(artifact.messageId);
  };
  const openPage = (artifact: ThreadPageArtifact) =>
    fullScreen.open({
      environmentId,
      threadId,
      messageId: artifact.messageId,
      attachment: artifact.attachment,
      title: artifact.htmlRender.title,
      // Only a page of this chat's own agent may send; never one handed over.
      canSendMessages:
        artifact.handoff === null &&
        canHtmlRenderSendFromMessage({ role: "assistant" }, artifact.attachment),
    });
  const openFile = (artifact: ThreadFileArtifact) => {
    const { attachment } = artifact;
    if (isChatImageAttachment(attachment)) {
      gallery.open(
        images.map((entry) => entry.image),
        images.findIndex((entry) => entry.key === artifact.key),
      );
      return;
    }
    if (canPreviewAttachment(attachment)) {
      setPreviewing({
        environmentId,
        threadId,
        messageId: artifact.messageId,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      });
      return;
    }
    if (sharing !== null) return;
    setSharing(artifact.key);
    shareAttachment(artifactReference(environmentId, threadId, artifact))
      .catch(() =>
        Alert.alert("Could not share the file", "Ryco could not load it from the machine."),
      )
      .finally(() => setSharing(null));
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <ScrollView
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 40 }}
      >
        <View className="flex-row items-center">
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="h-11 justify-center active:opacity-60"
          >
            <Text className="text-base font-ryco-medium text-foreground">Done</Text>
          </Pressable>
          <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
            Artifacts
          </Text>
          <View className="w-11" />
        </View>
        {!live ? (
          <View className="flex-row items-center gap-2 px-1 pt-6">
            <ActivityIndicator size="small" />
            <Text className="flex-1 text-sm text-foreground-muted">
              Artifacts show once the machine is connected.
            </Text>
          </View>
        ) : artifacts.length === 0 && !earlier.loading ? (
          <View className="gap-1 px-1 pt-6">
            <Text className="text-base font-ryco-bold text-foreground">No artifacts yet</Text>
            <Text className="text-sm text-foreground-muted">
              Pages and files the agent publishes in this chat, like mockups, charts and exports,
              collect here.
            </Text>
          </View>
        ) : null}
        <Section title="Pages" count={pages.length}>
          {pages.map((artifact, index) => {
            const thumbnail = htmlRenderThumbnail(artifact.htmlRender, appearance);
            const title = artifact.htmlRender.title || artifact.attachment.name;
            return (
              <ArtifactRow
                key={artifact.key}
                first={index === 0}
                title={title}
                detail={`${artifact.handoff ? "From another chat · " : ""}Page · ${formatAttachmentBytes(artifact.attachment.sizeBytes)}`}
                openLabel={`Open ${title}`}
                onOpen={() => openPage(artifact)}
                onShowInThread={() => showInThread(artifact)}
                thumbnail={
                  thumbnail === undefined ? (
                    <RowThumbnail>
                      <SymbolView
                        name="macwindow"
                        size={18}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    </RowThumbnail>
                  ) : (
                    <RowThumbnail tinted={HTML_RENDER_CARD_THUMBNAIL_BACKGROUND[appearance]}>
                      <ExpoImage
                        source={{ uri: thumbnail }}
                        style={HTML_RENDER_CARD_THUMBNAIL}
                        contentFit="contain"
                        contentPosition="top left"
                        // Node-owned pixels stay in memory; nothing reaches the disk cache.
                        cachePolicy="none"
                        accessible={false}
                      />
                    </RowThumbnail>
                  )
                }
              />
            );
          })}
        </Section>
        <Section title="Files" count={files.length}>
          {files.map((artifact, index) => {
            const image = images.find((entry) => entry.key === artifact.key)?.image;
            return (
              <ArtifactRow
                key={artifact.key}
                first={index === 0}
                title={artifact.attachment.name}
                detail={`${artifact.handoff ? "From another chat · " : ""}${formatAttachmentBytes(artifact.attachment.sizeBytes)}`}
                openLabel={`Open ${artifact.attachment.name}`}
                busy={sharing === artifact.key}
                onOpen={() => openFile(artifact)}
                onShowInThread={() => showInThread(artifact)}
                thumbnail={
                  image ? (
                    <ImageThumbnail image={image} sizeBytes={artifact.attachment.sizeBytes} />
                  ) : (
                    <RowThumbnail>
                      <SymbolView
                        name={fileSymbol(artifact)}
                        size={18}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    </RowThumbnail>
                  )
                }
              />
            );
          })}
        </Section>
        {live ? <EarlierArtifacts earlier={earlier} /> : null}
      </ScrollView>
      {previewing ? (
        <AttachmentPreviewModal attachment={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
      {fullScreen.modal}
      {gallery.modal}
    </Modal>
  );
}
