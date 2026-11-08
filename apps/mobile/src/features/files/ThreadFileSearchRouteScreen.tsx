import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  createWorkspaceContentSearch,
  groupContentSearchMatches,
  relativePathToRouteSegments,
  selectProjectContentSearchSupported,
  type ContentSearchFileGroup,
} from "@ryco/client-runtime/state/files";
import type { ProjectContentMatch } from "@ryco/contracts";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { firstRouteParam } from "../../lib/routeParams";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { cn } from "../../lib/cn";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { ToolTextField } from "../sourceControl/gitToolsParts";
import { previewRuns } from "./fileEditModel";
import { useThreadWorkspaceCwd } from "./useThreadWorkspaceRoot";

type ThreadFileSearchRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const IDLE_SEARCH = {
  getSnapshot: () => null,
  subscribe: () => () => {},
};

type Row =
  | { readonly kind: "file"; readonly key: string; readonly group: ContentSearchFileGroup }
  | {
      readonly kind: "match";
      readonly key: string;
      readonly match: ProjectContentMatch;
    };

function rowsOf(groups: ReadonlyArray<ContentSearchFileGroup>): Row[] {
  return groups.flatMap((group) => [
    { kind: "file" as const, key: `f:${group.path}`, group },
    ...group.matches.map((match) => ({
      kind: "match" as const,
      key: `m:${group.path}:${match.lineNumber}:${match.preview.length}`,
      match,
    })),
  ]);
}

function OptionChip(props: {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ checked: props.on }}
      onPress={props.onPress}
      className={cn(
        "h-9 min-w-10 items-center justify-center rounded-full px-3 active:opacity-70",
        props.on ? "bg-primary" : "bg-subtle-strong",
      )}
    >
      <Text
        className={cn(
          "font-mono text-[13px]",
          props.on ? "text-primary-foreground" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * Find in files across the thread's workspace (`projects.searchContent`):
 * matches grouped by file, the matching text highlighted, a tap opens the file
 * at that line. Paging, debounce and cancellation are the shared controller's.
 */
export function ThreadFileSearchRouteScreen(props: ThreadFileSearchRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(firstRouteParam(props.route.params.environmentId) ?? "");
  const threadId = ThreadId.make(firstRouteParam(props.route.params.threadId) ?? "");
  const cwd = useThreadWorkspaceCwd(environmentId, threadId);
  const configs = useEnvironmentServerConfigs();
  const supported = selectProjectContentSearchSupported(configs.get(environmentId) ?? null);
  const [query, setQuery] = useState("");

  const search = useMemo(() => {
    if (!cwd || !supported) return null;
    return createWorkspaceContentSearch({
      cwd,
      search: (request, options) =>
        ensureEnvironmentApi(environmentId).projects.searchContent(request, options),
    });
  }, [cwd, environmentId, supported]);
  useEffect(() => () => search?.dispose(), [search]);
  const source = search ?? IDLE_SEARCH;
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const rows = useMemo(
    () => (snapshot ? rowsOf(groupContentSearchMatches(snapshot.matches)) : []),
    [snapshot],
  );

  const onChangeQuery = (value: string) => {
    setQuery(value);
    search?.setQuery(value);
  };

  if (!supported) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Find in files unavailable"
          detail="Update Ryco on this machine to search file contents from the phone."
        />
      </View>
    );
  }

  const status = snapshot ? snapshot.status : "idle";
  const footer =
    status === "tooShort"
      ? "Type at least two characters."
      : snapshot?.partial
        ? "Only part of this workspace was searched."
        : snapshot?.capped
          ? "Showing the first 2,000 matches."
          : null;

  return (
    <View className="flex-1 bg-screen">
      <View className="gap-2 px-4 pb-2 pt-3">
        <ToolTextField
          mono
          value={query}
          onChangeText={onChangeQuery}
          placeholder="Find in files"
          accessibilityLabel="Find in files"
          returnKeyType="search"
          autoFocus
        />
        <View className="flex-row items-center gap-2">
          <OptionChip
            label="Aa"
            accessibilityLabel="Match case"
            on={snapshot?.options.caseSensitive === true}
            onPress={() =>
              search?.setOptions({ caseSensitive: snapshot?.options.caseSensitive !== true })
            }
          />
          <OptionChip
            label="ab"
            accessibilityLabel="Whole word"
            on={snapshot?.options.wholeWord === true}
            onPress={() => search?.setOptions({ wholeWord: snapshot?.options.wholeWord !== true })}
          />
          <Text className="flex-1 text-right text-[12px] text-foreground-muted">
            {status === "searching"
              ? "Searching…"
              : status === "ready"
                ? `${snapshot?.matches.length ?? 0}${snapshot?.hasMore ? "+" : ""} matches`
                : ""}
          </Text>
        </View>
        {snapshot?.error ? (
          <Pressable onPress={() => search?.retry()}>
            <ErrorBanner message={`${snapshot.error.message} Tap to retry.`} />
          </Pressable>
        ) : null}
      </View>
      <LegendList
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={44}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onEndReached={() => search?.loadMore()}
        contentContainerStyle={{ paddingBottom: 48 }}
        renderItem={({ item }) =>
          item.kind === "file" ? (
            <View className="flex-row items-baseline gap-2 px-4 pb-1 pt-4">
              <Text className="font-mono text-[13px] font-ryco-bold text-foreground">
                {item.group.name}
              </Text>
              {item.group.parentPath ? (
                <Text
                  className="flex-1 font-mono text-[11px] text-foreground-tertiary"
                  numberOfLines={1}
                >
                  {item.group.parentPath}
                </Text>
              ) : null}
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.match.path} line ${item.match.lineNumber}: ${item.match.preview}`}
              onPress={() =>
                navigation.navigate("ThreadFile", {
                  environmentId,
                  threadId,
                  path: relativePathToRouteSegments(item.match.path),
                  line: String(item.match.lineNumber),
                })
              }
              className="mx-4 flex-row gap-3 rounded-xl px-2 py-1.5 active:bg-subtle"
            >
              <Text className="w-9 text-right font-mono text-[11px] leading-5 text-foreground-tertiary">
                {item.match.lineNumber}
              </Text>
              <Text
                className="flex-1 font-mono text-[12px] leading-5 text-foreground"
                numberOfLines={2}
              >
                {previewRuns(item.match.preview, item.match.ranges).map((run, index) => (
                  <Text
                    // Runs are positional within one preview.
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    className={cn(
                      "font-mono text-[12px]",
                      run.match ? "bg-warning-bg text-foreground" : "text-foreground",
                    )}
                  >
                    {run.text}
                  </Text>
                ))}
              </Text>
            </Pressable>
          )
        }
        ListEmptyComponent={
          status === "ready" ? (
            <EmptyState
              variant="plain"
              title="No matches"
              detail="Nothing in this workspace matches."
            />
          ) : null
        }
        ListFooterComponent={
          snapshot?.stoppedEarly ? (
            <Pressable onPress={() => search?.keepSearching()} className="items-center py-4">
              <Text className="text-[13px] font-ryco-bold text-accent">Keep searching</Text>
            </Pressable>
          ) : footer ? (
            <Text className="px-4 py-4 text-center text-[12px] text-foreground-muted">
              {footer}
            </Text>
          ) : null
        }
      />
    </View>
  );
}
