import type { StaticScreenProps } from "@react-navigation/native";

import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";

import { ProjectDetailScreen } from "./ProjectDetailScreen";

type ProjectRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ProjectRouteScreen(props: ProjectRouteScreenProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  if (!environmentIdRaw || !projectIdRaw) return null;

  return (
    <ProjectDetailScreen
      environmentId={EnvironmentId.make(environmentIdRaw)}
      projectId={ProjectId.make(projectIdRaw)}
    />
  );
}
