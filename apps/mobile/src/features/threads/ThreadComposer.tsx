import { VoiceInput } from "../../voice/VoiceInput";
import type { EnvironmentId } from "@ryco/contracts";
import { useRef, useState } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import type { ModelSelection, RuntimeMode, ProviderInteractionMode } from "@ryco/contracts";
import type { ModelPickerModel } from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";
import { ComposerModelMenu } from "./ComposerModelMenu";
import { ComposerAccessMenu } from "./ComposerAccessMenu";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerToolbarButton, ComposerToolbarRow } from "../../components/ComposerToolbarTrigger";
import { GlassSurface } from "../../components/GlassSurface";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerAttachment } from "../../lib/composerFiles";
import type { ChatFileUploadRecord } from "../../state/composerFileUpload";
import { useThemeColor } from "../../lib/useThemeColor";
import { ComposerEditor, type ComposerEditorHandle } from "../../native/ComposerEditor";
import type { PendingContextHandoffPresentation } from "./contextHandoffModel";
import { PendingContextHandoffChip } from "./PendingContextHandoffChip";

// Floating glass composer capsule (§3.5.2, §5). It uses the shared native
// ComposerEditor so mentions/skills, hardware-keyboard submit, and pasted images
// behave like the desktop composer while preserving a compact phone footprint.
// Attachment state (images + streamed files) lives in the owning screen, which
// knows the environment/thread context the upload engine needs.
export function ThreadComposer(props: {
  readonly voiceEnvironmentId?: EnvironmentId;
  readonly voiceDraftKey?: string;
  // Returns false when the send failed (offline/error) so the composer keeps the
  // user's text; enqueue/dispatch success returns true (or void) and clears it.
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
  ) => boolean | void | Promise<boolean | void>;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onPickAttachments: () => void | Promise<void>;
  readonly onPasteImages: (uris: ReadonlyArray<string>) => void | Promise<void>;
  readonly onRetryFileUpload?: (attachmentId: string) => void;
  readonly onReattachFile?: (attachmentId: string) => void;
  readonly attachmentError?: string | null;
  readonly sendBlock?: string | null;
  readonly fileUploadRecords?: ReadonlyMap<string, ChatFileUploadRecord>;
  readonly disabled?: boolean;
  readonly policyModel?: SessionPolicyModel | null;
  readonly policyDisabled?: boolean;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly modelPicker?: ModelPickerModel | null;
  readonly modelSelection?: ModelSelection | null;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onOpenSideChat?: () => void;
  readonly pendingContextHandoff?: PendingContextHandoffPresentation | null;
}) {
  const policyModel = props.policyModel;
  const modelPicker = props.modelPicker;
  const editorRef = useRef<ComposerEditorHandle>(null);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const restoreFocus = () => {
    if (keyboardVisible) editorRef.current?.focus();
  };
  const safeAreaInsets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const primaryFg = useThemeColor("--color-primary-foreground");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const iconColor = useThemeColor("--color-icon");
  const accessColor = useThemeColor("--color-access-caution");
  const warningColor = useThemeColor("--color-warning");

  const visibleAttachmentError = props.attachmentError ?? props.sendBlock;
  const canSend =
    (text.trim().length > 0 || props.attachments.length > 0) &&
    !sending &&
    !props.disabled &&
    !props.sendBlock;

  const send = async () => {
    if (!canSend) return;
    const value = text;
    setSending(true);
    try {
      const result = await props.onSend(value, props.attachments);
      // Keep the complete draft on an explicit failure; clear on success/enqueue.
      if (result !== false) {
        setText("");
      }
    } finally {
      setSending(false);
    }
  };

  const pasteImages = async (uris: ReadonlyArray<string>) => {
    await props.onPasteImages(uris);
  };

  return (
    <View className="px-4 pt-1" style={{ paddingBottom: Math.max(8, safeAreaInsets.bottom) }}>
      {props.voiceEnvironmentId && (
        <VoiceInput
          draftKey={props.voiceDraftKey ?? "thread"}
          environmentId={props.voiceEnvironmentId}
          disabled={props.disabled || sending}
          onInsert={(value) => setText((current) => `${current}${current ? "\n" : ""}${value}`)}
        />
      )}
      {visibleAttachmentError ? (
        <Text className="px-3 pb-1.5 text-xs font-ryco-medium text-danger-foreground">
          {visibleAttachmentError}
        </Text>
      ) : null}
      {props.pendingContextHandoff ? (
        <PendingContextHandoffChip {...props.pendingContextHandoff} />
      ) : null}
      <GlassSurface
        radius={26}
        glassEffectStyle="regular"
        style={{ paddingHorizontal: 6, paddingVertical: 6 }}
      >
        <View className="gap-1">
          {policyModel ? (
            <ComposerToolbarRow paddingTop={2} paddingBottom={2} paddingHorizontal={2}>
              {modelPicker && props.modelSelection ? (
                <ComposerModelMenu
                  model={modelPicker}
                  selection={props.modelSelection}
                  disabled={props.policyDisabled ?? false}
                  onSelect={props.onSelectModel}
                  onClose={restoreFocus}
                >
                  {(open) => (
                    <ComposerToolbarButton
                      iconNode={
                        <ProviderIcon provider={modelPicker.pillProviderDriver} size={14} />
                      }
                      label={modelPicker.pillLabel}
                      suffixLabel={modelPicker.pillReasoningLabel ?? undefined}
                      suffixIcon={modelPicker.pillFastEnabled ? "bolt.fill" : undefined}
                      suffixIconColor={warningColor as string}
                      accessibilityLabel={
                        modelPicker.pillAccessibilityLabel ?? modelPicker.pillLabel
                      }
                      disabled={props.policyDisabled}
                      onPress={open}
                      className="max-w-full flex-1"
                    />
                  )}
                </ComposerModelMenu>
              ) : null}
              {props.onOpenSideChat ? (
                <ComposerToolbarButton
                  icon="bubble.left.and.bubble.right"
                  accessibilityLabel="Open side chat"
                  showChevron={false}
                  onPress={props.onOpenSideChat}
                />
              ) : null}
              <ComposerAccessMenu
                model={policyModel}
                disabled={props.policyDisabled ?? false}
                onSelectRuntimeMode={props.onSelectRuntimeMode}
                onSelectInteractionMode={props.onSelectInteractionMode}
                onClose={restoreFocus}
              >
                {(open) => (
                  <ComposerToolbarButton
                    iconNode={
                      <SymbolView
                        name={policyModel.pillIcon ?? "lock"}
                        size={16}
                        tintColor={
                          (policyModel.pillTone === "caution" ? accessColor : iconColor) as string
                        }
                        type="monochrome"
                      />
                    }
                    accessibilityLabel={policyModel.pillAccessibilityLabel}
                    active={policyModel.pillTone === "caution"}
                    disabled={props.policyDisabled}
                    showChevron={false}
                    onPress={open}
                  />
                )}
              </ComposerAccessMenu>
            </ComposerToolbarRow>
          ) : null}
          <View className="px-2">
            <ComposerAttachmentStrip
              attachments={props.attachments}
              fileUploadRecords={props.fileUploadRecords}
              imageSize={58}
              imageBorderRadius={13}
              onRemove={props.onRemoveAttachment}
              onRetryFileUpload={props.onRetryFileUpload}
              onReattachFile={props.onReattachFile}
            />
          </View>
          <View className="flex-row items-end gap-1">
            <Pressable
              disabled={sending || props.disabled}
              onPress={() => void props.onPickAttachments()}
              accessibilityRole="button"
              accessibilityLabel="Attach files"
              className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong disabled:opacity-40"
            >
              <SymbolView
                name="paperclip"
                size={18}
                tintColor={iconColor as string}
                type="monochrome"
              />
            </Pressable>
            <ComposerEditor
              ref={editorRef}
              value={text}
              onChangeText={setText}
              placeholder="Message"
              multiline
              editable={!props.disabled && !sending}
              contentInsetVertical={10}
              style={{ minHeight: 44, maxHeight: 128, flex: 1 }}
              onPasteImages={(uris) => void pasteImages(uris)}
              onSubmit={() => void send()}
            />
            <Pressable
              disabled={!canSend}
              onPress={() => void send()}
              accessibilityRole="button"
              accessibilityLabel="Send"
              className="h-11 w-11 items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-40"
            >
              <SymbolView
                name="arrow.up"
                size={18}
                tintColor={(canSend ? primaryFg : iconSubtle) as string}
                type="monochrome"
              />
            </Pressable>
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}
