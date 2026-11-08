import type { ComposerTriggerKind } from "@ryco/client-runtime/state/composer";
import { markdownFileIconSource } from "@ryco/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@ryco/mobile-markdown-text/links";
import { memo } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { SymbolView, type SFSymbol } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ComposerCommandItem } from "./composerCommandMenuModel";

// The autocomplete list that floats just above the composer, which itself rides
// the keyboard, so the rows stay next to the caret while typing. Taps keep the
// keyboard up (`keyboardShouldPersistTaps`), and a pick writes straight into
// the native editor, where mentions and skills render as chips.

function itemSymbol(item: ComposerCommandItem): SFSymbol | null {
  switch (item.type) {
    case "slash-command":
    case "provider-slash-command":
      return "terminal";
    case "skill":
      return "cube";
    case "thread":
      return "text.bubble";
    case "path":
      return item.kind === "directory" ? "folder" : null;
  }
}

function groupLabel(kind: ComposerTriggerKind | null): string | null {
  switch (kind) {
    case "slash-command":
      return "Commands";
    case "skill":
      return "Skills";
    case "path":
      return "Threads and files";
    default:
      return null;
  }
}

function emptyText(kind: ComposerTriggerKind | null, isLoading: boolean): string {
  if (isLoading) return kind === "path" ? "Searching files…" : "Loading…";
  switch (kind) {
    case "path":
      return "No matching threads, files or folders.";
    case "skill":
      return "No skills found. Try / to browse commands.";
    case "slash-command":
      return "No matching commands.";
    default:
      return "No results.";
  }
}

const CommandRow = memo(function CommandRow(props: {
  readonly item: ComposerCommandItem;
  readonly isLast: boolean;
  readonly onPress: () => void;
}) {
  const { item } = props;
  const iconTint = useThemeColor("--color-icon-subtle");
  const symbol = itemSymbol(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.description ? `${item.label}, ${item.description}` : item.label}
      onPress={props.onPress}
      className="flex-row items-center gap-2.5 border-border px-3.5 py-2.5 active:bg-subtle-strong"
      style={{ borderBottomWidth: props.isLast ? 0 : StyleSheet.hairlineWidth }}
    >
      <View className="w-4 items-center">
        {item.type === "path" && item.kind === "file" ? (
          <Image
            source={markdownFileIconSource(resolveMarkdownFileIcon(item.path))}
            style={{ width: 16, height: 16 }}
          />
        ) : symbol ? (
          <SymbolView name={symbol} size={14} tintColor={iconTint as string} type="monochrome" />
        ) : null}
      </View>
      <Text
        className="max-w-[60%] shrink-0 text-base font-ryco-medium text-foreground"
        numberOfLines={1}
      >
        {item.type === "skill" && item.label.startsWith("skill:") ? (
          <>
            <Text className="text-foreground-muted">skill:</Text>
            {item.skill.name}
          </>
        ) : (
          item.label
        )}
      </Text>
      {item.description ? (
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
          {item.description}
        </Text>
      ) : null}
    </Pressable>
  );
});

export const ComposerCommandPopover = memo(function ComposerCommandPopover(props: {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly triggerKind: ComposerTriggerKind | null;
  readonly isLoading: boolean;
  readonly onSelect: (item: ComposerCommandItem) => void;
}) {
  const label = groupLabel(props.triggerKind);
  return (
    <GlassSurface radius={16} glassEffectStyle="regular">
      {label ? (
        <View className="px-3.5 pt-2.5 pb-1">
          <Text className="text-2xs font-ryco-bold tracking-[0.8px] uppercase text-foreground-muted">
            {label}
          </Text>
        </View>
      ) : null}
      {props.items.length > 0 ? (
        <ScrollView
          style={{ maxHeight: 220 }}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          {props.items.map((item, index) => (
            <CommandRow
              key={item.id}
              item={item}
              isLast={index === props.items.length - 1}
              onPress={() => props.onSelect(item)}
            />
          ))}
        </ScrollView>
      ) : (
        <View className="px-3.5 py-2.5">
          <Text className="text-xs text-foreground-tertiary">
            {emptyText(props.triggerKind, props.isLoading)}
          </Text>
        </View>
      )}
    </GlassSurface>
  );
});
