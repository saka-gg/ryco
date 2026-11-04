import { Context } from "effect";
import type { Effect } from "effect";
import type { ProjectId } from "@ryco/contracts";

/**
 * The project ids an avatar file may be named after. The store checks it on every write, read and
 * remove (a project id is otherwise any trimmed string, and it becomes the file name), so no
 * caller can reach outside the avatars directory.
 */
export const PROJECT_AVATAR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface ProjectAvatarStoreShape {
  /** Fails for a project id outside `PROJECT_AVATAR_ID_PATTERN`. */
  readonly write: (input: {
    readonly projectId: ProjectId;
    readonly bytes: Buffer;
    readonly contentType: string;
  }) => Effect.Effect<{ readonly contentHash: string }, ProjectAvatarStoreError>;
  /** Null for a project id outside `PROJECT_AVATAR_ID_PATTERN`. */
  readonly read: (
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly bytes: Buffer; readonly contentHash: string } | null, never>;
  /** Does nothing for a project id outside `PROJECT_AVATAR_ID_PATTERN`. */
  readonly remove: (projectId: ProjectId) => Effect.Effect<void, never>;
}

export class ProjectAvatarStoreError extends Error {
  readonly _tag = "ProjectAvatarStoreError";
}

export const ProjectAvatarStore = Context.Service<ProjectAvatarStoreShape>(
  "@ryco/server/ProjectAvatarStore",
);
