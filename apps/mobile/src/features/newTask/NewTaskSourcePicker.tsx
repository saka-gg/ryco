import type { DraftWorktreeSource } from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NEW_TASK_SOURCE_KINDS, type NewTaskSourceKind } from "./newTaskSourceModel";
import { useNewTaskSourceRows } from "./useNewTaskSourceRows";

/**
 * Start from a branch, pull request, issue or Jira item: a tab per kind, a search field and the
 * node's list. A branch becomes the new worktree's base; anything else gets a worktree the node
 * makes for it when the task is sent.
 */
export function NewTaskSourcePicker(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly initialKind: NewTaskSourceKind;
  readonly onPickBranch: (branch: string) => void;
  readonly onPickSource: (source: DraftWorktreeSource) => void;
}) {
  const [kind, setKind] = useState<NewTaskSourceKind>(props.initialKind);
  const [query, setQuery] = useState("");
  const textColor = useThemeColor("--color-foreground") as string;
  const placeholderColor = useThemeColor("--color-placeholder") as string;
  const iconColor = useThemeColor("--color-icon") as string;
  const state = useNewTaskSourceRows({
    environmentId: props.environmentId,
    projectId: props.projectId,
    cwd: props.cwd,
    kind,
    query,
  });
  const tab = NEW_TASK_SOURCE_KINDS.find((entry) => entry.kind === kind)!;

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-2">
        {NEW_TASK_SOURCE_KINDS.map((entry) => (
          <Pressable
            key={entry.kind}
            accessibilityRole="tab"
            accessibilityState={{ selected: entry.kind === kind }}
            onPress={() => {
              setKind(entry.kind);
              setQuery("");
            }}
            className={cn(
              "h-9 flex-row items-center gap-1.5 rounded-full px-3.5 active:opacity-70",
              entry.kind === kind ? "bg-foreground" : "bg-subtle",
            )}
          >
            <Text
              className={cn(
                "text-sm font-ryco-medium",
                entry.kind === kind ? "text-screen" : "text-foreground",
              )}
            >
              {entry.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel={`Search ${tab.searchPlaceholder.toLowerCase()}`}
        value={query}
        onChangeText={setQuery}
        placeholder={`Search ${tab.searchPlaceholder.toLowerCase()}`}
        placeholderTextColor={placeholderColor}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        className="min-h-12 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
        style={{ color: textColor }}
      />
      {state.loading ? (
        <View className="items-center py-6">
          <ActivityIndicator />
        </View>
      ) : state.error ? (
        <Text className="px-1 text-sm text-foreground-muted">{state.error}</Text>
      ) : state.rows.length === 0 ? (
        <Text className="px-1 text-sm text-foreground-muted">
          {query.trim() ? "Nothing matches that search." : "Nothing open here."}
        </Text>
      ) : (
        <View className="overflow-hidden rounded-2xl bg-card">
          {state.rows.map((row, index) => (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              onPress={() =>
                row.kind === "branch"
                  ? props.onPickBranch(row.branch)
                  : props.onPickSource(row.source)
              }
              className={cn(
                "min-h-12 flex-row items-center gap-3 px-4 py-2.5 active:bg-subtle",
                index === 0 ? "" : "border-t border-border",
              )}
            >
              <SymbolView
                name={tab.icon as never}
                size={15}
                tintColor={iconColor}
                type="monochrome"
              />
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={2}>
                  {row.title}
                </Text>
                {row.detail ? (
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {row.detail}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
