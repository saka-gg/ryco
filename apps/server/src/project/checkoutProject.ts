import { Effect, Option } from "effect";
import type { ProjectId } from "@ryco/contracts";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProjectionWorktree,
  ProjectionWorktreeRepositoryShape,
} from "../persistence/Services/ProjectionWorktrees.ts";

export interface CheckoutProject {
  readonly projectId: ProjectId;
  /** The workspace checked out at the path; null for the project's own root. */
  readonly checkout: ProjectionWorktree | null;
}

/**
 * The project a checkout path speaks for: the active project rooted there, else the active
 * workspace checked out there. Null for any other path. Lookup failures read as no project.
 * Callers pass a server-side path; a project id from a client is never trusted instead.
 */
export const resolveCheckoutProject = (input: {
  readonly cwd: string;
  readonly projects: Pick<ProjectionSnapshotQueryShape, "getActiveProjectByWorkspaceRoot">;
  readonly worktrees: Pick<ProjectionWorktreeRepositoryShape, "findActiveByWorktreePath">;
}): Effect.Effect<CheckoutProject | null> =>
  Effect.gen(function* () {
    const project = yield* input.projects
      .getActiveProjectByWorkspaceRoot(input.cwd)
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    if (Option.isSome(project)) return { projectId: project.value.id, checkout: null };
    const checkout = yield* input.worktrees
      .findActiveByWorktreePath({ worktreePath: input.cwd })
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    return Option.isSome(checkout)
      ? { projectId: checkout.value.projectId, checkout: checkout.value }
      : null;
  });
