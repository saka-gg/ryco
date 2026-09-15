import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useProjectMemoryController } from "./useProjectMemoryController";
import { ProjectMemoryPanel } from "./ProjectMemoryPanel";
export function ProjectMemorySettings({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const controller = useProjectMemoryController(environmentId, projectId, String(projectId));
  return controller ? (
    <ProjectMemoryPanel key={`${environmentId}:${projectId}`} controller={controller} />
  ) : null;
}
