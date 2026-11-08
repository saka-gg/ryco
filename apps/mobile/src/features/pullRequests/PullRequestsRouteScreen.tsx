import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { PullRequestsListScreen } from "./PullRequestsTabScreen";

type PullRequestsRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** One project's pull requests, pushed from the project or its source control screen. */
export function PullRequestsRouteScreen(props: PullRequestsRouteProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  if (!environmentIdRaw || !projectIdRaw) {
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
  return (
    <PullRequestsListScreen
      variant="route"
      fixedProject={{
        environmentId: EnvironmentId.make(environmentIdRaw),
        projectId: ProjectId.make(projectIdRaw),
      }}
    />
  );
}
