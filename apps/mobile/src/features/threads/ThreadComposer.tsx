import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import type { ModelSelection, RuntimeMode, ProviderInteractionMode } from "@ryco/contracts";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import { resolveModelPillFastMode, type ModelPickerModel } from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";
import { ComposerModelMenu } from "./ComposerModelMenu";
import { ComposerAccessMenu } from "./ComposerAccessMenu";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ComposerToolbarButton, ComposerToolbarRow } from "../../components/ComposerToolbarTrigger";
import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { GlassSurface } from "../../components/GlassSurface";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ComposerAttachMenu } from "../../components/ComposerAttachMenu";
import type { ComposerAttachmentSource, DraftComposerAttachment } from "../../lib/composerFiles";
import type { ChatFileUploadRecord } from "../../state/composerFileUpload";
import { runWhileBusy } from "../../lib/runWhileBusy";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../native/ComposerEditor";
import type { PendingComposerHandoff } from "./contextHandoffModel";
import { PendingContextHandoffChip, PendingForkHandoffChip } from "./PendingContextHandoffChip";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import {
  ComposerDictationBar,
  ComposerDictationButton,
  ComposerDictationError,
} from "../dictation/ComposerDictationControls";
import { useComposerDictation } from "../dictation/useComposerDictation";
import type { ComposerCommandAction } from "./composerCommandMenuModel";
import { useComposerCommandMenu, type ComposerCommandMenuContext } from "./useComposerCommandMenu";

// Floating glass composer capsule (§3.5.2, §5). It uses the shared native
// ComposerEditor so mentions/skills, hardware-keyboard submit, and pasted images
// behave like the desktop composer while preserving a compact phone footprint.
// Attachment state (images + streamed files) lives in the owning screen, which
// knows the environment/thread context the upload engine needs.
export interface ThreadComposerHandle {
  /** The composer holds typed text (attachments live in the owning screen). */
  readonly hasText: () => boolean;
  readonly getText: () => string;
  /** Replaces the typed text, e.g. with a queued message pulled back for editing. */
  readonly setText: (text: string) => void;
  readonly focus: () => void;
}

