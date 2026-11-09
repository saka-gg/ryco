import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import type { ModelSelection, RuntimeMode, ProviderInteractionMode } from "@ryco/contracts";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import type { ModelPickerModel } from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";
import { ComposerCaption } from "./ComposerCaption";
import { composerShrinkHeld } from "./composerShrinkModel";
import { composerPrimaryAction } from "./composerCaptionModel";
import { COMPOSER_SIDE_INSET } from "./ComposerShrunkBubble";
import type { ComposerShrinkBinding } from "./useComposerShrink";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { GlassSurface } from "../../components/GlassSurface";
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

// The chat composer: a quiet icon caption (model, effort, mode, access) over a one-line glass
// capsule (+ · text · mic, send or stop). While the reader scrolls back through the chat it
// shrinks away into the screen's "Message" bubble (`useComposerShrink`). It uses the shared
// native ComposerEditor so mentions/skills, hardware-keyboard submit, and pasted images behave
// like the desktop composer. Attachment state (images + streamed files) lives in the owning
// screen, which knows the environment/thread context the upload engine needs.

const CAPSULE_RADIUS = 24;
const CAPSULE_PADDING = 5;
const BUTTON = 32;
const TEXT_SIZE = 15.5;
const LINE_HEIGHT = 21;
const TEXT_INSET = 6;
/** Five lines, then the field scrolls. */
const MAX_FIELD_HEIGHT = LINE_HEIGHT * 5 + TEXT_INSET * 2;
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
  /** Claude's observed prompt cache, a row inside the model menu (web's meter). */
  readonly onOpenCacheInfo?: () => void;
  /** A turn runs: an empty composer offers Stop instead of the mic. */
  readonly running?: boolean;
  /** Stops the running turn; absent while it cannot be stopped from here. */
  readonly onStop?: (() => void) | undefined;
  /** The shrink-away while the reader scrolls back; absent, the composer always shows. */
  readonly shrink?: ComposerShrinkBinding | undefined;
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
  const [focused, setFocused] = useState(false);
  // The field grows with its text up to five lines, then scrolls.
  const [fieldContentHeight, setFieldContentHeight] = useState<number | null>(null);
  const fieldHeight = Math.min(
    MAX_FIELD_HEIGHT,
    Math.max(BUTTON + 2, Math.ceil(fieldContentHeight ?? 0)),
  );

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

  // `/` and `@` from the + menu: the trigger goes in at the caret, after a space when the caret
  // follows a word, and the command popover takes it from there.
  const insertTrigger = (trigger: "/" | "@") => {
    const caret = caretRef.current;
    const before = text.slice(0, caret.start);
    const after = text.slice(caret.end);
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const next = `${before}${lead}${trigger}${after}`;
    const position = before.length + lead.length + 1;
    setText(next);
    commandMenu.onSelectionChange({ start: position, end: position });
    // After the menu let go of the keyboard: focus once its close finished.
    setTimeout(() => editorRef.current?.focus(), 250);
  };

  const commandMenuOpen =
    commandMenu.trigger !== null &&
    (commandMenu.items.length > 0 || commandMenu.trigger.kind === "path");
  const held = composerShrinkHeld({
    focused,
    hasText: text.trim().length > 0,
    hasAttachments: props.attachments.length > 0,
    dictating,
    commandMenuOpen,
  });
  const shrink = props.shrink;
  const onHeldChangeRef = useRef(shrink?.onHeldChange);
  useLayoutEffect(() => {
    onHeldChangeRef.current = shrink?.onHeldChange;
  });
  useEffect(() => {
    onHeldChangeRef.current?.(held);
  }, [held]);

  // Shrunk, the composer hands the feed its room (a negative top margin as tall as itself, so
  // its own place stays put) and folds toward the bubble at the bottom right.
  const progress = shrink?.progress;
  const measuredHeight = shrink?.height;
  const roomStyle = useAnimatedStyle(() => {
    const value = progress?.get() ?? 0;
    return { marginTop: -(measuredHeight?.get() ?? 0) * value };
  });
  const foldStyle = useAnimatedStyle(() => {
    const value = progress?.get() ?? 0;
    return {
      opacity: Math.min(1, Math.max(0, 1 - value * 1.5)),
      transform: [{ scale: 1 - 0.3 * value }],
    };
  });

  const hasContent = text.trim().length > 0 || props.attachments.length > 0;
  const primaryAction = composerPrimaryAction({
    dictating,
    hasContent,
    running: props.running === true,
    canStop: props.onStop !== undefined,
  });
  const collapsed = shrink?.collapsed === true;

  return (
    <Animated.View
      pointerEvents={collapsed ? "none" : "auto"}
      accessibilityElementsHidden={collapsed}
      importantForAccessibility={collapsed ? "no-hide-descendants" : "auto"}
      style={[
        {
          paddingHorizontal: COMPOSER_SIDE_INSET,
          paddingTop: 4,
          // The keyboard covers the home indicator: its inset would only float the composer above it.
          paddingBottom: keyboardVisible ? 8 : Math.max(8, safeAreaInsets.bottom),
        },
        roomStyle,
      ]}
    >
      <Animated.View
        onLayout={(event) => measuredHeight?.set(event.nativeEvent.layout.height)}
        style={[{ transformOrigin: "bottom right" }, foldStyle]}
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
          {commandMenuOpen && commandMenu.trigger ? (
            <View className="absolute inset-x-0 bottom-full z-10 mb-2">
              <ComposerCommandPopover
                items={commandMenu.items}
                triggerKind={commandMenu.trigger.kind}
                isLoading={commandMenu.isLoading}
                onSelect={commandMenu.onSelect}
              />
            </View>
          ) : null}
          {dictating ? (
            <View className="px-1 pb-1">
              <ComposerDictationBar dictation={dictation} />
            </View>
          ) : policyModel ? (
            <ComposerCaption
              ref={modelMenuRef}
              policyModel={policyModel}
              policyDisabled={props.policyDisabled ?? false}
              modelPicker={modelPicker ?? null}
              modelSelection={props.modelSelection ?? null}
              fastModeNotice={props.fastModeNotice}
              onSelectModel={props.onSelectModel}
              onSelectRuntimeMode={props.onSelectRuntimeMode}
              onSelectInteractionMode={props.onSelectInteractionMode}
              onOpenCacheInfo={props.onOpenCacheInfo}
              onMenuClose={restoreFocus}
            />
          ) : null}
          <GlassSurface
            radius={CAPSULE_RADIUS}
            glassEffectStyle="regular"
            style={{ padding: CAPSULE_PADDING }}
          >
            {props.attachments.length > 0 ? (
              <View className="px-1 pb-1 pt-0.5">
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
            ) : null}
            <View className="flex-row items-end" style={{ gap: 4 }}>
              <ComposerAttachMenu
                disabled={sending || (props.disabled ?? false)}
                onPick={(source) => void props.onPickAttachments(source)}
                {...(props.commandMenuContext
                  ? {
                      onInsertCommand: () => insertTrigger("/"),
                      onInsertMention: () => insertTrigger("@"),
                    }
                  : {})}
                onOpenSideChat={props.onOpenSideChat}
                onClose={restoreFocus}
              >
                {(open) => (
                  <Pressable
                    onPress={open}
                    accessibilityRole="button"
                    accessibilityLabel="Attach, commands and side chat"
                    className="items-center justify-center rounded-full bg-subtle-strong active:opacity-70"
                    style={{ width: BUTTON, height: BUTTON, marginBottom: 1 }}
                  >
                    <SymbolView
                      name="plus"
                      size={17}
                      weight="semibold"
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
                onFocus={() => {
                  setFocused(true);
                  props.onComposerIntent?.();
                }}
                onBlur={() => setFocused(false)}
                placeholder={props.placeholder ?? "Message"}
                multiline
                editable={!props.disabled && !sending && !dictating}
                contentInsetVertical={TEXT_INSET}
                textStyle={{ fontSize: TEXT_SIZE, lineHeight: LINE_HEIGHT }}
                onContentHeightChange={setFieldContentHeight}
                style={{ height: fieldHeight, flex: 1 }}
                onPasteImages={(uris) => void pasteImages(uris)}
                onSubmit={() => void send()}
              />
              <View style={{ marginBottom: 1 }}>
                {primaryAction === "mic" ? (
                  <ComposerDictationButton
                    dictation={dictation}
                    disabled={props.disabled === true || sending}
                    size={BUTTON}
                  />
                ) : primaryAction === "stop" ? (
                  <Pressable
                    onPress={props.onStop}
                    accessibilityRole="button"
                    accessibilityLabel="Stop"
                    className="items-center justify-center rounded-full bg-primary active:opacity-70"
                    style={{ width: BUTTON, height: BUTTON }}
                  >
                    <View
                      style={{ width: 11, height: 11, borderRadius: 3 }}
                      className="bg-primary-foreground"
                    />
                  </Pressable>
                ) : (
                  <Pressable
                    disabled={!canSend || dictating}
                    onPress={() => void send()}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                    className="items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-40"
                    style={{ width: BUTTON, height: BUTTON }}
                  >
                    <SymbolView
                      name="arrow.up"
                      size={15}
                      weight="bold"
                      tintColor={(canSend ? primaryFg : iconSubtle) as string}
                      type="monochrome"
                    />
                  </Pressable>
                )}
              </View>
            </View>
          </GlassSurface>
        </View>
      </Animated.View>
    </Animated.View>
  );
}
