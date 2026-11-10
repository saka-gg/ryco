// A project's workspace inspection and disk usage, as the project settings
// screen last read them, kept on the device (saved mirrors): the screen reads
// them by its own rules (`useProjectWorkspaceData`) and shows the saved
// answers, marked as refreshing, until the machine answers again.
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  WorkspaceDiskUsageResult,
  WorkspaceLifecycleSummary,
} from "@ryco/contracts/workspace-lifecycle";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import * as Schema from "effect/Schema";

import { createMobileQueryCache } from "./mobileQueryCache";
import { schemaSavedQueryCodec } from "./savedQueryCodec";

const projectSettingsCache = createMobileQueryCache("project-settings");

export interface ProjectInput {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}

const project = {
  retainedKeyLimit: 4,
  isEnabled: (input: ProjectInput) => input.environmentId !== null && input.projectId !== null,
  buildKey: (input: ProjectInput) => `${input.environmentId}${KEY_SEP}${input.projectId}`,
  resolveEnvironmentId: (input: ProjectInput) => input.environmentId as EnvironmentId,
} as const;

export const projectWorkspacesMirror = projectSettingsCache.defineSavedMirror<
  ProjectInput,
  ReadonlyArray<WorkspaceLifecycleSummary>
>({
  ...project,
  label: "workspaces",
  persist: schemaSavedQueryCodec(Schema.Array(WorkspaceLifecycleSummary), 1),
});

export const projectDiskUsageMirror = projectSettingsCache.defineSavedMirror<
  ProjectInput,
  WorkspaceDiskUsageResult["workspaces"]
>({
  ...project,
  label: "disk-usage",
  persist: schemaSavedQueryCodec(WorkspaceDiskUsageResult.fields.workspaces, 1),
});
