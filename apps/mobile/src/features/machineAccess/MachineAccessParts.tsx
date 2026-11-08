import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

export const LIVE_TONE: StatusTone = {
  label: "Connected",
  pillClassName: "bg-success-bg border border-success-border",
  textClassName: "text-success",
};
export const QUIET_TONE: StatusTone = {
  label: "",
  pillClassName: "bg-subtle",
  textClassName: "text-foreground-muted",
};
export const DANGER_TONE: StatusTone = {
  label: "",
  pillClassName: "bg-danger border border-danger-border",
  textClassName: "text-danger-foreground",
};

/** A titled group: a muted heading, an optional trailing control, and a card. */
export function AccessSection(props: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly footnote?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View className="mt-7">
      <View className="min-h-6 flex-row items-center gap-3 px-5 pb-2.5">
        <Text className="flex-1 text-sm font-ryco-medium text-foreground-muted">{props.title}</Text>
        {props.trailing}
      </View>
      <View className="mx-5 overflow-hidden rounded-2xl border border-border bg-card">
        {props.children}
      </View>
      {props.footnote ? (
        <Text className="mt-2 px-5 font-sans text-xs leading-relaxed text-foreground-muted">
          {props.footnote}
        </Text>
      ) : null}
    </View>
  );
}

export interface AccessRowAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

/** One listed link, client, endpoint or device, with its actions under it. */
export function AccessRow(props: {
  readonly title: string;
  readonly detail?: string | null;
  readonly note?: string | null;
  readonly mono?: string | null;
  readonly status?: StatusTone | null;
  readonly first: boolean;
  readonly actions?: ReadonlyArray<AccessRowAction>;
  readonly onPress?: () => void;
  readonly children?: ReactNode;
}) {
  const body = (
    <View className="flex-row items-start gap-3 px-4 py-3.5">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-ryco-medium text-foreground" numberOfLines={2}>
          {props.title}
        </Text>
        {props.detail ? (
          <Text className="font-sans text-xs leading-4 text-foreground-muted" numberOfLines={3}>
            {props.detail}
          </Text>
        ) : null}
        {props.mono ? (
          <Text className="font-mono text-xs text-foreground-muted" selectable numberOfLines={2}>
            {props.mono}
          </Text>
        ) : null}
        {props.note ? (
          <Text className="mt-0.5 font-sans text-xs leading-4 text-foreground-tertiary">
            {props.note}
          </Text>
        ) : null}
      </View>
      {props.status && props.status.label ? (
        <StatusPill
          size="compact"
          label={props.status.label}
          pillClassName={props.status.pillClassName}
          textClassName={props.status.textClassName}
        />
      ) : null}
    </View>
  );
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      {props.onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.title}
          onPress={props.onPress}
          className="active:bg-subtle"
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {props.children}
      {props.actions && props.actions.length > 0 ? (
        <View className="flex-row flex-wrap gap-2 px-4 pb-3.5">
          {props.actions.map((action) => (
            <ActionChip
              key={action.label}
              {...action}
              accessibilityLabel={`${action.label} ${props.title}`}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ActionChip(
  props: AccessRowAction & { readonly accessibilityLabel?: string; readonly busy?: boolean },
) {
  const spinner = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true, busy: props.busy === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-10 flex-row items-center justify-center gap-2 rounded-xl border px-3.5 active:bg-subtle disabled:opacity-40",
        props.destructive ? "border-danger-border" : "border-border",
      )}
    >
      {props.busy ? <ActivityIndicator size="small" color={spinner as string} /> : null}
      <Text
        className={cn(
          "text-xs font-ryco-bold",
          props.destructive ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The card body for a section the phone cannot offer, saying why. */
export function AccessUnavailable(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="gap-1 px-4 py-4">
      <Text className="text-base font-ryco-medium text-foreground">{props.title}</Text>
      <Text className="font-sans text-sm leading-relaxed text-foreground-muted">
        {props.detail}
      </Text>
    </View>
  );
}

/** A one-line quiet row inside a card: empty lists and loading. */
export function AccessQuietRow(props: { readonly label: string; readonly loading?: boolean }) {
  const spinner = useThemeColor("--color-icon-muted");
  return (
    <View className="flex-row items-center gap-3 px-4 py-4">
      {props.loading ? <ActivityIndicator size="small" color={spinner as string} /> : null}
      <Text className="flex-1 font-sans text-sm text-foreground-muted">{props.label}</Text>
    </View>
  );
}

/** A full-width button at the top of a card. */
export function AccessPrimaryRow(props: {
  readonly label: string;
  readonly detail?: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="gap-0.5 px-4 py-3.5 active:bg-subtle disabled:opacity-40"
    >
      <Text
        className={cn(
          "text-base font-ryco-bold",
          props.destructive === true ? "text-danger-foreground" : "text-accent-strong",
        )}
      >
        {props.label}
      </Text>
      {props.detail ? (
        <Text className="font-sans text-xs leading-4 text-foreground-muted">{props.detail}</Text>
      ) : null}
    </Pressable>
  );
}
