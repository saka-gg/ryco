import {
  DEFAULT_PROJECT_METADATA_DIR,
  type AgentControlCreateProjectPlan,
  type AgentControlProjectState,
  type AgentControlProjectTarget,
  type AgentControlRemoveProjectPlan,
  type AgentControlUpdateProjectPlan,
  type OrchestrationProjectShell,
} from "@ryco/contracts";
import { Effect, Layer } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import {
  AgentControlProjectPlans,
  type AgentControlProjectPlan,
  type AgentControlProjectPlansShape,
} from "../Services/AgentControlProjectPlans.ts";

const fail = (
  reason: ConstructorParameters<typeof AgentControlPlanValidationError>[0]["reason"],
  detail: string,
) => Effect.fail(new AgentControlPlanValidationError({ reason, detail }));

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const makeAgentControlProjectPlans = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const workspaceAccess = yield* WorkspaceAccessPolicy;
  const workspacePaths = yield* WorkspacePaths;
  const repositoryIdentity = yield* RepositoryIdentityResolver;

  const canonicalizeExistingRoot = (workspaceRoot: string) =>
    workspaceAccess
      .assertExistingPath({ path: workspaceRoot, operation: "Agent Control project" })
      .pipe(
        Effect.flatMap((authorizedRoot) => workspacePaths.normalizeWorkspaceRoot(authorizedRoot)),
        Effect.mapError(
          () =>
            new AgentControlPlanValidationError({
              reason: "invalid-plan",
              detail: "The project workspace must be an existing authorized directory.",
            }),
        ),
      );

  const identityKey = (workspaceRoot: string) =>
    repositoryIdentity.resolve(workspaceRoot).pipe(
      Effect.map((identity) => identity?.canonicalKey ?? null),
      Effect.mapError(
        () =>
          new AgentControlPlanValidationError({
            reason: "invalid-plan",
            detail: "The project repository identity could not be verified.",
          }),
      ),
    );

  const stateFor = (project: OrchestrationProjectShell): AgentControlProjectState => ({
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    repositoryIdentityKey: project.repositoryIdentity?.canonicalKey ?? null,
    updatedAt: project.updatedAt,
    defaultModelSelection: project.defaultModelSelection,
    customSystemPrompt: project.customSystemPrompt,
    scripts: project.scripts,
    preferredRemoteName: project.preferredRemoteName,
  });

  const targetFor = (input: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly repositoryIdentityKey: string | null;
  }): AgentControlProjectTarget => ({
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    repositoryIdentityKey: input.repositoryIdentityKey,
  });

  const requireProject = (projectId: string) =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        () =>
          new AgentControlPlanValidationError({
            reason: "project-unavailable",
            detail: "Current project state is unavailable.",
          }),
      ),
      Effect.flatMap((snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        return project
          ? Effect.succeed({ project, snapshot })
          : fail("project-unavailable", "The requested project is unavailable.");
      }),
    );

  const assertRootAvailable = (input: {
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
    readonly workspaceRoot: string;
    readonly exceptProjectId?: string | undefined;
  }) =>
    input.projects.some(
      (project) =>
        project.id !== input.exceptProjectId && project.workspaceRoot === input.workspaceRoot,
    )
      ? fail("invalid-plan", "Another active project already uses this workspace directory.")
      : Effect.void;

  const prepareCreate: AgentControlProjectPlansShape["prepareCreate"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new AgentControlPlanValidationError({
              reason: "project-unavailable",
              detail: "Current project state is unavailable.",
            }),
        ),
      );
      if (snapshot.projects.some((project) => project.id === input.projectId)) {
        return yield* fail("project-stale", "The requested project identifier is already in use.");
      }
      const workspaceRoot = yield* canonicalizeExistingRoot(input.workspaceRoot);
      yield* assertRootAvailable({ projects: snapshot.projects, workspaceRoot });
      const repositoryIdentityKey = yield* identityKey(workspaceRoot);
      return {
        kind: "createProject",
        projectId: input.projectId,
        title: input.title,
        workspaceRoot,
        projectMetadataDir: DEFAULT_PROJECT_METADATA_DIR,
        repositoryIdentityKey,
      } satisfies AgentControlCreateProjectPlan;
    });

  const prepareUpdate: AgentControlProjectPlansShape["prepareUpdate"] = (input) =>
    Effect.gen(function* () {
      if (
        [
          input.title,
          input.workspaceRoot,
          input.defaultModelSelection,
          input.customSystemPrompt,
          input.scripts,
          input.preferredRemoteName,
        ].every((value) => value === undefined)
      ) {
        return yield* fail("invalid-plan", "At least one supported project update is required.");
      }
      const { project, snapshot } = yield* requireProject(input.projectId);
      if (project.updatedAt !== input.expectedUpdatedAt) {
        return yield* fail("project-stale", "The project changed after the caller read it.");
      }
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? project.workspaceRoot
          : yield* canonicalizeExistingRoot(input.workspaceRoot);
      yield* assertRootAvailable({
        projects: snapshot.projects,
        workspaceRoot,
        exceptProjectId: project.id,
      });
      const title = input.title ?? project.title;
      const preferences = {
        defaultModelSelection:
          input.defaultModelSelection === undefined
            ? project.defaultModelSelection
            : input.defaultModelSelection,
        customSystemPrompt:
          input.customSystemPrompt === undefined
            ? project.customSystemPrompt
            : input.customSystemPrompt,
        scripts: input.scripts ?? project.scripts,
        preferredRemoteName:
          input.preferredRemoteName === undefined
            ? project.preferredRemoteName
            : input.preferredRemoteName,
      };
      if (
        title === project.title &&
        workspaceRoot === project.workspaceRoot &&
        Object.entries(preferences).every(
          ([key, value]) =>
            JSON.stringify(value) === JSON.stringify(project[key as keyof typeof project]),
        )
      ) {
        return yield* fail("invalid-plan", "The requested project metadata is unchanged.");
      }
      const repositoryIdentityKey = yield* identityKey(workspaceRoot);
      return {
        kind: "updateProject",
        projectId: project.id,
        before: stateFor(project),
        after: { ...targetFor({ title, workspaceRoot, repositoryIdentityKey }), ...preferences },
      } satisfies AgentControlUpdateProjectPlan;
    });

  const prepareRemove: AgentControlProjectPlansShape["prepareRemove"] = (input) =>
    Effect.gen(function* () {
      const { project, snapshot } = yield* requireProject(input.projectId);
      if (project.updatedAt !== input.expectedUpdatedAt) {
        return yield* fail("project-stale", "The project changed after the caller read it.");
      }
      const expectedThreadIds = snapshot.threads
        .filter((thread) => thread.projectId === project.id)
        .map((thread) => thread.id)
        .toSorted();
      const force = input.force === true;
      if (expectedThreadIds.length > 0 && !force) {
        return yield* fail(
          "invalid-plan",
          "The project has thread records; force must be explicit to remove them.",
        );
      }
      return {
        kind: "removeProject",
        projectId: project.id,
        expected: stateFor(project),
        expectedThreadIds,
        force,
      } satisfies AgentControlRemoveProjectPlan;
    });

  const revalidate: AgentControlProjectPlansShape["revalidate"] = (plan: AgentControlProjectPlan) =>
    Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot().pipe(
        Effect.mapError(
          () =>
            new AgentControlPlanValidationError({
              reason: "project-unavailable",
              detail: "Current project state is unavailable.",
            }),
        ),
      );
      const current = snapshot.projects.find((project) => project.id === plan.projectId);

      if (plan.kind === "createProject") {
        if (current) {
          return yield* fail("project-stale", "The approved project identifier is now in use.");
        }
        const workspaceRoot = yield* canonicalizeExistingRoot(plan.workspaceRoot);
        if (workspaceRoot !== plan.workspaceRoot) {
          return yield* fail("project-stale", "The approved workspace path changed.");
        }
        yield* assertRootAvailable({ projects: snapshot.projects, workspaceRoot });
        if ((yield* identityKey(workspaceRoot)) !== plan.repositoryIdentityKey) {
          return yield* fail("project-stale", "The approved repository identity changed.");
        }
        return;
      }

      if (!current) {
        return yield* fail("project-unavailable", "The approved project was removed.");
      }
      const expected = plan.kind === "updateProject" ? plan.before : plan.expected;
      const currentState = stateFor(current);
      if (
        currentState.title !== expected.title ||
        currentState.workspaceRoot !== expected.workspaceRoot ||
        currentState.repositoryIdentityKey !== expected.repositoryIdentityKey ||
        currentState.updatedAt !== expected.updatedAt
      ) {
        return yield* fail("project-stale", "The approved project state changed.");
      }
      if ((yield* identityKey(current.workspaceRoot)) !== expected.repositoryIdentityKey) {
        return yield* fail("project-stale", "The approved repository identity changed.");
      }

      if (plan.kind === "updateProject") {
        const workspaceRoot = yield* canonicalizeExistingRoot(plan.after.workspaceRoot);
        if (workspaceRoot !== plan.after.workspaceRoot) {
          return yield* fail("project-stale", "The approved destination path changed.");
        }
        yield* assertRootAvailable({
          projects: snapshot.projects,
          workspaceRoot,
          exceptProjectId: plan.projectId,
        });
        if ((yield* identityKey(workspaceRoot)) !== plan.after.repositoryIdentityKey) {
          return yield* fail("project-stale", "The destination repository identity changed.");
        }
        return;
      }

      const threadIds = snapshot.threads
        .filter((thread) => thread.projectId === plan.projectId)
        .map((thread) => thread.id)
        .toSorted();
      if (!sameStrings(threadIds, plan.expectedThreadIds)) {
        return yield* fail("project-stale", "The project's thread set changed.");
      }
      if (threadIds.length > 0 && !plan.force) {
        return yield* fail("invalid-plan", "The project is no longer empty.");
      }
    });

  return {
    prepareCreate,
    prepareUpdate,
    prepareRemove,
    revalidate,
  } satisfies AgentControlProjectPlansShape;
});

export const AgentControlProjectPlansLive = Layer.effect(
  AgentControlProjectPlans,
  makeAgentControlProjectPlans,
);
