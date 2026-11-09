import { type StaticScreenProps } from "@react-navigation/native";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { useLayoutEffect, useState } from "react";
import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { useHomeWorkspaceData } from "../../state/homeData";
import { usePullRequestCheckout } from "../pullRequests/usePullRequestData";
import { ActionsTab } from "./ActionsTab";
import { IssuesTab } from "./IssuesTab";
import { JiraTab } from "./JiraTab";
import {
  explorerScopeFromParams,
  parseProjectExplorerTab,
  PROJECT_EXPLORER_TABS,
  type ProjectExplorerTab,
} from "./projectExplorerModel";
import { SegmentedControl } from "../../components/SegmentedControl";
import { HeaderPlusButton } from "./ProjectExplorerParts";
import { useExplorerChange } from "./useExplorerChange";
import { useExplorerNavigation } from "./useExplorerNavigation";

type ProjectExplorerRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly tab?: string;
}>;

/**
 * One project's explorer: its issues, workflow runs and Jira work items, as
 * the desktop's project explorer shows them, one tab at a time.
 */
export function ProjectExplorerRouteScreen(props: ProjectExplorerRouteProps) {
  const { environmentId, projectId } = explorerScopeFromParams(props.route.params);
  const [tab, setTab] = useState<ProjectExplorerTab>(() =>
    parseProjectExplorerTab(props.route.params.tab),
  );
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const { projects } = useHomeWorkspaceData();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const projectTitle = project?.name ?? null;
  const explorer = useExplorerNavigation(environmentId, projectId);
  const { navigation, openNewIssue } = explorer;
  const change = useExplorerChange(environmentId);
  const canCreateIssue =
    tab === "issues" &&
    checkout.cwd !== null &&
    change.offer(WS_METHODS.sourceControlCreateIssue).offered;

  useLayoutEffect(() => {
    navigation.setOptions({
      ...(projectTitle ? { title: projectTitle } : {}),
      headerRight: canCreateIssue
        ? () => <HeaderPlusButton accessibilityLabel="New issue" onPress={openNewIssue} />
        : undefined,
    });
  }, [canCreateIssue, navigation, openNewIssue, projectTitle]);

  if (environmentId === null || projectId === null || checkout.cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Project unavailable"
          detail="The selected node has not published this project yet."
        />
      </View>
    );
  }

  const header = (
    <SegmentedControl
      className="mx-4"
      options={PROJECT_EXPLORER_TABS}
      value={tab}
      onChange={setTab}
    />
  );
  switch (tab) {
    case "issues":
      return (
        <IssuesTab
          environmentId={environmentId}
          projectId={projectId}
          cwd={checkout.cwd}
          header={header}
        />
      );
    case "actions":
      return (
        <ActionsTab
          environmentId={environmentId}
          projectId={projectId}
          cwd={checkout.cwd}
          header={header}
        />
      );
    case "jira":
      return <JiraTab environmentId={environmentId} projectId={projectId} header={header} />;
  }
}
