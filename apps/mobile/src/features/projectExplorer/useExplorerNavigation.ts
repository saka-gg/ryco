import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

/** The explorer's routes; params are strings, as links deliver them. */
export type ProjectExplorerRouteName =
  | "ProjectExplorer"
  | "ProjectIssue"
  | "ProjectNewIssue"
  | "ProjectWorkflowRun"
  | "ProjectWorkItem";

/**
 * Moves between the explorer's screens. The one place that names their routes:
 * `navigate` is typed by the root stack, which registers them separately, so
 * the call is widened here rather than at every press.
 */
export function useExplorerNavigation(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const navigation = useNavigation();
  const go = (name: ProjectExplorerRouteName, params: Readonly<Record<string, string>>) => {
    if (environmentId === null || projectId === null) return;
    // The cast keeps `navigation` as `this` (the parentheses only group the member access).
    (navigation.navigate as unknown as (screen: string, params: object) => void)(name, {
      environmentId,
      projectId,
      ...params,
    });
  };
  return {
    navigation,
    openIssue: (number: number) => go("ProjectIssue", { number: String(number) }),
    openNewIssue: () => go("ProjectNewIssue", {}),
    openWorkflowRun: (runId: string) => go("ProjectWorkflowRun", { runId }),
    openWorkItem: (key: string) => go("ProjectWorkItem", { key }),
    openPullRequest: (number: number) => {
      if (environmentId === null || projectId === null) return;
      navigation.navigate("ProjectPullRequest", {
        environmentId,
        projectId,
        number: String(number),
      });
    },
  };
}
