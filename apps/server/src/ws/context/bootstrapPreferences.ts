import path from "node:path";
import type { ThreadTurnStartBootstrap } from "@ryco/contracts";
import { Effect, Option } from "effect";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerSettingsShape } from "../../serverSettings.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  resolveProjectPreferences,
  resolveThreadCreationPreferences,
} from "../../project/projectPreferences.ts";

/** Read and authorize once before bootstrap mutation; caller model choices remain explicit. */
export const resolveBootstrapPreferences = (input: {
  readonly bootstrap: ThreadTurnStartBootstrap | undefined;
  readonly settings: Pick<ServerSettingsShape, "getSettings">;
  readonly projects: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getActiveProjectByWorkspaceRoot"
  >;
  readonly workspaceAccess: Pick<WorkspaceAccessPolicyShape, "assertExistingPath">;
}) =>
  Effect.gen(function* () {
    const { bootstrap } = input;
    const settings = yield* input.settings.getSettings;
    const projectId = bootstrap?.createThread?.projectId;
    const cwd = bootstrap?.prepareWorktree?.projectCwd;
    const project = projectId
      ? yield* input.projects.getProjectShellById(projectId).pipe(Effect.map(Option.getOrNull))
      : cwd
        ? yield* input.projects
            .getActiveProjectByWorkspaceRoot(cwd)
            .pipe(Effect.map(Option.getOrNull))
        : null;
    if ((bootstrap?.createThread || bootstrap?.prepareWorktree) && !project)
      return yield* Effect.fail(new Error("Project is unavailable for thread creation."));
    if (projectId && project?.id !== projectId)
      return yield* Effect.fail(new Error("Worktree must belong to the selected node project."));
    if (cwd && project) {
      const authorize = (path: string) =>
        input.workspaceAccess.assertExistingPath({
          path,
          operation: "git.bootstrapPrepareWorktree",
        });
      const authorizedRoot = yield* authorize(project.workspaceRoot);
      const authorizedCwd = cwd === project.workspaceRoot ? authorizedRoot : yield* authorize(cwd);
      if (path.resolve(authorizedRoot) !== path.resolve(authorizedCwd))
        return yield* Effect.fail(
          new Error("Worktree workspace does not match the selected project."),
        );
    }
    const choices = resolveThreadCreationPreferences({
      effective: resolveProjectPreferences({ settings, ...(project ? { project } : {}) }),
      ...(bootstrap?.createThread ? { modelSelection: bootstrap.createThread.modelSelection } : {}),
      ...(bootstrap?.runSetupScript === undefined
        ? {}
        : { runSetupScript: bootstrap.runSetupScript }),
    });
    return {
      settings,
      project,
      choices,
      // Existing checkouts keep their established opt-in setup behavior.
      runSetupScript:
        bootstrap?.runSetupScript ?? (bootstrap?.prepareWorktree ? choices.runSetupScript : false),
    };
  });
