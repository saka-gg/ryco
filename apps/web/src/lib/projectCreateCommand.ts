import type { ProjectId } from "@ryco/contracts";

import { inferProjectTitleFromPath } from "./projectPaths";
import { newCommandId } from "./utils";

/**
 * The `project.create` command the web app sends for a folder on a node, named
 * after the folder. The project picker may create a missing folder; project
 * import only links folders that exist. The node checks the folder against its
 * workspace access policy either way.
 */
export function buildProjectCreateCommand(input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing: boolean;
}) {
  return {
    type: "project.create" as const,
    commandId: newCommandId(),
    projectId: input.projectId,
    title: inferProjectTitleFromPath(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    projectMetadataDir: ".ryco",
    createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
    createdAt: new Date().toISOString(),
  };
}
