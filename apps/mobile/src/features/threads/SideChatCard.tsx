import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ModelSelection, ServerConfig } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { ComposerEditor } from "../../native/ComposerEditor";
import { ModelPickerSheet } from "./ModelPickerSheet";
import {
  applyModelOption,
  buildModelPickerModel,
  resolveModelPickerSelection,
} from "./modelPickerModel";

/** Presentation only: the shared side-chat store owns requests and cancellation. */
export function SideChatCard(props: {
  readonly open: boolean;
  readonly draft: string;
  readonly modelSelection: ModelSelection;
  readonly exchanges: ReadonlyArray<{ requestId: string; question: string; answer: string }>;
  readonly pending: { question: string } | null;
  readonly error: string | null;
  readonly serverConfig: ServerConfig | null;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly onDraftChange: (text: string) => void;
  readonly onModelChange: (model: ModelSelection) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onClear: () => void;
}) {
  const [modelVisible, setModelVisible] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const picker = buildModelPickerModel({
    serverConfig: props.serverConfig,
    currentSelection: props.modelSelection,
    query: modelQuery,
  });
  const canSend = !props.disabled && !props.pending && props.draft.trim().length > 0;

  if (!props.open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reopen side chat"
        onPress={props.onOpen}
        className="mx-4 mb-1 min-h-11 justify-center rounded-2xl bg-subtle px-4"
      >
        <Text className="text-sm font-ryco-medium text-foreground">
          {props.pending ? "Side chat · Answering…" : "Side chat · Reopen"}
        </Text>
      </Pressable>
    );
  }

  return (
    <View className="mx-4 mb-2 gap-2 rounded-2xl border border-border bg-card p-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-ryco-bold text-foreground">Side chat</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New side chat"
          disabled={Boolean(props.pending)}
          onPress={props.onClear}
          className="min-h-11 justify-center px-2 disabled:opacity-40"
        >
          <Text className="text-xs text-foreground-muted">New</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Minimize side chat"
          onPress={props.onClose}
          className="min-h-11 justify-center px-2"
        >
          <Text className="text-xs text-foreground-muted">Minimize</Text>
        </Pressable>
      </View>
      <Text className="text-xs text-foreground-muted">
        Read-only · Completed thread context · Not saved
      </Text>
      <ScrollView
        style={{ maxHeight: 220 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 12 }}
      >
        {props.exchanges.map((exchange) => (
          <View key={exchange.requestId} className="gap-2">
            <Text
              selectable
              className="self-end rounded-xl bg-subtle px-3 py-2 text-sm text-foreground"
            >
              {exchange.question}
            </Text>
            <Text selectable className="text-sm text-foreground">
              {exchange.answer}
            </Text>
          </View>
        ))}
        {props.pending ? (
          <View className="gap-2">
            <Text
              selectable
              className="self-end rounded-xl bg-subtle px-3 py-2 text-sm text-foreground"
            >
              {props.pending.question}
            </Text>
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              Answering…
            </Text>
          </View>
        ) : null}
      </ScrollView>
      {props.error ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
      {props.disabled ? (
        <Text className="text-xs text-foreground-muted">Reconnect to ask a side question.</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Side chat model and reasoning"
        disabled={Boolean(props.pending)}
        onPress={() => setModelVisible(true)}
        className="min-h-11 justify-center"
      >
        <Text className="text-xs font-ryco-medium text-foreground">
          {picker.pillLabel}
          {picker.pillReasoningLabel ? ` · ${picker.pillReasoningLabel}` : ""}
        </Text>
      </Pressable>
      <ComposerEditor
        value={props.draft}
        onChangeText={props.onDraftChange}
        placeholder="Ask a side question"
        multiline
        editable={!props.pending}
        contentInsetVertical={10}
        style={{ minHeight: 44, maxHeight: 100 }}
        onSubmit={() => {
          if (canSend) props.onSend();
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.pending ? "Stop side answer" : "Send side question"}
        disabled={!props.pending && !canSend}
        onPress={props.pending ? props.onCancel : props.onSend}
        className="min-h-11 items-center justify-center rounded-xl bg-primary disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">
          {props.pending ? "Stop" : "Ask"}
        </Text>
      </Pressable>
      <ModelPickerSheet
        visible={modelVisible}
        model={picker}
        query={modelQuery}
        onChangeQuery={setModelQuery}
        onClose={() => {
          setModelVisible(false);
          setModelQuery("");
        }}
        onSelect={(key) => {
          const next = resolveModelPickerSelection(picker, key);
          if (next) props.onModelChange(next);
          setModelVisible(false);
          setModelQuery("");
        }}
        onSelectOption={(optionId, value) => {
          const capabilities =
            picker.groups.flatMap((group) => group.entries).find((entry) => entry.selected)
              ?.capabilities ?? null;
          props.onModelChange(
            applyModelOption(props.modelSelection, capabilities, optionId, value),
          );
        }}
      />
    </View>
  );
}
