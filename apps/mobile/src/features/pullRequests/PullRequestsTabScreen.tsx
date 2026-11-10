import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import {
  derivePullRequestsCapabilities,
  PULL_REQUEST_STATE_OPTIONS,
} from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import * as Haptics from "expo-haptics";
import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";

import { SymbolView } from "../../components/AppSymbol";
import { HeaderIconButton } from "../../components/HeaderIconButton";
import { MachinePickerButton } from "../../components/MachinePickerButton";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { cn } from "../../lib/cn";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import { selectProjectsAcrossEnvironments, useStore } from "../../state/threadsRuntime";
import { machinePickerEnvironmentsAmong } from "../home/machinePickerModel";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { PullRequestFilterSheet } from "./PullRequestFilterSheet";
import {
  countPullRequestTabFilters,
  PULL_REQUEST_SEGMENTS,
  pullRequestTabListFilters,
  type PullRequestListItemModel,
  type PullRequestListRow,
  type PullRequestsSegment,
  type PullRequestTabFilters,
} from "./pullRequestListModel";
import {
  pullRequestRepositoryMachineNote,
  type PullRequestRepositoryChoice,
} from "./pullRequestRepositoriesModel";
import {
  PullRequestStackFoot,
  PullRequestTabRow,
  type PullRequestRowAction,
} from "./PullRequestTabRow";
import { selectPullRequestMachine, selectPullRequestRepository } from "./pullRequestTabStateModel";
import { usePullRequestList, useSourceControlProvider } from "./usePullRequestData";
import {
  readablePullRequestConnection,
  usePullRequestTabChoice,
} from "./usePullRequestRepositoryChoices";
import { updatePullRequestTabState, usePullRequestTabState } from "./usePullRequestTabState";

