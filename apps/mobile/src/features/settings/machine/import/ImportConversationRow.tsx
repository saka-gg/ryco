import type { ConversationImportItemView } from "@ryco/client-runtime/state/sessionImport";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import { cn } from "../../../../lib/cn";
import { useThemeColor } from "../../../../lib/useThemeColor";

const STATUS_CLASS: Record<ConversationImportItemView["tone"], string> = {
  success: "text-success",
  warning: "text-warning",
  muted: "text-foreground-muted",
};

function SmallButton(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "h-8 justify-center rounded-full px-3.5 active:opacity-70",
        props.primary ? "bg-primary" : "bg-card-alt",
        props.disabled && "opacity-40",
      )}
    >
      <Text
        className={cn(
          "text-[13px] font-ryco-bold",
          props.primary ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * One found conversation: a check to select it, where it ran and how long it is, its import
 * status, and for a quarantined one the recovery the web offers: inspect the copies the machine
 * already holds a page at a time, and adopt the one copy it proves.
 */
export function ImportConversationRow(props: {
  readonly row: ConversationImportItemView;
  readonly first: boolean;
  /** Another request is running or access is missing: nothing on the row takes a tap. */
  readonly locked: boolean;
  readonly onToggle: () => void;
  readonly onInspect: () => void;
  readonly onInspectNextPage: () => void;
  readonly onAdopt: () => void;
}) {
  const { row } = props;
  const { item, recovery } = row;
  const primary = useThemeColor("--color-primary") as string;
  const canToggle = !props.locked && row.selectable;
  return (
    <View className={cn("px-4 py-3", !props.first && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Select ${item.title}`}
        accessibilityState={{ checked: row.selected, disabled: !canToggle }}
        disabled={!canToggle}
        onPress={props.onToggle}
        className="flex-row gap-3 active:opacity-70"
      >
        <View
          className={cn("h-6 w-6 items-center justify-center", !row.selectable && "opacity-40")}
        >
          {row.selected ? (
            <SymbolView
              name={{ ios: "checkmark.circle.fill", android: "check" }}
              size={22}
              tintColor={primary}
            />
          ) : (
            <View className="h-[22px] w-[22px] rounded-full border-[1.5px] border-border" />
          )}
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 shrink text-[16px] text-foreground" numberOfLines={2}>
              {item.title}
            </Text>
            {item.archived ? (
              <Text className="rounded-md bg-subtle px-1.5 py-0.5 text-[11px] text-foreground-muted">
                Archived
              </Text>
            ) : null}
          </View>
          <Text
            className="mt-0.5 text-xs leading-4 text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {`${item.cwd || "Original folder unknown"} · ${item.messageCount} messages`}
          </Text>
          {row.status ? (
            <Text className={cn("mt-1 text-xs leading-4", STATUS_CLASS[row.tone])}>
              {row.status}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {item.quarantined ? (
        <View className="mt-2.5 gap-2 pl-9">
          {recovery ? (
            <View className="gap-1">
              <Text className="text-xs leading-4 text-foreground-muted">{recovery.notice}</Text>
              {recovery.candidates.map((copy) => (
                <Text
                  key={copy.id}
                  className="font-mono text-[11px] text-foreground-muted"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {`Copy ${copy.id} · ${copy.messageCount} messages`}
                </Text>
              ))}
            </View>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            <SmallButton
              label="Inspect existing copies"
              disabled={props.locked}
              onPress={props.onInspect}
            />
            {row.canInspectNextPage ? (
              <SmallButton
                label="Inspect next page"
                disabled={props.locked}
                onPress={props.onInspectNextPage}
              />
            ) : null}
            {row.canAdopt ? (
              <SmallButton
                label="Adopt proven copy"
                primary
                disabled={props.locked}
                onPress={props.onAdopt}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
