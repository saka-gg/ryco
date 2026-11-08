/**
 * The orchestration commands a project's settings send, built once for every
 * client: one `project.meta.update` carrying only the fields that change, the
 * image reset, and removal from a device.
 */
import type {
  ClientOrchestrationCommand,
  CommandId,
  ProjectId,
  ProjectScript,
} from "@ryco/contracts";

type CommandOf<Type extends ClientOrchestrationCommand["type"]> = Extract<
  ClientOrchestrationCommand,
  { readonly type: Type }
>;

export interface ProjectMetaPatch {
  readonly title?: string;
  readonly workspaceRoot?: string;
  /** Null clears the prompt. */
  readonly customSystemPrompt?: string | null;
  /** Null returns to auto-detecting the primary remote. */
  readonly preferredRemoteName?: string | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

/** One `project.meta.update` carrying only the fields given. */
export function buildProjectMetaUpdateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly patch: ProjectMetaPatch;
}): CommandOf<"project.meta.update"> {
  const { patch } = input;
  return {
    type: "project.meta.update",
    commandId: input.commandId,
    projectId: input.projectId,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.workspaceRoot !== undefined ? { workspaceRoot: patch.workspaceRoot } : {}),
    ...(patch.customSystemPrompt !== undefined
      ? { customSystemPrompt: patch.customSystemPrompt }
      : {}),
    ...(patch.preferredRemoteName !== undefined
      ? { preferredRemoteName: patch.preferredRemoteName }
      : {}),
    ...(patch.scripts !== undefined ? { scripts: [...patch.scripts] } : {}),
  };
}

/** Points the project at an uploaded image, or (null) back to the auto-detected favicon. */
export function buildProjectAvatarSetCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly contentHash: string | null;
}): CommandOf<"project.avatar.set"> {
  return {
    type: "project.avatar.set",
    commandId: input.commandId,
    projectId: input.projectId,
    contentHash: input.contentHash,
  };
}

/**
 * Removes the project from one device. Files on disk are never touched;
 * `force` deletes its threads first (the server refuses otherwise).
 */
export function buildProjectDeleteCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}): CommandOf<"project.delete"> {
  return {
    type: "project.delete",
    commandId: input.commandId,
    projectId: input.projectId,
    ...(input.force === true ? { force: true } : {}),
  };
}
