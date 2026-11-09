import type { EnvironmentId } from "@ryco/contracts";
import {
  appendBrowsePathSegment,
  ensureBrowseDirectoryPath,
  formatProjectPath,
  getBrowseParentPath,
  normalizeProjectPathForDispatch,
} from "@ryco/shared/projectPaths";
import { useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import { useNodeRead } from "../projectCopy/useCopyPlanning";

/**
 * Browses folders on a machine (`filesystem.browse`) so a project's folder is
 * picked instead of typed: the current folder, its subfolders, a way up, and a
 * path field to jump. The phone never treats the path as one of its own.
 */
export function FolderBrowser(props: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly initialPath: string;
  readonly homeDirectory: string | null;
  readonly actionLabel: string;
  readonly busy?: boolean;
  readonly onPick: (path: string) => void;
}) {
  const api = useEnvironmentApi(props.environmentId);
  const iconColor = useThemeColor("--color-icon-subtle");
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const [directory, setDirectory] = useState(() => ensureBrowseDirectoryPath(props.initialPath));
  const [draft, setDraft] = useState<string | null>(null);
  const browse = api?.filesystem.browse;
  const listing = useNodeRead(
    browse && directory.length > 0 ? `${props.environmentId}\u0000${directory}` : null,
    browse ? () => browse({ partialPath: directory }) : null,
  );
  const current = normalizeProjectPathForDispatch(directory);
  const parent = getBrowseParentPath(current);
  const entries = listing.data?.entries ?? [];

  const open = (path: string) => {
    setDraft(null);
    setDirectory(ensureBrowseDirectoryPath(path));
  };

  return (
    <View className="gap-3">
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        <View className="flex-row items-center gap-2 px-4 py-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Up one folder"
            disabled={parent === null}
            onPress={() => {
              if (parent !== null) open(parent);
            }}
            className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70 disabled:opacity-30"
          >
            <SymbolView name="chevron.up" size={14} tintColor={iconColor as string} />
          </Pressable>
          {draft === null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Folder ${current}. Type a path`}
              onPress={() => setDraft(current)}
              className="min-w-0 flex-1"
            >
              <Text className="font-mono text-sm text-foreground" numberOfLines={2}>
                {formatProjectPath(current, props.homeDirectory)}
              </Text>
              <Text className="text-xs text-foreground-muted">on {props.machineLabel}</Text>
            </Pressable>
          ) : (
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => {
                if (draft.trim().length > 0) open(draft.trim());
              }}
              returnKeyType="go"
              placeholder="/Users/you/Code"
              placeholderTextColor={placeholderColor as string}
              className="min-h-9 min-w-0 flex-1 rounded-lg border border-border bg-card-alt px-2 font-mono text-sm"
              style={{ color: textColor as string }}
            />
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={props.busy === true || browse === undefined}
        onPress={() => props.onPick(current)}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">
          {props.busy ? "Working…" : props.actionLabel}
        </Text>
      </Pressable>
      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        {listing.loading ? (
          <View className="items-center py-6">
            <ActivityIndicator />
          </View>
        ) : listing.error ? (
          <Text className="px-4 py-4 font-sans text-sm text-danger-foreground">
            {listing.error}
          </Text>
        ) : entries.length === 0 ? (
          <Text className="px-4 py-4 font-sans text-sm text-foreground-muted">
            No folders inside.
          </Text>
        ) : (
          entries.map((entry, index) => (
            <Pressable
              key={entry.fullPath}
              accessibilityRole="button"
              onPress={() =>
                open(
                  entry.isAlias ? entry.fullPath : appendBrowsePathSegment(directory, entry.name),
                )
              }
              className={`flex-row items-center gap-3 px-4 py-3 active:bg-subtle ${
                index === 0 ? "" : "border-t border-border-subtle"
              }`}
            >
              <SymbolView name="folder" size={17} tintColor={iconColor as string} />
              <Text
                className="min-w-0 flex-1 font-sans text-[16px] text-foreground"
                numberOfLines={1}
              >
                {entry.name}
              </Text>
              <SymbolView name="chevron.right" size={13} tintColor={iconColor as string} />
            </Pressable>
          ))
        )}
      </View>
    </View>
  );
}
