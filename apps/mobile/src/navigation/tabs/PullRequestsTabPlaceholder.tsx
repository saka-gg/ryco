import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProjectsScreen } from "../../features/projects/ProjectsScreen";
import { buildProjectRows, type ProjectListRow } from "../../features/projects/projectsModel";
import { useInboxSource } from "../../features/home/useInboxSource";
import { resolveHomeGroupingMode } from "../../state/homeGrouping";
import { usePreferences } from "../../state/preferencesStore";
import { MAIN_TABS } from "./mainTabsModel";
import {
  TabLargeTitle,
  useLargeTitleCollapse,
  useTabContentInsets,
  useTabStackHeader,
} from "./TabScreenChrome";

/**
 * The PRs tab until the cross-repository pull request list lands
 * (`features/pullRequests`' `PullRequestsTabScreen` replaces this in
 * `lazyRouteScreens.ts`): pick a project to see its pull requests.
 */
export function PullRequestsTabScreen() {
  const navigation = useNavigation();
  const [nowMs] = useState(Date.now);
  const { environments, projects, worktrees, threads } = useInboxSource(nowMs);
  const preferences = usePreferences();
  const rows = useMemo(
    () =>
      buildProjectRows({
        projects,
        worktrees,
        threads,
        environments,
        groupingMode: resolveHomeGroupingMode(preferences.projectGroupingEnabled),
      }),
    [environments, preferences.projectGroupingEnabled, projects, threads, worktrees],
  );
  const { collapsed, onScroll } = useLargeTitleCollapse();
  const contentInsets = useTabContentInsets();
  useTabStackHeader({ title: collapsed ? MAIN_TABS.PullRequests.title : "" });
  const openPullRequests = (row: ProjectListRow) =>
    navigation.navigate("ProjectPullRequests", {
      environmentId: row.open.environmentId,
      projectId: row.open.projectId,
    });
  return (
    <ProjectsScreen
      rows={rows}
      hasMachines={environments.length > 0}
      listHeader={
        <View>
          <TabLargeTitle title={MAIN_TABS.PullRequests.title} />
          <Text className="px-4 pb-3 font-sans text-sm text-foreground-muted">
            Choose a project to see its pull requests.
          </Text>
        </View>
      }
      showAddProject={false}
      contentInsets={contentInsets}
      onScroll={onScroll}
      onOpenProject={openPullRequests}
      onAddProject={() => navigation.navigate("AddProject")}
      onAddMachine={() => navigation.navigate("Connections")}
    />
  );
}
