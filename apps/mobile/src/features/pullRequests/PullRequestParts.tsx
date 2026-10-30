import type {
  ChangeRequestChecksOverall,
  PullRequestReadinessTone,
} from "@ryco/client-runtime/state/pull-request-review";
import * as Linking from "expo-linking";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { useNativeMarkdownTextStyle } from "../../native/useNativeMarkdownTextStyle";
import type { PullRequestStateTone } from "./pullRequestDetailModel";

// Small pieces the pull request screens share. Layout only; every decision
// they show comes from the models beside them.

const STATE_TONE: Readonly<Record<PullRequestStateTone, string>> = {
  open: "border-success/40 text-success",
  draft: "border-foreground-tertiary/40 text-foreground-tertiary",
  merged: "border-violet-500/30 bg-violet-500/10 text-violet-500",
  closed: "border-danger-foreground/40 text-danger-foreground",
};

export function PullRequestStatePill(props: {
  readonly tone: PullRequestStateTone;
  readonly label: string;
}) {
  return (
    <View className={cn("self-start rounded-full border px-2.5 py-0.5", STATE_TONE[props.tone])}>
      <Text className={cn("text-2xs font-ryco-bold", STATE_TONE[props.tone])}>{props.label}</Text>
    </View>
  );
}

const READINESS_TEXT: Readonly<Record<PullRequestReadinessTone, string>> = {
  neutral: "text-foreground-muted",
  progress: "text-foreground-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger-foreground",
  merged: "text-violet-500",
};

export function readinessTextClass(tone: PullRequestReadinessTone): string {
  return READINESS_TEXT[tone];
}

const CHECK_DOT: Readonly<Record<ChangeRequestChecksOverall, string>> = {
  passing: "bg-success",
  failing: "bg-danger-foreground",
  pending: "bg-accent",
  none: "border border-border bg-transparent",
};

const CHECK_WORD: Readonly<Record<ChangeRequestChecksOverall, string>> = {
  passing: "Checks passed",
  failing: "Checks failing",
  pending: "Checks running",
  none: "No checks",
};

/** A check state as a dot; `none` draws nothing unless `showNone`. */
export function CheckDot(props: {
  readonly overall: ChangeRequestChecksOverall;
  readonly showNone?: boolean;
}) {
  if (props.overall === "none" && !props.showNone) return null;
  return (
    <View
      accessible
      accessibilityLabel={CHECK_WORD[props.overall]}
      className={cn("h-2 w-2 rounded-full", CHECK_DOT[props.overall])}
    />
  );
}

export function FilterChip(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "h-8 items-center justify-center rounded-full border px-3 active:opacity-70",
        props.selected ? "border-primary bg-primary" : "border-border bg-card",
      )}
    >
      <Text
        className={cn(
          "text-xs font-ryco-bold",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A row of chips that scrolls sideways when it does not fit. */
export function ChipRow(props: { readonly children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
    >
      {props.children}
    </ScrollView>
  );
}

/** "@alice · 3h": who and when, either side optional. */
export function ActorLine(props: {
  readonly author: string | null;
  readonly atMs: number | null;
  readonly children?: React.ReactNode;
}) {
  const time = props.atMs === null ? null : relativeTime(new Date(props.atMs).toISOString());
  return (
    <Text className="text-xs text-foreground-muted" numberOfLines={2}>
      {props.author ? (
        <Text className="font-ryco-bold text-foreground">@{props.author}</Text>
      ) : null}
      {props.children ? <> {props.children}</> : null}
      {time ? <Text className="text-foreground-tertiary"> · {time}</Text> : null}
    </Text>
  );
}

/** Markdown from the host (descriptions, comments); plain text where the native view is missing. */
export function PullRequestMarkdown(props: { readonly markdown: string }) {
  const markdownStyle = useNativeMarkdownTextStyle();
  if (!hasNativeSelectableMarkdownText()) {
    return (
      <Text selectable className="font-sans text-sm leading-normal text-foreground">
        {props.markdown}
      </Text>
    );
  }
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={markdownStyle}
      preserveSoftBreaks
      marginTop={0}
      marginBottom={0}
      onLinkPress={(href) => {
        void Linking.openURL(href).catch(() => undefined);
      }}
    />
  );
}

export function openPullRequestLink(url: string | null): void {
  if (url === null) return;
  void Linking.openURL(url).catch(() => undefined);
}

export function SectionTitle(props: { readonly title: string; readonly detail?: string | null }) {
  return (
    <View className="flex-row items-baseline justify-between px-5 pb-1.5 pt-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      {props.detail ? (
        <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
      ) : null}
    </View>
  );
}