function RepositoryPicker(props: {
  readonly choices: ReadonlyArray<PullRequestRepositoryChoice>;
  readonly selected: PullRequestRepositoryChoice | null;
  readonly onSelect: (key: string) => void;
}) {
  const icon = useThemeColor("--color-icon-muted") as string;
  const machines = new Set(props.choices.map((choice) => choice.environmentId)).size;
  const actions = props.choices.map((choice) => {
    const note = pullRequestRepositoryMachineNote(choice, machines);
    return {
      id: choice.key,
      title: choice.label,
      ...(note !== null ? { subtitle: note } : {}),
      state: choice.key === props.selected?.key ? ("on" as const) : ("off" as const),
    };
  });
  const onPressAction = (event: NativeActionEvent) => props.onSelect(event.nativeEvent.event);
  return (
    <MenuView title="Repository" actions={actions} onPressAction={onPressAction}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Repository ${props.selected?.label ?? "none"}. Change repository.`}
        className="h-10 max-w-60 flex-row items-center gap-1.5 rounded-full bg-subtle px-3.5 active:bg-subtle-strong"
      >
        <Text className="shrink text-sm font-ryco-bold text-foreground" numberOfLines={1}>
          {props.selected?.label ?? "Repository"}
        </Text>
        <SymbolView name="chevron.down" size={11} tintColor={icon} />
      </Pressable>
    </MenuView>
  );
}

function Segments(props: {
  readonly selected: PullRequestsSegment;
  readonly counts: Readonly<Record<PullRequestsSegment, number | null>>;
  readonly allLabel: string;
  readonly involvement: boolean;
  readonly onSelect: (segment: PullRequestsSegment) => void;
}) {
  const segments = props.involvement
    ? PULL_REQUEST_SEGMENTS
    : PULL_REQUEST_SEGMENTS.filter((segment) => segment.value === "all");
  if (segments.length < 2) return null;
  return (
    <View accessibilityRole="tablist" className="mx-4 flex-row rounded-xl bg-subtle p-0.5">
      {segments.map((segment) => {
        const selected = segment.value === props.selected;
        const count = segment.value === "review" ? props.counts.review : null;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(segment.value)}
            className={cn(
              "h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-[10px]",
              selected ? "bg-card" : "active:opacity-70",
            )}
          >
            <Text
              className={cn(
                "text-sm",
                selected ? "font-ryco-bold text-foreground" : "text-foreground-muted",
              )}
            >
              {segment.value === "all" ? props.allLabel : segment.label}
            </Text>
            {count !== null && count > 0 ? (
              <View className="h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1">
                <Text className="text-[11px] font-ryco-bold text-primary-foreground">{count}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function SearchField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const ref = useRef<TextInput>(null);
  const icon = useThemeColor("--color-icon-muted") as string;
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  return (
    <View className="flex-row items-center gap-3 px-4">
      <View className="h-10 flex-1 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
        <SymbolView name="magnifyingglass" size={14} tintColor={icon} />
        <TextInput
          ref={ref}
          autoFocus
          value={props.value}
          onChangeText={props.onChange}
          placeholder="Title, number, branch, author, label"
          placeholderTextColor={placeholder}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          className="h-10 flex-1 font-sans text-base"
          style={{ color: text }}
        />
      </View>
      <Pressable accessibilityRole="button" onPress={props.onCancel} className="active:opacity-60">
        <Text className="text-base text-primary">Cancel</Text>
      </Pressable>
    </View>
  );
}

/** Placeholder rows while the first list read is on its way. */
function LoadingRows() {
  return (
    <View accessible accessibilityLabel="Loading pull requests" className="pt-1">
      {[0, 1, 2, 3, 4].map((index) => (
        <View key={index} className="flex-row gap-3 px-4" style={{ opacity: 1 - index * 0.16 }}>
          <View className="mt-3.5 h-5 w-5 rounded-full bg-subtle" />
          <View className="flex-1 gap-2 border-b border-border-subtle py-3">
            <View className="h-3 w-24 rounded bg-subtle" />
            <View className="h-4 w-11/12 rounded bg-subtle" />
            <View className="h-3 w-1/2 rounded bg-subtle" />
          </View>
        </View>
      ))}
    </View>
  );
}

export interface PullRequestsListScreenProps {
  /**
   * `tab`: the PRs tab's root (no navigation header; picks among every
   * repository). `route`: one project's list pushed under a header.
   */
  readonly variant: "tab" | "route";
  readonly fixedProject?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  };
}

/**
 * The phone's pull requests for one repository at a time: Mine, To review
 * and All, ranked like the web's list (most urgent first, stacks as units),
 * with the host's checks, review verdict and diff size on every row.
 */
export function PullRequestsListScreen(props: PullRequestsListScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const tabChoice = usePullRequestTabChoice();
  const { choices } = tabChoice;
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const environments = useHomeEnvironments();
  const pickerEnvironments = useMemo(
    () => machinePickerEnvironmentsAmong(environments, tabChoice.machineIds),
    [environments, tabChoice.machineIds],
  );
  const tabState = usePullRequestTabState();
  const tabStateLoaded = tabChoice.loaded;
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mutedIcon = useThemeColor("--color-icon-muted") as string;

  const fixed = props.fixedProject;
  const fixedProject =
    fixed === undefined
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === fixed.environmentId && project.id === fixed.projectId,
        ) ?? null);
  const choice: PullRequestRepositoryChoice | null =
    fixed === undefined
      ? tabChoice.choice
      : fixedProject === null
        ? null
        : {
            key: fixedProject.repositoryIdentity?.canonicalKey ?? fixedProject.cwd,
            label: fixedProject.name,
            provider: fixedProject.repositoryIdentity?.provider ?? null,
            environmentId: fixedProject.environmentId,
            projectId: fixedProject.id,
            cwd: fixedProject.cwd,
            environmentLabel: null,
            checkouts: 1,
            machines: 1,
            connected: environments.some(
              (environment) =>
                environment.environmentId === fixedProject.environmentId &&
                readablePullRequestConnection(environment.connectionState),
            ),
            canAct: environments.some(
              (environment) =>
                environment.environmentId === fixedProject.environmentId &&
                environment.mutationReady &&
                environment.role !== "viewer",
            ),
          };
  const environmentId = choice?.environmentId ?? null;
  const cwd = choice?.cwd ?? null;
  const machine = environments.find((environment) => environment.environmentId === environmentId);
  const provider = useSourceControlProvider(environmentId, cwd);
  const filters: PullRequestTabFilters = {
    ...tabState.filters,
    ...(searching && query.trim().length > 0 ? { q: query } : {}),
  };
  const list = usePullRequestList({
    environmentId,
    cwd,
    provider,
    filters: pullRequestTabListFilters(filters),
    failingOnly: filters.failingOnly,
    hideDrafts: filters.hideDrafts,
  });
  const { screen } = list;
  const capabilities = derivePullRequestsCapabilities(provider);
  const activeFilters = countPullRequestTabFilters(filters);
  const stateLabel =
    PULL_REQUEST_STATE_OPTIONS.find((option) => option.value === (filters.state ?? "open"))
      ?.label ?? "Open";
  const allLabel = filters.state === "all" ? "All" : `All ${stateLabel.toLowerCase()}`;

  const selectSegment = (segment: PullRequestsSegment) => {
    if (segment === filters.segment) return;
    void Haptics.selectionAsync();
    updatePullRequestTabState((state) => ({
      ...state,
      filters: { ...state.filters, segment },
    }));
  };
  const selectRepository = (key: string) => {
    void Haptics.selectionAsync();
    updatePullRequestTabState((state) => selectPullRequestRepository(state, key));
  };
  const selectMachine = (environmentId: EnvironmentId | null) =>
    updatePullRequestTabState((state) => selectPullRequestMachine(state, environmentId));
  const patchFilters = (patch: Partial<PullRequestTabFilters>) =>
    updatePullRequestTabState((state) => {
      const next: Record<string, unknown> = { ...state.filters, ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return { ...state, filters: next as unknown as PullRequestTabFilters };
    });
  const resetFilters = () =>
    updatePullRequestTabState((state) => ({
      ...state,
      filters: { segment: state.filters.segment },
    }));
  const openPullRequest = (row: PullRequestListRow) => {
    if (choice === null) return;
    navigation.navigate("ProjectPullRequest", {
      environmentId: choice.environmentId,
      projectId: choice.projectId,
      number: String(row.number),
    });
  };
  const onRowAction = (row: PullRequestListRow, action: PullRequestRowAction) => {
    switch (action) {
      case "open-host":
        openWebLink(row.url);
        return;
      case "copy-link":
        copyTextWithHaptic(row.url, { target: "pull request link" });
        return;
      case "copy-branch":
        copyTextWithHaptic(row.headRefName, { target: "branch name" });
        return;
    }
  };

  const offline = choice !== null && !choice.connected;
  const readOnly = choice !== null && choice.connected && !choice.canAct;
  const header = (
    <View
      className="gap-3 pb-2"
      style={props.variant === "tab" ? { paddingTop: insets.top + 6 } : { paddingTop: 8 }}
    >
      {searching ? (
        <SearchField
          value={query}
          onChange={setQuery}
          onCancel={() => {
            setSearching(false);
            setQuery("");
          }}
        />
      ) : (
        <View className="flex-row items-center gap-2 px-4">
          {props.variant === "tab" && pickerEnvironments.length > 0 ? (
            <MachinePickerButton
              environments={pickerEnvironments}
              selected={tabChoice.environmentId}
              title="Show pull requests from"
              onSelect={selectMachine}
              onManage={() => navigation.navigate("Connections")}
            />
          ) : null}
          <View className="flex-1" />
          <HeaderIconButton
            icon="magnifyingglass"
            accessibilityLabel="Search pull requests"
            filled
            onPress={() => setSearching(true)}
          />
          <HeaderIconButton
            icon="line.3.horizontal.decrease"
            accessibilityLabel="Filters"
            badge={activeFilters}
            filled
            onPress={() => setFiltersOpen(true)}
          />
        </View>
      )}
      {props.variant === "tab" && !searching ? (
        <View className="gap-2">
          <Text className="px-4 text-[32px] leading-[38px] font-ryco-bold text-foreground">
            Pull requests
          </Text>
          {choices.length > 0 ? (
            <View className="flex-row px-4">
              <RepositoryPicker choices={choices} selected={choice} onSelect={selectRepository} />
            </View>
          ) : null}
        </View>
      ) : null}
      <Segments
        selected={screen.involvementSupported ? filters.segment : "all"}
        counts={screen.segmentCounts}
        allLabel={allLabel}
        involvement={screen.involvementSupported}
        onSelect={selectSegment}
      />
      {offline ? (
        <View className="mx-4 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5">
          <SymbolView name="wifi.slash" size={14} tintColor={mutedIcon} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {machine?.label ?? "This machine"} is offline.
            {screen.status === "ready" ? " These are the last pull requests read." : ""}
          </Text>
        </View>
      ) : null}
      {readOnly && machine?.role === "viewer" ? (
        <View className="mx-4 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5">
          <SymbolView name="eye" size={14} tintColor={mutedIcon} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            You can read pull requests on {machine.label}, but not review or merge them there.
          </Text>
        </View>
      ) : null}
      {screen.error !== null && screen.status !== "error" && !offline ? (
        <View className="px-4">
          <ErrorBanner message={screen.error} />
        </View>
      ) : null}
      {screen.paused ? (
        <Text className="px-5 text-xs text-foreground-muted">
          The host is rate limiting this account; these are the last pull requests read.
        </Text>
      ) : null}
    </View>
  );

  const empty =
    choice !== null && screen.status === "loading" && !offline ? (
      <LoadingRows />
    ) : choice === null ? (
      <EmptyState
        variant="plain"
        title={tabStateLoaded || fixed !== undefined ? "No repositories" : "Loading…"}
        detail={
          tabStateLoaded || fixed !== undefined
            ? "Pull requests show up here for projects whose checkout has a remote on GitHub or another host."
            : ""
        }
      />
    ) : offline && screen.status !== "ready" ? (
      <EmptyState
        variant="plain"
        title="Machine offline"
        detail={`Reconnect ${machine?.label ?? "this machine"} to read its pull requests.`}
      />
    ) : screen.status === "error" ? (
      <EmptyState
        variant="card"
        title="Pull requests could not be read"
        detail={screen.error ?? "Pull to try again."}
      />
    ) : screen.status === "empty" ? (
      <EmptyState
        variant="plain"
        title={searching && query.trim().length > 0 ? "No results" : screen.emptyTitle}
        detail={
          searching && query.trim().length > 0
            ? "No loaded pull request matches the search."
            : filters.segment === "review"
              ? "Nobody is waiting for your review here."
              : filters.segment === "mine"
                ? "You have no pull requests here."
                : screen.emptyDetail
        }
        {...(activeFilters > 0 ? { actionLabel: "Reset filters", onAction: resetFilters } : {})}
      />
    ) : null;

  return (
    <View className="flex-1 bg-screen">
      <FlatList<PullRequestListItemModel>
        className="flex-1"
        contentInsetAdjustmentBehavior={props.variant === "route" ? "automatic" : "never"}
        data={screen.items}
        keyExtractor={(item) => item.key}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        renderItem={({ item }) => {
          switch (item.kind) {
            case "heading":
              return (
                <View className="flex-row items-baseline gap-2 px-4 pb-1 pt-4">
                  <Text className="text-sm font-ryco-bold text-foreground">{item.title}</Text>
                  <Text className="text-xs text-foreground-tertiary">{item.count}</Text>
                </View>
              );
            case "row":
              return (
                <PullRequestTabRow
                  row={item.row}
                  spine={item.spine}
                  onPress={openPullRequest}
                  onAction={onRowAction}
                />
              );
            case "foot":
              return <PullRequestStackFoot baseRefName={item.baseRefName} parts={item.parts} />;
          }
        }}
        ListEmptyComponent={
          empty === null ? null : screen.status === "loading" && !offline && choice !== null ? (
            empty
          ) : (
            <View className="px-6 py-14">{empty}</View>
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={list.refreshing}
            onRefresh={list.refresh}
            progressViewOffset={props.variant === "tab" ? insets.top : undefined}
          />
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
      />
      <PullRequestFilterSheet
        visible={filtersOpen}
        filters={filters}
        labels={screen.labels}
        checkRollup={capabilities.listCheckRollup}
        onChange={patchFilters}
        onReset={resetFilters}
        onClose={() => setFiltersOpen(false)}
      />
    </View>
  );
}

/** The PRs tab's root screen. Mount it without a navigation header. */
export function PullRequestsTabScreen() {
  return <PullRequestsListScreen variant="tab" />;
}
