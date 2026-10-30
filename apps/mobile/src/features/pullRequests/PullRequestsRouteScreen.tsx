import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  PullRequestListFilters,
  PullRequestsOnlyFilter,
  PullRequestsStateFilter,
} from "@ryco/client-runtime/state/pull-request-review";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { useState } from "react";
import { Pressable, RefreshControl, SectionList, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { relativeTime } from "../../lib/time";
import type { PullRequestListRow, PullRequestListSection } from "./pullRequestListModel";
import {
  CheckDot,
  ChipRow,
  FilterChip,
  readinessTextClass,
  SectionTitle,
} from "./PullRequestParts";
import {
  usePullRequestCheckout,
  usePullRequestList,
  useSourceControlProvider,
} from "./usePullRequestData";

type PullRequestsRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function PullRequestRow(props: {
  readonly row: PullRequestListRow;
  readonly onPress: (number: number) => void;
}) {
  const { row } = props;
  const time =
    row.updatedAtMs === null ? null : relativeTime(new Date(row.updatedAtMs).toISOString());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Pull request ${row.number}: ${row.title}. ${row.readinessLabel}.`}
      onPress={() => props.onPress(row.number)}
      className="mx-4 mb-2 rounded-2xl border border-border bg-card px-4 py-3 active:bg-card-alt"
    >
      <View className="flex-row items-start gap-2">
        <Text
          className="min-w-0 flex-1 text-base font-ryco-medium text-foreground"
          numberOfLines={2}
        >
          {row.title}
        </Text>
        {time ? <Text className="pt-0.5 text-xs text-foreground-tertiary">{time}</Text> : null}
      </View>
      <View className="mt-1.5 flex-row items-center gap-2">
        <CheckDot overall={row.checks} />
        <Text className="font-mono text-xs text-foreground-muted">#{row.number}</Text>
        <Text
          className={`shrink text-xs font-ryco-bold ${readinessTextClass(row.readinessTone)}`}
          numberOfLines={1}
        >
          {row.readinessLabel}
        </Text>
        {row.author ? (
          <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
            @{row.author}
          </Text>
        ) : null}
        {row.diffStat ? (
          <Text className="ml-auto font-mono text-2xs text-foreground-tertiary">
            {row.diffStat}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** One repository's pull requests: grouped by involvement, filtered like the web's list. */
export function PullRequestsRouteScreen(props: PullRequestsRouteProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const provider = useSourceControlProvider(environmentId, checkout.cwd);
  const [filters, setFilters] = useState<PullRequestListFilters>({});
  const list = usePullRequestList({ environmentId, cwd: checkout.cwd, provider, filters });
  const { screen } = list;

  const openPullRequest = (number: number) => {
    if (environmentId === null || projectId === null) return;
    navigation.navigate("ProjectPullRequest", {
      environmentId,
      projectId,
      number: String(number),
    });
  };
  const selectState = (state: PullRequestsStateFilter) =>
    setFilters((current) => ({ ...current, state: state === "open" ? undefined : state }));
  const toggleOnly = (only: PullRequestsOnlyFilter) =>
    setFilters((current) => ({ ...current, only: current.only === only ? undefined : only }));
  const selectedState = filters.state ?? "open";

  if (environmentId === null || projectId === null || checkout.cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Repository unavailable"
          detail="The selected node has not published this checkout yet."
        />
      </View>
    );
  }

  const header = (
    <View className="gap-2 pb-2 pt-2">
      <ChipRow>
        {screen.stateOptions.map((option) => (
          <FilterChip
            key={option.value}
            label={option.label}
            selected={selectedState === option.value}
            onPress={() => selectState(option.value)}
          />
        ))}
      </ChipRow>
      {screen.onlyOptions.length > 0 ? (
        <ChipRow>
          {screen.onlyOptions.map((option) => (
            <FilterChip
              key={option.value}
              label={option.label}
              selected={filters.only === option.value}
              onPress={() => toggleOnly(option.value)}
            />
          ))}
        </ChipRow>
      ) : null}
      {screen.status === "loading" ? <LoadingStrip /> : null}
      {screen.error !== null && screen.status !== "error" ? (
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

  return (
    <SectionList<PullRequestListRow, PullRequestListSection>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      sections={screen.sections.map((section) => ({ ...section, data: section.rows }))}
      keyExtractor={(row) => row.key}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={header}
      renderSectionHeader={({ section }) =>
        section.title ? (
          <SectionTitle title={section.title} detail={String(section.rows.length)} />
        ) : null
      }
      renderItem={({ item }) => <PullRequestRow row={item} onPress={openPullRequest} />}
      ListEmptyComponent={
        screen.status === "error" ? (
          <View className="px-4 py-8">
            <EmptyState
              variant="card"
              title="Pull requests could not be read"
              detail={screen.error ?? "Pull to try again."}
            />
          </View>
        ) : screen.status === "empty" ? (
          <View className="px-4 py-8">
            <EmptyState variant="plain" title={screen.emptyTitle} detail={screen.emptyDetail} />
          </View>
        ) : null
      }
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} />}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
