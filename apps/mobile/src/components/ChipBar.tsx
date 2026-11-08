import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "./AppText";

export interface ChipBarItem {
  readonly key: string;
  readonly label: string;
  /** Shown after the label; null or absent shows none. */
  readonly count?: number | null;
  readonly selected: boolean;
  readonly accessibilityLabel?: string;
}

/**
 * A row of filter chips that scrolls sideways: the selected one is filled, the
 * others quiet. Chats' status chips and Search's scopes use it.
 */
export function ChipBar(props: {
  readonly items: ReadonlyArray<ChipBarItem>;
  readonly onSelect: (key: string) => void;
  readonly accessibilityLabel: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={props.accessibilityLabel}
      contentContainerStyle={CHIP_BAR_CONTENT}
      keyboardShouldPersistTaps="handled"
    >
      {props.items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="tab"
          accessibilityLabel={item.accessibilityLabel ?? item.label}
          accessibilityState={{ selected: item.selected }}
          hitSlop={4}
          onPress={() => props.onSelect(item.key)}
          className={`h-8 flex-row items-center gap-1.5 rounded-full px-3.5 ${
            item.selected ? "bg-primary" : "bg-subtle-strong active:opacity-70"
          }`}
        >
          <Text
            className={`text-[13px] ${
              item.selected
                ? "font-ryco-bold text-primary-foreground"
                : "font-ryco-medium text-foreground-secondary"
            }`}
          >
            {item.label}
          </Text>
          {item.count !== undefined && item.count !== null ? (
            <View
              className={`min-w-5 items-center rounded-full px-1.5 ${
                item.selected ? "bg-primary-foreground/15" : "bg-subtle"
              }`}
            >
              <Text
                className={`text-[11px] font-ryco-bold ${
                  item.selected ? "text-primary-foreground" : "text-foreground-muted"
                }`}
                style={TABULAR}
              >
                {item.count}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  );
}

const CHIP_BAR_CONTENT = { paddingHorizontal: 16, gap: 8, paddingVertical: 2 } as const;
const TABULAR = { fontVariant: ["tabular-nums" as const] };
