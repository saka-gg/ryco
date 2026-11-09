import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { PullRequestDiffRow } from "../pullRequests/pullRequestDiffModel";

/** A small uppercase heading over a group of rows. */
export function SectionTitle(props: {
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="flex-row items-center justify-between px-1 pb-1.5 pt-2">
      <Text className="text-[12px] font-ryco-bold uppercase tracking-wide text-foreground-muted">
        {props.children}
      </Text>
      {props.trailing}
    </View>
  );
}

/** A grouped list surface; rows inside are separated by hairlines. */
export function GroupCard(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <View className={cn("overflow-hidden rounded-[18px] bg-card", props.className)}>
      {props.children}
    </View>
  );
}

/** One tappable row: a symbol, a title with a detail line, and a chevron or trailing view. */
export function ToolRow(props: {
  readonly symbol: AppSymbolName;
  readonly title: string;
  readonly detail?: string | null;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly trailing?: ReactNode;
  readonly destructive?: boolean;
  readonly first?: boolean;
}) {
  const iconColor = useThemeColor(props.destructive ? "--color-danger-foreground" : "--color-icon");
  const mutedColor = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.title, props.detail].filter(Boolean).join(", ")}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled || !props.onPress}
      onPress={props.onPress}
      className={cn(
        "min-h-[52px] flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle",
        props.first ? "" : "border-t border-separator",
        props.disabled ? "opacity-40" : "",
      )}
    >
      <View className="w-6 items-center">
        <SymbolView
          name={props.symbol}
          size={17}
          tintColor={iconColor as string}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          className={cn(
            "text-[15px] font-ryco-medium",
            props.destructive ? "text-danger-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {props.title}
        </Text>
        {props.detail ? (
          <Text className="mt-0.5 text-[12px] text-foreground-muted" numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.trailing ??
        (props.onPress ? (
          <SymbolView
            name="chevron.right"
            size={12}
            tintColor={mutedColor as string}
            type="monochrome"
          />
        ) : null)}
    </Pressable>
  );
}

/** A rounded action button. `primary` fills, `quiet` is a tinted pill. */
export function PillButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly variant?: "primary" | "quiet";
  readonly symbol?: AppSymbolName;
  readonly className?: string;
}) {
  const primary = props.variant !== "quiet";
  const tint = useThemeColor(primary ? "--color-primary-foreground" : "--color-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true, busy: props.busy === true }}
      disabled={props.disabled || props.busy}
      onPress={props.onPress}
      className={cn(
        "h-11 flex-row items-center justify-center gap-2 rounded-full px-4 active:opacity-75",
        primary ? "bg-primary" : "bg-subtle-strong",
        props.disabled ? "opacity-35" : "",
        props.className,
      )}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={tint as string} />
      ) : props.symbol ? (
        <SymbolView name={props.symbol} size={14} tintColor={tint as string} type="monochrome" />
      ) : null}
      <Text
        className={cn(
          "text-[14px] font-ryco-bold",
          primary ? "text-primary-foreground" : "text-foreground",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** A text field in the app's card style; `mono` for refs, paths and code. */
export function ToolTextField(
  props: TextInputProps & { readonly mono?: boolean; readonly className?: string },
) {
  const { mono, className, ...input } = props;
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      placeholderTextColor={placeholderColor as string}
      {...input}
      className={cn(
        "min-h-12 rounded-2xl border border-border bg-card px-4 py-3 text-[15px]",
        mono ? "font-mono" : "font-sans",
        className,
      )}
      style={[{ color: textColor as string }, input.style]}
    />
  );
}

const ROW_BACKGROUND: Readonly<Record<PullRequestDiffRow["kind"], string>> = {
  hunk: "bg-accent-bg",
  context: "",
  addition: "bg-success-bg",
  deletion: "bg-danger",
  notice: "",
};

const ROW_MARKER: Readonly<Record<PullRequestDiffRow["kind"], string>> = {
  hunk: "",
  context: " ",
  addition: "+",
  deletion: "−",
  notice: "\\",
};

/**
 * Diff rows as plain monospace lines with old/new line numbers, scrolling
 * sideways as one block. Long-pressing a row reports it (line blame).
 */
export function DiffRowsView(props: {
  readonly rows: ReadonlyArray<PullRequestDiffRow>;
  readonly onLongPressRow?: (row: PullRequestDiffRow) => void;
  readonly selectedRow?: PullRequestDiffRow | null;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
      <View className="min-w-full py-1">
        {props.rows.map((row, index) => (
          <Pressable
            // Rows are positional: a diff never reorders its own lines.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            disabled={!props.onLongPressRow || row.kind === "hunk" || row.kind === "notice"}
            onLongPress={() => props.onLongPressRow?.(row)}
            delayLongPress={350}
            className={cn(
              "flex-row",
              ROW_BACKGROUND[row.kind],
              props.selectedRow === row ? "bg-subtle-strong" : "",
            )}
          >
            <Text className="w-9 pr-1 text-right font-mono text-[11px] leading-5 text-foreground-tertiary">
              {row.oldLine ?? ""}
            </Text>
            <Text className="w-9 pr-1 text-right font-mono text-[11px] leading-5 text-foreground-tertiary">
              {row.newLine ?? ""}
            </Text>
            <Text
              className={cn(
                "pl-1.5 pr-4 font-mono text-[12px] leading-5",
                row.kind === "hunk" || row.kind === "notice"
                  ? "text-foreground-muted"
                  : "text-foreground",
              )}
            >
              {ROW_MARKER[row.kind]}
              {row.kind === "hunk" ? "" : " "}
              {row.text}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/** A centred spinner with a short label, for first loads. */
export function LoadingRow(props: { readonly label: string }) {
  return (
    <View className="flex-row items-center justify-center gap-2 py-8">
      <ActivityIndicator size="small" />
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
    </View>
  );
}
