import { AgentControlWorkspaceLifecyclePlan, ProjectId, ThreadId } from "@ryco/contracts";
import { Schema } from "effect";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-target");
const now = "2026-08-18T00:00:00.000Z";
export const workspacePlan = Schema.decodeUnknownSync(AgentControlWorkspaceLifecyclePlan)({
  kind: "workspaceLifecycle",
  projectId,
  action: "delete",
  checkoutMode: "record-only",
  sessions: "preserve",
  deleteBranch: false,
  expected: {
    workspaceId: "workspace",
    projectId,
    registration: "registered",
    worktreeId: "workspace",
    mainWorkspaceId: "main",
    checkoutIdentity: null,
    rootIdentity: "1:2",
    title: "Manual",
    origin: "manual",
    branch: "topic",
    path: "/workspace/missing",
    projectRoot: "/workspace/project",
    projectUpdatedAt: now,
    updatedAt: now,
    archivedAt: null,
    main: false,
    current: false,
    checkout: "missing",
    gitRegistered: false,
    repository: "/workspace/project/.git",
    repositoryIdentity: "1:3",
    head: null,
    branchHead: "a".repeat(40),
    baseHead: "a".repeat(40),
    dirty: null,
    unmerged: false,
    sessions: [{ threadId, updatedAt: now, archived: true, active: false }],
    blockers: [],
  },
});
