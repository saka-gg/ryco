import type { StaticScreenProps } from "@react-navigation/native";

import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";

import { CopyProjectScreen } from "./CopyProjectScreen";

type CopyProjectRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  /** Preselects the destination ("Copy here" on a machine without the project). */
  readonly targetEnvironmentId?: string;
  /** Shows a copy that is already running. */
  readonly copyId?: string;
  /** Starts a copy whose upload stopped when the app closed again, with its ids. */
  readonly resumeCopyId?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function CopyProjectRouteScreen(props: CopyProjectRouteScreenProps) {
  const params = props.route.params;
  const environmentId = firstParam(params.environmentId);
  const projectId = firstParam(params.projectId);
  if (!environmentId || !projectId) return null;
  const target = firstParam(params.targetEnvironmentId);
  return (
    <CopyProjectScreen
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
      targetEnvironmentId={target ? EnvironmentId.make(target) : null}
      copyId={firstParam(params.copyId)}
      resumeCopyId={firstParam(params.resumeCopyId)}
    />
  );
}