export function ThreadComposer(props: {
  readonly ref?: Ref<ThreadComposerHandle>;
  // Returns false when the send failed (offline/error) so the composer keeps the
  // user's text; enqueue/dispatch success returns true (or void) and clears it.
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<DraftComposerAttachment>,
  ) => boolean | void | Promise<boolean | void>;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly onRemoveAttachment: (attachmentId: string) => void;
  readonly onPickAttachments: (source: ComposerAttachmentSource) => void | Promise<void>;
  readonly onPasteImages: (uris: ReadonlyArray<string>) => void | Promise<void>;
  readonly onRetryFileUpload?: (attachmentId: string) => void;
  readonly onReattachFile?: (attachmentId: string) => void;
  readonly attachmentError?: string | null;
  readonly sendBlock?: string | null;
  readonly fileUploadRecords?: ReadonlyMap<string, ChatFileUploadRecord>;
  readonly disabled?: boolean;
  /** Replaces the "Message" placeholder, e.g. while a send would redirect a waiting approval. */
  readonly placeholder?: string;
  readonly policyModel?: SessionPolicyModel | null;
  readonly policyDisabled?: boolean;
  readonly onSelectRuntimeMode: (mode: RuntimeMode) => void;
  readonly onSelectInteractionMode: (mode: ProviderInteractionMode) => void;
  readonly modelPicker?: ModelPickerModel | null;
  readonly modelSelection?: ModelSelection | null;
  /** Claude Code's Fast mode when it differs from the selection's (`deriveClaudeFastModeNotice`). */
  readonly fastModeNotice?: FastModeNotice | null;
  readonly onSelectModel: (selection: ModelSelection) => void;
  /** Claude's observed prompt cache sits behind an ⓘ beside the model chip (web's meter). */
  readonly onOpenCacheInfo?: () => void;
  readonly onOpenSideChat?: () => void;
  /** The thread can take a goal: the `/` menu offers `/goal`, which the send reads. */
  readonly goalAvailable?: boolean;
  /** What the next message's context handoff is (`derivePendingComposerHandoff`). */
  readonly pendingHandoff?: PendingComposerHandoff | null;
  /**
   * Editor focus or the first keystroke into an empty composer: the user is about
   * to send, so the owner may prewarm the provider session the send would start.
   */
  readonly onComposerIntent?: () => void;
  /** Where `/`, `$` and `@` look things up; without it the composer offers no autocomplete. */
  readonly commandMenuContext?: ComposerCommandMenuContext | null;
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
  const { ref } = props;
  useImperativeHandle(
    ref,
    () => ({
      hasText: () => text.trim().length > 0,
      getText: () => text,
      setText,
      focus: () => editorRef.current?.focus(),
    }),
    [text],
  );
  const primaryFg = useThemeColor("--color-primary-foreground");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const iconColor = useThemeColor("--color-icon");
  const accessColor = useThemeColor("--color-access-caution");
  const warningColor = useThemeColor("--color-warning");
  const pillFastMode = modelPicker
    ? resolveModelPillFastMode(modelPicker, props.fastModeNotice)
    : null;

  const visibleAttachmentError = props.attachmentError ?? props.sendBlock;
  const canSend =
    (text.trim().length > 0 || props.attachments.length > 0) &&
    !sending &&
    !props.disabled &&
    !props.sendBlock;

  const modelMenuRef = useRef<AnchoredMenuHandle>(null);
  // Dictation and the command menu share the draft's caret: speech lands where it is.
  // Dictation lands at the command menu's caret, read when listening starts.
  const caretRef = useRef<ComposerEditorSelection>({ start: 0, end: 0 });
  const dictation = useComposerDictation({
    text,
    readSelection: () => caretRef.current,
    onChangeText: setText,
    onChangeSelection: (selection) => commandMenu.onSelectionChange(selection),
  });
  const dictating = dictation.active;
  const policyEditable = !(props.policyDisabled ?? false);
  const commandMenu = useComposerCommandMenu({
    text,
    onChangeText: setText,
    context: props.commandMenuContext ?? null,
    offers: {
      model: policyEditable && modelPicker !== null && modelPicker !== undefined,
      interactionMode:
        policyEditable && policyModel?.mode !== undefined && policyModel?.mode !== null,
      sideChat: props.onOpenSideChat !== undefined,
      goal: props.goalAvailable === true,
    },
    enabled: !props.disabled && !sending && !dictating,
    onAction: (action: ComposerCommandAction) => {
      switch (action.kind) {
        case "interaction-mode":
          props.onSelectInteractionMode(action.mode);
          return;
        case "open-model-picker":
          modelMenuRef.current?.open();
          return;
        case "open-side-chat":
          props.onOpenSideChat?.();
          return;
      }
    },
  });
  useLayoutEffect(() => {
    caretRef.current = commandMenu.selection;
  });

  const send = async () => {
    if (!canSend || dictating) return;
    const value = text;
    await runWhileBusy(setSending, async () => {
      const result = await props.onSend(value, props.attachments);
      // Keep the complete draft on an explicit failure; clear on success/enqueue.
      if (result !== false) {
        setText("");
      }
    });
  };

  const pasteImages = async (uris: ReadonlyArray<string>) => {
    await props.onPasteImages(uris);
  };

  return (
    <View
      className="px-4 pt-1"
      // The keyboard covers the home indicator: its inset would only float the composer above it.
      style={{ paddingBottom: keyboardVisible ? 8 : Math.max(8, safeAreaInsets.bottom) }}
    >
      {visibleAttachmentError ? (
        <Text className="px-3 pb-1.5 text-xs font-ryco-medium text-danger-foreground">
          {visibleAttachmentError}
        </Text>
      ) : null}
      <ComposerDictationError dictation={dictation} />
      {props.pendingHandoff?.kind === "fork" ? (
        <PendingForkHandoffChip />
      ) : props.pendingHandoff?.kind === "model-change" ? (
        <PendingContextHandoffChip {...props.pendingHandoff} />
      ) : null}
      <View>
        {commandMenu.trigger &&
        (commandMenu.items.length > 0 || commandMenu.trigger.kind === "path") ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={commandMenu.items}
              triggerKind={commandMenu.trigger.kind}
              isLoading={commandMenu.isLoading}
              onSelect={commandMenu.onSelect}
            />
          </View>
        ) : null}
        <GlassSurface
          radius={26}
          glassEffectStyle="regular"
          style={{ paddingHorizontal: 6, paddingVertical: 6 }}
        >
          <View className="gap-1">
            {dictating ? (
              <View className="px-0.5">
                <ComposerDictationBar dictation={dictation} />
              </View>
            ) : policyModel ? (
              <ComposerToolbarRow paddingTop={2} paddingBottom={2} paddingHorizontal={2}>
                {modelPicker && props.modelSelection ? (
                  <ComposerModelMenu
                    ref={modelMenuRef}
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
                        suffixIcon={pillFastMode?.icon}
                        suffixIconColor={
                          (pillFastMode?.muted ? iconSubtle : warningColor) as string
                        }
                        accessibilityLabel={
                          pillFastMode?.accessibilityLabel ?? modelPicker.pillLabel
                        }
                        disabled={props.policyDisabled}
                        onPress={open}
                        className="max-w-full flex-1"
                      />
                    )}
                  </ComposerModelMenu>
                ) : null}
                {props.onOpenCacheInfo ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Claude prompt cache"
                    onPress={props.onOpenCacheInfo}
                    hitSlop={6}
                    className="-ml-1 h-8 w-8 items-center justify-center rounded-full active:bg-subtle-strong"
                  >
                    <SymbolView
                      name="info.circle"
                      size={15}
                      tintColor={iconSubtle as string}
                      type="monochrome"
                    />
                  </Pressable>
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
              <ComposerAttachMenu
                disabled={sending || (props.disabled ?? false)}
                onPick={(source) => void props.onPickAttachments(source)}
                onClose={restoreFocus}
              >
                {(open) => (
                  <Pressable
                    disabled={sending || props.disabled}
                    onPress={open}
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
                )}
              </ComposerAttachMenu>
              <ComposerEditor
                ref={editorRef}
                value={text}
                skills={commandMenu.skills}
                threadTitles={commandMenu.threadTitles}
                selection={commandMenu.selection}
                onSelectionChange={commandMenu.onSelectionChange}
                onChangeText={(nextText) => {
                  if (text.length === 0 && nextText.length > 0) props.onComposerIntent?.();
                  setText(nextText);
                }}
                onFocus={props.onComposerIntent}
                placeholder={props.placeholder ?? "Message"}
                multiline
                editable={!props.disabled && !sending && !dictating}
                contentInsetVertical={10}
                style={{ minHeight: 44, maxHeight: 128, flex: 1 }}
                onPasteImages={(uris) => void pasteImages(uris)}
                onSubmit={() => void send()}
              />
              <ComposerDictationButton
                dictation={dictation}
                disabled={props.disabled === true || sending}
              />
              <Pressable
                disabled={!canSend || dictating}
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
    </View>
  );
}
