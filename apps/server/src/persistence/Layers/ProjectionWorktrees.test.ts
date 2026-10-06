import { ProjectId, WorktreeId } from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { runMigrations } from "../Migrations.ts";
import { ProjectionWorktreeRepository } from "../Services/ProjectionWorktrees.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionWorktreeRepositoryLive } from "./ProjectionWorktrees.ts";

const layer = it.layer(
  ProjectionWorktreeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorktreeRepository", (it) => {
  it.effect("upsert + getById round-trips a row", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      const id = WorktreeId.make("worktree-test");
      yield* repo.upsert({
        worktreeId: id,
        projectId: ProjectId.make("project-x"),
        title: null,
        branch: "main",
        worktreePath: null,
        origin: "main",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const row = yield* repo.getById({ worktreeId: id });
      assert.isTrue(Option.isSome(row));
      if (Option.isSome(row)) {
        assert.equal(row.value.branch, "main");
        assert.equal(row.value.origin, "main");
      }
    }),
  );

  it.effect("updateMeta changes the persisted title", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      const id = WorktreeId.make("worktree-title-test");
      yield* repo.upsert({
        worktreeId: id,
        projectId: ProjectId.make("project-x"),
        title: null,
        branch: "main",
        worktreePath: null,
        origin: "main",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      yield* repo.updateMeta({
        worktreeId: id,
        title: "Renamed Worktree",
        updatedAt: "2026-05-08T01:00:00.000Z",
      });

      const row = yield* repo.getById({ worktreeId: id });
      assert.isTrue(Option.isSome(row));
      if (Option.isSome(row)) {
        assert.equal(row.value.title, "Renamed Worktree");
        assert.equal(row.value.updatedAt, "2026-05-08T01:00:00.000Z");
      }
    }),
  );

  it.effect("findByOrigin returns the matching open worktree", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("wt-pr-42"),
        projectId: ProjectId.make("project-x"),
        title: null,
        branch: "feat/x",
        worktreePath: "/tmp/wt",
        origin: "pr",
        prNumber: 42,
        issueNumber: null,
        prTitle: "Add x",
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const found = yield* repo.findByOrigin({
        projectId: ProjectId.make("project-x"),
        kind: "pr",
        number: 42,
      });
      assert.equal(found, "wt-pr-42");
    }),
  );

  it.effect("findByOrigin ignores archived worktrees", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("wt-pr-42-archived"),
        projectId: ProjectId.make("project-archived"),
        title: null,
        branch: "feat/x",
        worktreePath: "/tmp/wt",
        origin: "pr",
        prNumber: 42,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        archivedAt: "2026-05-09T00:00:00.000Z",
        manualPosition: 0,
      });

      const found = yield* repo.findByOrigin({
        projectId: ProjectId.make("project-archived"),
        kind: "pr",
        number: 42,
      });
      assert.isNull(found);
    }),
  );

  it.effect("round-trips pr_state, pr_is_draft, issue_state", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-1"),
        projectId: ProjectId.make("proj"),
        title: "Feature 1",
        branch: "feature/1",
        worktreePath: "/tmp/feature-1",
        origin: "pr",
        prNumber: 123,
        issueNumber: 7,
        prTitle: "Feature 1 PR",
        issueTitle: "Feature 1 issue",
        prState: "merged",
        prIsDraft: false,
        issueState: "closed",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const round = yield* repo.getById({ worktreeId: WorktreeId.make("w-1") });
      assert.isTrue(Option.isSome(round));
      if (Option.isSome(round)) {
        assert.equal(round.value.prState, "merged");
        assert.equal(round.value.prIsDraft, false);
        assert.equal(round.value.issueState, "closed");
      }
    }),
  );

  it.effect("round-trips prIsDraft true", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-draft"),
        projectId: ProjectId.make("proj"),
        title: "Draft PR",
        branch: "feature/draft",
        worktreePath: "/tmp/draft",
        origin: "pr",
        prNumber: 99,
        issueNumber: null,
        prTitle: "Draft PR",
        issueTitle: null,
        prState: "open",
        prIsDraft: true,
        issueState: null,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const round = yield* repo.getById({ worktreeId: WorktreeId.make("w-draft") });
      assert.isTrue(Option.isSome(round));
      if (Option.isSome(round)) {
        assert.equal(round.value.prState, "open");
        assert.equal(round.value.prIsDraft, true);
      }
    }),
  );

  it.effect("round-trips null state fields", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-null"),
        projectId: ProjectId.make("proj"),
        title: null,
        branch: "main",
        worktreePath: null,
        origin: "main",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const round = yield* repo.getById({ worktreeId: WorktreeId.make("w-null") });
      assert.isTrue(Option.isSome(round));
      if (Option.isSome(round)) {
        assert.equal(round.value.prState, null);
        assert.equal(round.value.prIsDraft, null);
        assert.equal(round.value.issueState, null);
      }
    }),
  );

  it.effect("findByWorkItem returns the matching Jira worktree", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-jira-kan-4"),
        projectId: ProjectId.make("proj-jira"),
        title: "SUPER TOLL",
        branch: "KAN-4-super-toll",
        worktreePath: "/tmp/KAN-4-super-toll",
        origin: "issue",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        prState: null,
        prIsDraft: null,
        issueState: null,
        workItemProvider: "jira",
        workItemKey: "KAN-4",
        workItemTitle: "SUPER TOLL",
        workItemState: "open",
        workItemStateName: "Next to come",
        workItemUrl: "https://ryco-app.atlassian.net/browse/KAN-4",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      const found = yield* repo.findByWorkItem({
        projectId: ProjectId.make("proj-jira"),
        provider: "jira",
        key: "KAN-4",
      });
      assert.equal(found, "w-jira-kan-4");
      const round = yield* repo.getById({ worktreeId: WorktreeId.make("w-jira-kan-4") });
      assert.isTrue(Option.isSome(round));
      if (Option.isSome(round)) {
        assert.equal(round.value.workItemState, "open");
        assert.equal(round.value.workItemStateName, "Next to come");
      }
    }),
  );

  it.effect("findActiveByLinkedNumber finds non-archived worktrees by PR number", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-pr-active"),
        projectId: ProjectId.make("proj-a"),
        title: null,
        branch: "feature/pr",
        worktreePath: "/tmp/pr",
        origin: "pr",
        prNumber: 999,
        issueNumber: null,
        prTitle: "PR",
        issueTitle: null,
        prState: "open",
        prIsDraft: false,
        issueState: null,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });

      yield* repo.upsert({
        worktreeId: WorktreeId.make("w-pr-archived"),
        projectId: ProjectId.make("proj-b"),
        title: null,
        branch: "feature/pr-archived",
        worktreePath: "/tmp/pr-archived",
        origin: "pr",
        prNumber: 999,
        issueNumber: null,
        prTitle: "PR archived",
        issueTitle: null,
        prState: "open",
        prIsDraft: false,
        issueState: null,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: "2026-05-17T01:00:00.000Z",
        manualPosition: 0,
      });

      const ids = yield* repo.findActiveByLinkedNumber({
        projectId: ProjectId.make("proj-a"),
        kind: "pr",
        number: 999,
      });
      assert.equal(ids.length, 1);
      assert.equal(ids[0], "w-pr-active");
    }),
  );

  it.effect("findActiveByLinkedNumber returns empty when no match", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;

      const ids = yield* repo.findActiveByLinkedNumber({
        projectId: ProjectId.make("proj-a"),
        kind: "issue",
        number: 12345,
      });
      assert.equal(ids.length, 0);
    }),
  );

  it.effect("round-trips prTerminalAt and keeps it across spread upserts", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 39 });
      const repo = yield* ProjectionWorktreeRepository;
      const base = {
        projectId: ProjectId.make("project-pr-terminal"),
        title: null,
        branch: "feature/pr",
        worktreePath: "/tmp/feature-pr",
        origin: "pr" as const,
        prNumber: 7,
        issueNumber: null,
        prTitle: "PR",
        issueTitle: null,
        prIsDraft: false,
        issueState: null,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T01:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      };

      const mergedId = WorktreeId.make("worktree-pr-terminal-time");
      yield* repo.upsert({
        ...base,
        worktreeId: mergedId,
        prState: "merged",
        prTerminalAt: "2026-05-08T00:30:00.000Z",
      });
      const merged = Option.getOrThrow(yield* repo.getById({ worktreeId: mergedId }));
      assert.equal(merged.prTerminalAt, "2026-05-08T00:30:00.000Z");

      const openId = WorktreeId.make("worktree-pr-terminal-null");
      yield* repo.upsert({ ...base, worktreeId: openId, prState: "open", prTerminalAt: null });
      const open = Option.getOrThrow(yield* repo.getById({ worktreeId: openId }));
      assert.isNull(open.prTerminalAt);

      // NULL-wipe guard: every spread upsert reads through getById first.
      yield* repo.upsert({ ...merged, title: "Renamed" });
      const renamed = Option.getOrThrow(yield* repo.getById({ worktreeId: mergedId }));
      assert.equal(renamed.title, "Renamed");
      assert.equal(renamed.prTerminalAt, "2026-05-08T00:30:00.000Z");

      const listed = yield* repo.listByProjectId({ projectId: base.projectId });
      assert.deepStrictEqual(
        listed.map((row) => [row.worktreeId, row.prTerminalAt]),
        [
          [openId, null],
          [mergedId, "2026-05-08T00:30:00.000Z"],
        ],
      );
    }),
  );

  it.effect("findByOrigin only matches pull requests that are the checkout itself", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repo = yield* ProjectionWorktreeRepository;
      const link = (
        number: number,
        source: "origin" | "manual" | "discovered",
        headRefName: string,
      ) => ({
        number,
        title: `PR ${number}`,
        url: null,
        state: "open" as const,
        isDraft: false,
        terminalAt: null,
        headRefName,
        baseRefName: "main",
        source,
        linkedAt: "2026-10-06T08:00:00.000Z",
        dismissedAt: null,
      });
      yield* repo.upsert({
        worktreeId: WorktreeId.make("wt-pr-10"),
        projectId: ProjectId.make("project-links"),
        title: null,
        branch: "feat-a",
        worktreePath: "/tmp/wt-a",
        origin: "pr",
        // The current link is the related #12, linked by hand.
        prNumber: 12,
        issueNumber: null,
        prTitle: "PR 12",
        issueTitle: null,
        prState: "open",
        prIsDraft: false,
        issueState: null,
        pullRequests: [
          link(10, "origin", "feat-a"),
          link(12, "manual", "feat-b"),
          link(14, "manual", "feat-a"),
        ],
        createdAt: "2026-10-06T07:00:00.000Z",
        updatedAt: "2026-10-06T08:00:00.000Z",
        archivedAt: null,
        manualPosition: 0,
      });
      const find = (number: number) =>
        repo.findByOrigin({ projectId: ProjectId.make("project-links"), kind: "pr", number });

      assert.equal(yield* find(10), "wt-pr-10");
      // Checking out #12 must not land in #10's checkout.
      assert.equal(yield* find(12), null);
      // A manual link on the workspace's own branch is its checkout.
      assert.equal(yield* find(14), "wt-pr-10");
      // Refreshes still reach every workspace that carries #12.
      assert.deepEqual(
        yield* repo.findActiveByLinkedNumber({
          projectId: ProjectId.make("project-links"),
          kind: "pr",
          number: 12,
        }),
        [WorktreeId.make("wt-pr-10")],
      );
    }),
  );
});
