import type {
  ArchivedThreadStub,
  Project,
  SidebarThreadOrStub,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedThreadSections, countArchivedThreads } from "./archivedThreadsModel";

const A = "node-a" as EnvironmentId;
const B = "node-b" as EnvironmentId;

function project(environmentId: EnvironmentId, id: string, name: string, kind?: "chat"): Project {
  return {
    environmentId,
    id: id as ProjectId,
    name,
    cwd: `/repo/${id}`,
    ...(kind ? { kind } : {}),
  } as unknown as Project;
}

function archived(
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  archivedAt: string,
): ArchivedThreadStub {
  return {
    shellDetail: "archived-stub",
    id: id as ThreadId,
    environmentId,
    projectId: projectId as ProjectId,
    title: id,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: archivedAt,
    archivedAt,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    latestUserMessageAt: null,
    lineage: null,
  };
}

const live = {
  ...archived(A, "live", "app", "x"),
  archivedAt: null,
} as unknown as SidebarThreadOrStub;
const projects = [
  project(A, "app", "App"),
  project(A, "chats", "Trip", "chat"),
  project(B, "hub", "Hub"),
];
const threads: SidebarThreadOrStub[] = [
  live,
  archived(A, "older", "app", "2026-11-02T00:00:00.000Z"),
  archived(A, "newer", "app", "2026-11-03T00:00:00.000Z"),
  archived(A, "chat", "chats", "2026-11-04T00:00:00.000Z"),
  archived(B, "remote", "hub", "2026-11-05T00:00:00.000Z"),
];
const environments = [
  { environmentId: A, label: "Mac", canMutate: true },
  { environmentId: B, label: "Server", canMutate: false },
];

describe("archived threads", () => {
  it("groups by project, newest archived first, chats under No project", () => {
    const sections = buildArchivedThreadSections({
      projects,
      threads,
      environments,
      environmentId: null,
      query: "",
    });
    expect(
      sections.map((section) => [section.title, section.rows.map((row) => row.threadId)]),
    ).toEqual([
      ["App", ["newer", "older"]],
      ["Hub", ["remote"]],
      ["No project", ["chat"]],
    ]);
    expect(sections[1]?.rows[0]).toMatchObject({ nodeLabel: "Server", canRestore: false });
  });

  it("searches by title, project or machine and limits to one machine", () => {
    const search = (query: string, environmentId: EnvironmentId | null = null) =>
      buildArchivedThreadSections({
        projects,
        threads,
        environments,
        environmentId,
        query,
      }).flatMap((section) => section.rows.map((row) => row.threadId));
    expect(search("OLD")).toEqual(["older"]);
    expect(search("app")).toEqual(["newer", "older"]);
    expect(search("server")).toEqual(["remote"]);
    expect(search("", B)).toEqual(["remote"]);
  });

  it("leaves out machines the phone no longer lists", () => {
    const sections = buildArchivedThreadSections({
      projects,
      threads,
      environments: [environments[0]!],
      environmentId: null,
      query: "",
    });
    expect(sections.map((section) => section.title)).toEqual(["App", "No project"]);
  });

  it("counts archived threads per scope", () => {
    expect(countArchivedThreads(threads, null)).toBe(4);
    expect(countArchivedThreads(threads, B)).toBe(1);
  });
});
