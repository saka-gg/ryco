import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import type { AgentControlAutomationId, EnvironmentId, ProjectId } from "@ryco/contracts";

type Navigation = Pick<NavigationProp<ParamListBase>, "navigate">;

/** Every schedule, or one machine's or one project's (the Tasks tab's filter). */
export function openScheduledList(
  navigation: Navigation,
  filter: { readonly environmentId: EnvironmentId | null; readonly projectId: ProjectId | null },
): void {
  navigation.navigate("Scheduled", {
    ...(filter.environmentId ? { environmentId: filter.environmentId } : {}),
    ...(filter.environmentId && filter.projectId ? { projectId: filter.projectId } : {}),
  });
}

export interface ScheduleRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly automationId: AgentControlAutomationId;
}

export function openSchedule(navigation: Navigation, ref: ScheduleRef): void {
  navigation.navigate("ScheduleDetail", ref);
}

/**
 * The editor: a new schedule in a project, a change to one, or an expired proposal proposed
 * again ("repropose").
 */
export function openScheduleEditor(
  navigation: Navigation,
  input:
    | { readonly mode: "new"; readonly environmentId: EnvironmentId; readonly projectId: ProjectId }
    | (ScheduleRef & { readonly mode: "edit" | "repropose" }),
): void {
  navigation.navigate("ScheduleEditor", {
    environmentId: input.environmentId,
    projectId: input.projectId,
    mode: input.mode,
    ...(input.mode === "new" ? {} : { automationId: input.automationId }),
  });
}
