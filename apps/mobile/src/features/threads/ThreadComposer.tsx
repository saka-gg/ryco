import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { useKeyboardState } from "react-native-keyboard-controller";
import type {
  AgentTokenMode,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@ryco/contracts";
import type { FastModeNotice } from "@ryco/client-runtime/state/session";
import type { ModelPickerModel } from "./modelPickerModel";
import type { SessionPolicyModel } from "./sessionPolicyModel";
import { composerShrinkHeld } from "./composerShrinkModel";
import {
  composerPlaceholder,
  composerPrimaryAction,
  isComposerFooterCompact,
} from "./composerFooterModel";
import { ComposerModelControls } from "./ComposerModelControls";
import {
  ComposerContextMeter,
  ComposerRoundButton,
  ComposerSendGlyph,
} from "./ComposerFooterParts";
import { COMPOSER_SIDE_INSET } from "./ComposerShrunkBubble";
import type { ComposerShrinkBinding } from "./useComposerShrink";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
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

// The chat composer, laid out as the desktop one (apps/web ChatComposer + ComposerPromptShell +
// ComposerFooter): one rounded card with the attachments and the prompt on top and the footer
// inside it — paperclip, the model pill (its picker has the provider tabs on top), then mode,
// access and tokens (folded into "More composer controls" below the shared 620pt breakpoint),
// and on the right the mic, the context ring and the round send / stop. While the reader scrolls
// back through the chat it shrinks away into the screen's "Message" bubble (`useComposerShrink`).
// It uses the shared native ComposerEditor so mentions/skills, hardware-keyboard submit, and
// pasted images behave like the desktop composer. Attachment state (images + streamed files)
// lives in the owning screen, which knows the environment/thread context the upload engine needs.

/** The desktop card: `rounded-3xl` frame with a 1pt inset surface. */
const CARD_RADIUS = 28;
/** The desktop prompt: 14px text on a 22.75px line (`text-sm leading-relaxed`). */
const TEXT_SIZE = 14;
const LINE_HEIGHT = 22.75;
/** The desktop editor's empty height, two and a bit lines; it grows to seven, then scrolls. */
const MIN_FIELD_HEIGHT = 70;
const MAX_FIELD_HEIGHT = LINE_HEIGHT * 7;
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
  /** The thread's token budget; absent hides the Tokens control. */
  readonly tokenMode?: AgentTokenMode;
  readonly onSelectTokenMode?: ((mode: AgentTokenMode) => void) | undefined;
  /** How full the context window is (0–1), for the footer ring; null before any usage. */
  readonly contextFraction?: number | null;
  readonly onOpenContextDetails?: (() => void) | undefined;
  /** The picker's "+" tab: the machine's provider settings. */
  readonly onAddProviders?: (() => void) | undefined;
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
  const modelSelection = props.modelSelection ?? null;
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
  const iconMuted = useThemeColor("--color-icon-muted");
  const surface = useThemeColor("--color-composer-surface");
  const [focused, setFocused] = useState(false);
  // The card's width decides the footer layout with the desktop's own breakpoint.
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  const compact = isComposerFooterCompact(cardWidth);
  // The field grows with its text, then scrolls.
  const [fieldContentHeight, setFieldContentHeight] = useState<number | null>(null);
  const fieldHeight = Math.min(
    MAX_FIELD_HEIGHT,
    Math.max(MIN_FIELD_HEIGHT, Math.ceil(fieldContentHeight ?? 0)),
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
  const policyDisabled = props.policyDisabled ?? false;
  const policyEditable = !policyDisabled;
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

  // `/` and `@` from the attach menu: the trigger goes in at the caret, after a space when the
  // caret follows a word, and the command popover takes it from there.
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
  const running = props.running === true;
  const primaryAction = composerPrimaryAction({
    hasContent,
    running,
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
          <View
            onLayout={(event) => setCardWidth(event.nativeEvent.layout.width)}
            style={{ borderRadius: CARD_RADIUS, backgroundColor: surface }}
          >
            {/* The prompt: 12pt sides, 14pt above and 8pt below, as the desktop below `sm`. */}
            <View style={{ paddingHorizontal: 12, paddingTop: 14, paddingBottom: 8 }}>
              {props.attachments.length > 0 ? (
                <View style={{ marginBottom: 12 }}>
                  <ComposerAttachmentStrip
                    attachments={props.attachments}
                    fileUploadRecords={props.fileUploadRecords}
                    imageSize={64}
                    imageBorderRadius={10}
                    onRemove={props.onRemoveAttachment}
                    onRetryFileUpload={props.onRetryFileUpload}
                    onReattachFile={props.onReattachFile}
                  />
                </View>
              ) : null}
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
                placeholder={composerPlaceholder({ running, override: props.placeholder })}
                multiline
                editable={!props.disabled && !sending && !dictating}
                contentInsetVertical={0}
                textStyle={{ fontSize: TEXT_SIZE, lineHeight: LINE_HEIGHT }}
                onContentHeightChange={setFieldContentHeight}
                style={{ height: fieldHeight }}
                onPasteImages={(uris) => void pasteImages(uris)}
                onSubmit={() => void send()}
              />
            </View>
            {dictating ? (
              <View style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
                <ComposerDictationBar dictation={dictation} />
              </View>
            ) : (
              // Every control rests on the same bottom edge, 8pt above the card's.
              <View
                className="flex-row items-end justify-between"
                style={{ gap: 6, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 }}
              >
                <View className="min-w-0 flex-1 flex-row items-center" style={{ gap: 2 }}>
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
                        accessibilityLabel="Add context"
                        hitSlop={{ top: 10, bottom: 10, left: 8, right: 4 }}
                        className="size-6 items-center justify-center rounded-full active:bg-subtle-strong"
                      >
                        <SymbolView
                          name="paperclip"
                          size={15}
                          tintColor={iconMuted as string}
                          type="monochrome"
                        />
                      </Pressable>
                    )}
                  </ComposerAttachMenu>
                  <ComposerModelControls
                    ref={modelMenuRef}
                    modelPicker={modelPicker ?? null}
                    modelSelection={modelSelection}
                    onSelectModel={props.onSelectModel}
                    policy={policyModel ?? null}
                    onSelectRuntimeMode={props.onSelectRuntimeMode}
                    onSelectInteractionMode={props.onSelectInteractionMode}
                    tokenMode={props.tokenMode}
                    onSelectTokenMode={props.onSelectTokenMode}
                    compact={compact}
                    disabled={policyDisabled}
                    prompt={text}
                    fastModeNotice={props.fastModeNotice}
                    onOpenCacheInfo={props.onOpenCacheInfo}
                    onAddProviders={props.onAddProviders}
                    onClose={restoreFocus}
                  />
                </View>
                <View className="flex-row items-center" style={{ gap: 8 }}>
                  <View className="flex-row items-center" style={{ gap: 2 }}>
                    <ComposerDictationButton
                      dictation={dictation}
                      disabled={props.disabled === true || sending}
                      size={28}
                      muted
                    />
                    <ComposerContextMeter
                      fraction={props.contextFraction ?? null}
                      onPress={props.onOpenContextDetails}
                    />
                  </View>
                  {primaryAction === "stop" ? (
                    <ComposerRoundButton
                      tone="stop"
                      accessibilityLabel="Stop generation"
                      disabled={false}
                      onPress={() => props.onStop?.()}
                    >
                      <View
                        style={{ width: 8, height: 8, borderRadius: 1.5 }}
                        className="bg-white"
                      />
                    </ComposerRoundButton>
                  ) : (
                    <ComposerRoundButton
                      tone="primary"
                      accessibilityLabel={
                        primaryAction === "queue"
                          ? "Queue follow-up"
                          : sending
                            ? "Sending"
                            : "Send message"
                      }
                      disabled={!canSend}
                      onPress={() => void send()}
                    >
                      <ComposerSendGlyph size={14} color={primaryFg as string} />
                    </ComposerRoundButton>
                  )}
                </View>
              </View>
            )}
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}
