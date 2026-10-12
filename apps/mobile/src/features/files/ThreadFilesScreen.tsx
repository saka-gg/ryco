import { useHeaderHeight } from "@react-navigation/elements";
import { StackActions, useNavigation } from "@react-navigation/native";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  normalizeWorkspaceFileSearchQuery,
  relativePathToRouteSegments,
  workspaceAncestorPaths,
  type VisibleWorkspaceFileTreeRow,
  type WorkspaceFileSearchRow,
} from "@ryco/client-runtime/state/files";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NavigationHeaderButton } from "../../components/NavigationHeaderButton";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { useProjectListEntries, useProjectSearchEntries } from "../../rpc/useProjectFiles";
import {
  useWsConnectionStatusForEnvironment,
  wsUiStateForEnvironment,
} from "../../rpc/wsConnectionState";
import { useHomeWorkspaceData } from "../../state/homeData";
import {
  selectEnvironmentState,
  selectProjectByRef,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";
import { findThreadWorktree } from "../threads/threadHeaderModel";
import { useFileWorkspaceLayout } from "./FileWorkspaceLayout";
import { buildThreadFilesScreenModel } from "./threadFilesModel";
import { useThreadWorkspaceRoot } from "./useThreadWorkspaceRoot";

// Read-only browser over the thread's checkout. Everything that decides WHAT to
// render lives in threadFilesModel; this file owns only the React Native surface
// and the two pieces of local state the model reads back — the search box and
// the expansion set.

const ROW_INDENT_BASE = 8;
const ROW_INDENT_PER_DEPTH = 18;

function TreeRow(props: {
  readonly row: VisibleWorkspaceFileTreeRow;
  readonly expanded: boolean;
  readonly iconColor: string;
  readonly mutedIconColor: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const { node } = props.row;
  const isDirectory = node.kind === "directory";

  return (
    <Pressable
      accessibilityRole="button"
      // The row shows only the name; the full path is what a screen reader needs
      // to place it.
      accessibilityLabel={node.path}
      accessibilityState={{
        ...(isDirectory ? { expanded: props.expanded } : {}),
        selected: props.selected,
      }}
      onPress={props.onPress}
      className={cn(
        "min-h-[42px] flex-row items-center gap-2 pr-4 active:bg-subtle-strong",
        props.selected && "bg-subtle-strong",
      )}
      style={{ paddingLeft: ROW_INDENT_BASE + props.row.depth * ROW_INDENT_PER_DEPTH }}
    >
      <View className="w-3.5 items-center">
        {isDirectory ? (
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={11}
            tintColor={props.mutedIconColor}
            type="monochrome"
          />
        ) : null}
      </View>
      <SymbolView
        name={isDirectory ? "folder" : "doc.text"}
        size={15}
        tintColor={isDirectory ? props.iconColor : props.mutedIconColor}
        type="monochrome"
      />
      <Text className="min-w-0 flex-1 font-sans text-[15px] text-foreground" numberOfLines={1}>
        {node.name}
      </Text>
      {isDirectory ? (
        <Text className="text-2xs font-ryco-medium text-foreground-tertiary">
          {node.children.length}
        </Text>
      ) : null}
    </Pressable>
  );
}

function SearchRow(props: {
  readonly row: WorkspaceFileSearchRow;
  readonly iconColor: string;
  readonly mutedIconColor: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const isDirectory = props.row.kind === "directory";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.row.path}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "min-h-[52px] flex-row items-center gap-2.5 px-4 py-2 active:bg-subtle-strong",
        props.selected && "bg-subtle-strong",
      )}
    >
      <SymbolView
        name={isDirectory ? "folder" : "doc.text"}
        size={15}
        tintColor={isDirectory ? props.iconColor : props.mutedIconColor}
        type="monochrome"
      />
      <View className="min-w-0 flex-1">
        <Text className="font-sans text-[15px] text-foreground" numberOfLines={1}>
          {props.row.name}
        </Text>
        {props.row.parentPath ? (
          <Text
            className="font-mono text-2xs text-foreground-tertiary"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {props.row.parentPath}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Inline, non-blocking counterpart of the home screen's connection row. */
function OfflineNotice() {
  const iconColor = String(useThemeColor("--color-icon-muted"));
  return (
    <View
      accessibilityRole="alert"
      className="mx-4 mb-2 flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-2.5"
    >
      <SymbolView name="wifi.slash" size={14} tintColor={iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-xs text-foreground-muted">
        Showing the last listing from this node. Pull to refresh once it is back.
      </Text>
    </View>
  );
}

function ListNote(props: { readonly children: string }) {
  return (
    <Text className="px-5 py-4 text-center font-sans text-xs text-foreground-tertiary">
      {props.children}
    </Text>
  );
}

export function ThreadFilesScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly presentation?: "screen" | "inspector";
  readonly selectedPath?: string | null;
}) {
  const { environmentId, threadId } = props;
  const presentation = props.presentation ?? "screen";
  const selectedPath = props.selectedPath ?? null;
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const { inspector } = useFileWorkspaceLayout();
  const hasPersistentFileInspector = inspector.supported;
  const iconColor = String(useThemeColor("--color-icon"));
  const mutedIconColor = String(useThemeColor("--color-icon-muted"));
  const placeholderColor = String(useThemeColor("--color-placeholder"));
  const textColor = String(useThemeColor("--color-foreground"));

  // A cold deep link must drive the supervisor onto this node, exactly as the
  // thread screen does.
  useEffect(() => {
    useStore.getState().setActiveEnvironmentId(environmentId);
  }, [environmentId]);

  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const project = useStore((state) =>
    thread
      ? (selectProjectByRef(state, scopeProjectRef(environmentId, thread.projectId)) ?? null)
      : null,
  );
  // Read THIS route's environment, not the active one: on a cross-environment
  // deep link the mount effect above flips the active id only after the first
  // render, and the previously active node's completed bootstrap must not turn
  // "still syncing" into a premature no-workspace verdict.
  const bootstrapComplete = useStore(
    (state) => selectEnvironmentState(state, environmentId).bootstrapComplete,
  );
  const { worktrees } = useHomeWorkspaceData();
  const worktree = useMemo(
    () => (thread ? findThreadWorktree(thread, worktrees) : null),
    [thread, worktrees],
  );
  const workspaceRoot = useThreadWorkspaceRoot({ thread, worktree, project });
  // This screen renders one environment's content; its connection banner and
  // gating must track THAT node's socket, not whichever socket wrote the
  // global status last.
  const connectionUiState = wsUiStateForEnvironment(
    useWsConnectionStatusForEnvironment(environmentId),
  );

  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeWorkspaceFileSearchQuery(query);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const entries = useProjectListEntries({ environmentId, cwd: workspaceRoot });
  const search = useProjectSearchEntries({ environmentId, cwd: workspaceRoot, query });

  const model = useMemo(
    () =>
      buildThreadFilesScreenModel({
        bootstrapComplete,
        thread: thread ?? null,
        project,
        worktree,
        entriesState: {
          data: entries.data,
          error: entries.error,
          isLoading: entries.isLoading,
        },
        searchState: {
          data: search.data,
          error: search.error,
          isLoading: search.isLoading,
          isDebouncing: search.isDebouncing,
        },
        normalizedQuery,
        expanded,
        connectionUiState,
      }),
    [
      bootstrapComplete,
      connectionUiState,
      entries.data,
      entries.error,
      entries.isLoading,
      expanded,
      normalizedQuery,
      project,
      search.data,
      search.error,
      search.isDebouncing,
      search.isLoading,
      thread,
      worktree,
    ],
  );

  // Seed the top-level directories once per workspace, and only into an empty
  // set: a background refetch must never re-open what the user collapsed.
  const seededRootRef = useRef<string | null>(null);
  const treeDefaultExpanded = model.state === "tree" ? model.defaultExpanded : null;
  useEffect(() => {
    if (treeDefaultExpanded === null || seededRootRef.current === workspaceRoot) return;
    seededRootRef.current = workspaceRoot;
    setExpanded((current) => (current.size === 0 ? treeDefaultExpanded : current));
  }, [treeDefaultExpanded, workspaceRoot]);

  const goToThread = useCallback(
    () => navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId })),
    [environmentId, navigation, threadId],
  );

  // A deep link straight to this route has nothing beneath it, so the native
  // back button never appears; the thread is where "back" belongs.
  useLayoutEffect(() => {
    if (presentation === "inspector") return;
    navigation.setOptions({
      // ThreadFiles renders the task itself while the regular-width inspector
      // is active. Restore the route's own chrome when a resize brings the
      // compact browser back on this SAME route.
      title: "Files",
      headerRight: undefined,
      headerLeft: () => (
        <NavigationHeaderButton
          action="back"
          accessibilityLabel="Back to task"
          onPress={() => (navigation.canGoBack() ? navigation.goBack() : goToThread())}
        />
      ),
    });
  }, [goToThread, iconColor, navigation, presentation]);

  const closeInspector = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    goToThread();
  }, [goToThread, navigation]);

  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Pull-to-refresh reloads whichever view the user is actually looking at.
  const isSearching = normalizedQuery.length > 0;
  const entriesRefetch = entries.refetch;
  const searchRefetch = search.refetch;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void (isSearching ? searchRefetch() : entriesRefetch()).finally(() => {
      if (mountedRef.current) setRefreshing(false);
    });
  }, [entriesRefetch, isSearching, searchRefetch]);

  const openFile = useCallback(
    (path: string) => {
      const params = { environmentId, threadId, path: relativePathToRouteSegments(path) };
      if (
        resolveFileSelectionNavigationAction({
          hasPersistentFileInspector,
        }) === "replace"
      ) {
        // Once a file route already owns the inspector, navigating to the same
        // route updates its params in place and preserves the one-step return
        // to chat. The initial browser -> file transition replaces the browser.
        if (selectedPath !== null) {
          navigation.navigate("ThreadFile", params);
          return;
        }
        navigation.dispatch(StackActions.replace("ThreadFile", params));
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [environmentId, hasPersistentFileInspector, navigation, selectedPath, threadId],
  );

  // A deep selected file must stay reachable even when only top-level folders
  // were expanded before this route replaced the browser.
  useEffect(() => {
    if (selectedPath === null) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const ancestor of workspaceAncestorPaths(selectedPath)) {
        if (next.has(ancestor)) continue;
        next.add(ancestor);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [selectedPath]);

  const toggleDirectory = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  // A directory result is a place, not a file: open it in the tree and drop the
  // query so the user lands where the match was.
  const revealDirectory = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const ancestor of workspaceAncestorPaths(path)) next.add(ancestor);
      next.add(path);
      return next;
    });
    setQuery("");
  }, []);

  const renderTreeRow = ({ item }: LegendListRenderItemProps<VisibleWorkspaceFileTreeRow>) => (
    <TreeRow
      row={item}
      expanded={expanded.has(item.node.path)}
      iconColor={iconColor}
      mutedIconColor={mutedIconColor}
      selected={item.node.path === selectedPath}
      onPress={() =>
        item.node.kind === "directory" ? toggleDirectory(item.node.path) : openFile(item.node.path)
      }
    />
  );

  const renderSearchRow = ({ item }: LegendListRenderItemProps<WorkspaceFileSearchRow>) => (
    <SearchRow
      row={item}
      iconColor={iconColor}
      mutedIconColor={mutedIconColor}
      selected={item.path === selectedPath}
      onPress={() => (item.kind === "directory" ? revealDirectory(item.path) : openFile(item.path))}
    />
  );

  // A local function rather than a component: it closes over the row renderers
  // and the refresh handler, and lifting it out would only turn that into prop
  // plumbing.
  function renderBody() {
    switch (model.state) {
      case "loading":
        return (
          <View className="px-4 py-16">
            <EmptyState
              variant="plain"
              title="Loading files"
              detail="Reading the workspace listing from the node."
            />
          </View>
        );
      case "no-workspace":
        return (
          <View className="px-4 py-16">
            <EmptyState
              variant="plain"
              title="No workspace"
              detail="This task has no checkout on the node yet, so there is nothing to browse."
            />
          </View>
        );
      case "offline-empty":
        return (
          <View className="px-4 py-16">
            <EmptyState
              variant="plain"
              title="Node unreachable"
              detail="Nothing is cached for this workspace. Try again once the node is back."
              actionLabel="Try again"
              onAction={refresh}
            />
          </View>
        );
      case "error":
        return (
          <View className="gap-3 px-4 py-8">
            <ErrorBanner message={model.message} />
            {model.canRetry ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try again"
                onPress={refresh}
                className="self-start rounded-full bg-primary px-4 py-2.5 active:opacity-70"
              >
                <Text className="text-sm font-ryco-bold text-primary-foreground">Try again</Text>
              </Pressable>
            ) : null}
          </View>
        );
      case "empty":
        return (
          <View className="px-4 py-16">
            <EmptyState
              variant="plain"
              title="Empty workspace"
              detail="The node listed no files in this checkout."
            />
          </View>
        );
      case "search":
        return (
          <LegendList
            // A distinct identity per view: the search and tree lists sit at the
            // same JSX position, and updating one LegendList in place with the
            // OTHER view's row shape makes its recycler probe stale indices —
            // keyExtractor then sees undefined rows (crashed in QA on clearing
            // the search box). Remounting on the switch is the robust boundary.
            key="search-rows"
            data={model.rows}
            renderItem={renderSearchRow}
            keyExtractor={(row, index) => row?.path ?? `search-${index}`}
            recycleItems
            refreshing={refreshing}
            onRefresh={refresh}
            contentInsetAdjustmentBehavior="never"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ paddingBottom: 32 }}
            ListEmptyComponent={
              <ListNote>
                {model.searching ? "Searching the workspace…" : "No files match that search."}
              </ListNote>
            }
            ListFooterComponent={
              model.truncated ? (
                <ListNote>Showing the first matches only. Narrow the search to see more.</ListNote>
              ) : null
            }
          />
        );
      case "tree":
        return (
          <LegendList
            key="tree-rows"
            data={model.rows}
            renderItem={renderTreeRow}
            keyExtractor={(row, index) => row?.node.path ?? `tree-${index}`}
            recycleItems
            refreshing={refreshing}
            onRefresh={refresh}
            contentInsetAdjustmentBehavior="never"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ paddingBottom: 32 }}
            ListFooterComponent={
              model.truncated ? (
                <ListNote>
                  {`The node truncated this listing — showing ${model.fileCount} files. Search to reach the rest.`}
                </ListNote>
              ) : null
            }
          />
        );
    }
  }

  return (
    <View className="flex-1 bg-screen">
      {presentation === "inspector" ? (
        <View
          className="justify-end border-b border-border-subtle px-3 pb-1"
          style={{ height: headerHeight }}
        >
          <View className="h-11 flex-row items-center justify-between">
            <Text className="font-sans text-base font-ryco-bold text-foreground">Files</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close files"
              onPress={closeInspector}
              className="h-10 w-10 items-center justify-center rounded-full active:bg-subtle-strong"
            >
              <SymbolView name="xmark" size={16} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ height: headerHeight }} />
      )}
      <View className="mx-4 mb-2 mt-2 flex-row items-center rounded-2xl bg-sidebar-search px-3">
        <SymbolView
          name="magnifyingglass"
          size={15}
          tintColor={placeholderColor}
          type="monochrome"
        />
        <TextInput
          accessibilityLabel="Search files"
          value={query}
          onChangeText={setQuery}
          placeholder="Search files"
          placeholderTextColor={placeholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="h-10 flex-1 px-2 font-sans text-sm"
          style={{ color: textColor }}
        />
        {query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={8}
            onPress={() => setQuery("")}
          >
            <SymbolView
              name="xmark.circle.fill"
              size={15}
              tintColor={placeholderColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>

      {(model.state === "tree" || model.state === "search") && model.offlineNotice ? (
        <OfflineNotice />
      ) : null}

      {renderBody()}
    </View>
  );
}
