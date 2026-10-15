/**
 * Mobile consumers of thread rows with archived threads held as stubs
 * (`archivedThreads: "stub"`): home groups, project rows and detail list
 * unarchived threads only, so a stub never shows up there.
 */
import { describe, expect, it } from "vite-plus/test";

import type {
  ArchivedThreadStub,
  Project,
  SidebarThreadOrStub,
  SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { buildProjectDetail, buildProjectRows } from "../features/projects/projectsModel";
import { buildInboxSections } from "../features/inbox/inboxModel";
import { buildHomeThreadGroups } from "./homeGrouping";

const ENV = "node-a" as EnvironmentId;
const PROJECT = "project-a" as ProjectId;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";

const project = {
  environmentId: ENV,
  id: PROJECT,
  name: "Project",
  cwd: "/repo/project",
  defaultModelSelection: null,
  scripts: [],
} as unknown as Project;

const live = {
  id: "live",
  environmentId: ENV,
  projectId: PROJECT,
  title: "Live",
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  session: null,
  latestTurn: null,
  latestUserMessageAt: T0,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  interactionMode: "default",
  branch: null,
  worktreePath: null,
} as unknown as SidebarThreadSummary;

const stub: ArchivedThreadStub = {
  shellDetail: "archived-stub",
  id: "archived" as never,
  environmentId: ENV,
  projectId: PROJECT,
  title: "Archived",
  createdAt: T0,
  updatedAt: T1,
  archivedAt: T1,
  branch: null,
  worktreePath: null,
  worktreeId: null,
  latestUserMessageAt: T0,
  lineage: null,
};

const threads: ReadonlyArray<SidebarThreadOrStub> = [live, stub];

describe("archived stubs in mobile consumers", () => {
  it("leaves stubs out of home groups", () => {
    const groups = buildHomeThreadGroups({
      projects: [project],
      threads,
      groupingMode: "physical" as never,
    });
    expect(groups.flatMap((group) => group.threads.map((thread) => thread.id))).toEqual(["live"]);
  });

  it("leaves stubs out of project rows and detail", () => {
    const environments = [
      { environmentId: ENV, label: "Node", connectionState: "connected" },
    ] as never;
    const detail = buildProjectDetail({
      environmentId: ENV,
      projectId: PROJECT,
      projects: [project],
      worktrees: [],
      threads,
      environments,
    });
    expect(detail?.projectThreads.map((thread) => thread.id)).toEqual(["live"]);
    const rows = buildProjectRows({
      projects: [project],
      worktrees: [],
      threads,
      environments,
      groupingMode: "physical" as never,
    });
    expect(rows).toHaveLength(1);
  });

  it("leaves stubs out of the inbox sections", () => {
    const sections = buildInboxSections({
      projects: [project],
      worktrees: [],
      threads,
      environments: [
        {
          environmentId: ENV,
          label: "Node",
          connectionState: "connected",
          threadSettlementSupported: true,
          mutationReady: true,
          shellCurrent: true,
        },
      ] as never,
      nowMs: Date.parse(T1),
    });
    expect(sections.flatMap((section) => section.rows.map((row) => row.threadId))).toEqual([
      "live",
    ]);
  });
});
