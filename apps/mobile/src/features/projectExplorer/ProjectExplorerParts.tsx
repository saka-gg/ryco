import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { ActorLine, PullRequestMarkdown } from "../pullRequests/PullRequestParts";
import type { IssueLabelChip } from "./issuesModel";
import type { ExplorerProblem } from "./projectExplorerModel";
import type { WorkItemTone } from "./workItemsModel";

// Small pieces the project explorer screens share. Layout only; every decision
// they show comes from the models beside them. Rows, chips, markdown and state
// pills come from the pull request screens, so both read as one surface.

export function SearchField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  return (
    <View className="mx-4 h-11 flex-row items-center gap-2 rounded-xl bg-card px-3">
      <SymbolView
        name="magnifyingglass"
        size={15}
        tintColor={iconColor as string}
        type="monochrome"
      />
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={placeholderColor as string}
        accessibilityLabel={props.placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        returnKeyType="search"
        className="min-w-0 flex-1 font-sans text-[16px] text-foreground"
      />
    </View>
  );
}

/** A host label, tinted with its own color where the host gave one. */
export function LabelChip(props: { readonly label: IssueLabelChip }) {
  const { colors } = props.label;
  return (
    <View
      className={cn(
        "rounded-full border px-2 py-0.5",
        colors === null && "border-border bg-subtle",
      )}
      style={
        colors === null
          ? undefined
          : { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor }
      }
    >
      <Text
        className={cn("text-2xs font-ryco-medium", colors === null && "text-foreground-secondary")}
        style={colors === null ? undefined : { color: colors.color }}
        numberOfLines={1}
      >
        {props.label.name}
      </Text>
    </View>
  );
}

export function LabelRow(props: {
  readonly labels: ReadonlyArray<IssueLabelChip>;
  readonly more?: number;
}) {
  if (props.labels.length === 0) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-1.5">
      {props.labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
      {props.more ? <Text className="text-2xs text-foreground-tertiary">+{props.more}</Text> : null}
    </View>
  );
}

const WORK_ITEM_TONE: Readonly<Record<WorkItemTone, string>> = {
  open: "border-border text-foreground-secondary",
  progress: "border-accent-border bg-accent-bg text-accent",
  done: "border-success-border bg-success-bg text-success",
  closed: "border-foreground-tertiary/40 text-foreground-tertiary",
  unknown: "border-border text-foreground-tertiary",
};

export function WorkItemStatePill(props: { readonly tone: WorkItemTone; readonly label: string }) {
  return (
    <View
      className={cn("self-start rounded-full border px-2.5 py-0.5", WORK_ITEM_TONE[props.tone])}
    >
      <Text className={cn("text-2xs font-ryco-bold", WORK_ITEM_TONE[props.tone])}>
        {props.label}
      </Text>
    </View>
  );
}

/**
 * A read that failed. The quiet ones (offline, no host, not available) read as
 * a plain note; anything else as a card with the host's words.
 */
export function ProblemState(props: { readonly problem: ExplorerProblem }) {
  const { problem } = props;
  return (
    <View className="px-4 py-8">
      <EmptyState
        variant={problem.kind === "error" ? "card" : "plain"}
        title={problem.title}
        detail={problem.detail}
      />
    </View>
  );
}

export function PlainNote(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="px-4 py-8">
      <EmptyState variant="plain" title={props.title} detail={props.detail} />
    </View>
  );
}

/** A comment from the host: who, when, and its markdown. */
export function CommentCard(props: {
  readonly author: string | null;
  readonly atMs: number | null;
  readonly body: string;
}) {
  return (
    <View className="mx-4 mb-2 gap-1.5 rounded-2xl border border-border bg-card px-4 py-3">
      <ActorLine author={props.author} atMs={props.atMs}>
        commented
      </ActorLine>
      <PullRequestMarkdown markdown={props.body} />
    </View>
  );
}

export function CardButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly primary?: boolean;
  readonly symbol?: AppSymbolName;
}) {
  const iconColor = useThemeColor(props.primary ? "--color-primary-foreground" : "--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full px-4 active:opacity-80 disabled:opacity-40",
        props.primary ? "bg-primary" : "border border-border bg-card",
      )}
    >
      {props.symbol ? (
        <SymbolView
          name={props.symbol}
          size={15}
          tintColor={iconColor as string}
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "text-sm font-ryco-bold",
          props.primary ? "text-primary-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** "+" in the navigation bar. */
export function HeaderPlusButton(props: {
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      hitSlop={6}
      onPress={props.onPress}
      className="h-11 w-11 items-center justify-center rounded-full active:bg-subtle-strong"
    >
      <SymbolView name="plus" size={19} tintColor={iconColor as string} type="monochrome" />
    </Pressable>
  );
}

/**
 * Writing one comment, in a page sheet over the screen: the draft lives here,
 * so a keystroke re-renders the sheet and nothing behind it.
 */
export function CommentSheet(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly sending: boolean;
  readonly error: string | null;
  readonly blockedReason: string | null;
  readonly onClose: () => void;
  /** Sends the draft; `done` closes the sheet once the host took it. */
  readonly onSend: (body: string, done: () => void) => void;
  readonly canSend: (draft: string) => boolean;
}) {
  const [draft, setDraft] = useState("");
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const sendDisabled = props.sending || props.blockedReason !== null || !props.canSend(draft);
  const send = () =>
    props.onSend(draft, () => {
      setDraft("");
      props.onClose();
    });
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 40 }}
      >
        <View className="flex-row items-center gap-3">
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
          >
            <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
          </Pressable>
          <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
            {props.title}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={sendDisabled}
            onPress={send}
            className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle disabled:opacity-40"
          >
            <Text className="text-base font-ryco-bold text-primary">
              {props.sending ? "Sending…" : "Send"}
            </Text>
          </Pressable>
        </View>
        {props.blockedReason ? (
          <Text className="text-sm text-foreground-muted">{props.blockedReason}</Text>
        ) : null}
        {props.error ? <ErrorBanner message={props.error} /> : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          editable={!props.sending}
          multiline
          autoFocus
          placeholder="Write a comment (Markdown)"
          placeholderTextColor={placeholderColor as string}
          textAlignVertical="top"
          className="min-h-44 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor as string }}
        />
      </ScrollView>
    </Modal>
  );
}
