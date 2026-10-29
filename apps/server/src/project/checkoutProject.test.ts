import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { ProjectId } from "@ryco/contracts";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionWorktree } from "../persistence/Services/ProjectionWorktrees.ts";
import { resolveCheckoutProject } from "./checkoutProject.ts";

const projectId = ProjectId.make("project-a");
const worktree = { projectId, worktreePath: "/work/feature" } as unknown as ProjectionWorktree;
const project = { id: projectId, workspaceRoot: "/work/main" };

const lookups = (input: { readonly fail?: boolean } = {}) => ({
  projects: {
    getActiveProjectByWorkspaceRoot: (cwd: string) =>
      input.fail
        ? Effect.fail(new PersistenceSqlError({ operation: "test", detail: "down" }))
        : Effect.succeed(
            cwd === project.workspaceRoot ? Option.some(project as never) : Option.none(),
          ),
  },
  worktrees: {
    findActiveByWorktreePath: ({ worktreePath }: { readonly worktreePath: string }) =>
      input.fail
        ? Effect.fail(new PersistenceSqlError({ operation: "test", detail: "down" }))
        : Effect.succeed(
            worktreePath === worktree.worktreePath ? Option.some(worktree) : Option.none(),
          ),
  },
});

describe("resolveCheckoutProject", () => {
  it.effect("finds the project rooted at the path", () =>
    Effect.gen(function* () {
      expect(yield* resolveCheckoutProject({ cwd: "/work/main", ...lookups() })).toEqual({
        projectId,
        checkout: null,
      });
    }),
  );

  it.effect("finds the project of a workspace checked out at the path", () =>
    Effect.gen(function* () {
      expect(yield* resolveCheckoutProject({ cwd: "/work/feature", ...lookups() })).toEqual({
        projectId,
        checkout: worktree,
      });
    }),
  );

  it.effect("gives null for any other path and when lookups fail", () =>
    Effect.gen(function* () {
      expect(yield* resolveCheckoutProject({ cwd: "/elsewhere", ...lookups() })).toBeNull();
      expect(
        yield* resolveCheckoutProject({ cwd: "/work/feature", ...lookups({ fail: true }) }),
      ).toBeNull();
    }),
  );
});
