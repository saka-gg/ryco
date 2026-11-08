import { Pressable, View } from "react-native";

import { cn } from "../lib/cn";
import { AppText as Text } from "./AppText";

/**
 * A compact single-choice switch between a few views of the same content
 * (Unstaged · Staged, Issues · Actions · Jira). Each segment can carry a count.
 */
export function SegmentedControl<T extends string>(props: {
  readonly value: T;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly count?: number | null;
  }>;
  readonly onChange: (value: T) => void;
  readonly className?: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      className={cn("flex-row rounded-full bg-subtle-strong p-1", props.className)}
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              option.count != null ? `${option.label}, ${option.count}` : option.label
            }
            onPress={() => props.onChange(option.value)}
            className={cn(
              "min-h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-full px-3",
              selected ? "bg-card" : "active:opacity-70",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-ryco-bold",
                selected ? "text-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {option.label}
            </Text>
            {option.count != null ? (
              <Text className="text-[12px] font-ryco-medium text-foreground-tertiary">
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
