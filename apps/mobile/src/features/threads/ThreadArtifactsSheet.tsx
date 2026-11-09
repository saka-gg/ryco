import { deriveThreadArtifacts, type ThreadArtifact } from "@ryco/client-runtime/state/session";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { formatAttachmentBytes } from "@ryco/shared/attachmentPreview";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Share, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  AttachmentPreviewModal,
  canPreviewAttachment,
  type PreviewableAttachment,
} from "./AttachmentPreviewModal";

/**
 * What the agent published in this chat (web's Artifacts panel): pages it rendered and files it
 * attached, newest first, from the loaded messages. A page opens where it sits in the chat; a
 * file opens in place when it can, else in the share sheet.
 */
export function ThreadArtifactsSheet(props: {
  readonly visible: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onShowInThread: (messageId: MessageId) => void;
  readonly onClose: () => void;
}) {
  const [previewing, setPreviewing] = useState<PreviewableAttachment | null>(null);
  const iconColor = useThemeColor("--color-icon") as string;
  const artifacts = props.visible ? deriveThreadArtifacts(props.messages) : [];
  const pages = artifacts.filter((artifact) => artifact.kind === "page");
  const files = artifacts.filter((artifact) => artifact.kind === "file");

  const openFile = (artifact: ThreadArtifact) => {
    const { attachment } = artifact;
    if (!attachment.previewUrl) return;
    if (attachment.type === "file" && canPreviewAttachment(attachment)) {
      setPreviewing({
        environmentId: props.environmentId,
        threadId: props.threadId,
        messageId: artifact.messageId,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.previewUrl,
      });
      return;
    }
    void Share.share({ url: attachment.previewUrl }).catch(() => {});
  };
  const showInThread = (artifact: ThreadArtifact) => {
    props.onClose();
    props.onShowInThread(artifact.messageId);
  };

  const section = (title: string, rows: ReadonlyArray<ThreadArtifact>) =>
    rows.length === 0 ? null : (
      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">
          {title} · {rows.length}
        </Text>
        <View className="overflow-hidden rounded-2xl bg-card">
          {rows.map((artifact, index) => (
            <View
              key={artifact.key}
              className={cn(
                "min-h-14 flex-row items-center gap-3 px-4 py-2.5",
                index === 0 ? "" : "border-t border-border",
              )}
            >
              <SymbolView
                name={artifact.kind === "page" ? "rectangle.on.rectangle" : "doc"}
                size={16}
                tintColor={iconColor}
                type="monochrome"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${artifact.attachment.name}`}
                onPress={() =>
                  artifact.kind === "page" ? showInThread(artifact) : openFile(artifact)
                }
                className="min-w-0 flex-1 active:opacity-60"
              >
                <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={1}>
                  {artifact.kind === "page"
                    ? artifact.htmlRender.title || artifact.attachment.name
                    : artifact.attachment.name}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {artifact.handoff ? "From another chat · " : ""}
                  {formatAttachmentBytes(artifact.attachment.sizeBytes)}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Show in chat"
                hitSlop={6}
                onPress={() => showInThread(artifact)}
                className="h-8 justify-center rounded-full bg-subtle px-3 active:opacity-70"
              >
                <Text className="text-xs font-ryco-medium text-foreground">Show</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </View>
    );

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
        {artifacts.length === 0 ? (
          <View className="gap-1 px-1 pt-6">
            <Text className="text-base font-ryco-bold text-foreground">No artifacts yet</Text>
            <Text className="text-sm text-foreground-muted">
              Pages and files the agent publishes in this chat, like mockups, charts and exports,
              collect here.
            </Text>
          </View>
        ) : null}
        {section("Pages", pages)}
        {section("Files", files)}
      </ScrollView>
      {previewing ? (
        <AttachmentPreviewModal attachment={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
    </Modal>
  );
}
