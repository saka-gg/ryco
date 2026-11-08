import type { StaticScreenProps } from "@react-navigation/native";

import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";

import { ProjectSettingsScreen } from "./ProjectSettingsScreen";

type ProjectSettingsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ProjectSettingsRouteScreen(props: ProjectSettingsRouteScreenProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  if (!environmentIdRaw || !projectIdRaw) return null;

  return (
    <ProjectSettingsScreen
      // A checkout picked from the Machines section replaces this one's state entirely.
      key={`${environmentIdRaw}:${projectIdRaw}`}
      environmentId={EnvironmentId.make(environmentIdRaw)}
      projectId={ProjectId.make(projectIdRaw)}
    />
  );
}
