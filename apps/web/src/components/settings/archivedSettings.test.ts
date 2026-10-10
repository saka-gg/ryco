import { describe, expect, it } from "vite-plus/test";
import { describeTrashedThreadPlace, selectArchivedSettingsGroups } from "./archivedSettings";

describe("node settings archive", () => {
  const projects = ["local", "remote"].map((environmentId) => ({
    id: "same-project",
    environmentId,
  }));
  const threads = ["local", "remote"].map((environmentId) => ({
    id: "same-thread",
    projectId: "same-project",
    environmentId,
    createdAt: "2026-01-01",
    archivedAt: "2026-01-02",
  }));
  it("shows only the selected node even when IDs collide", () => {
    expect(selectArchivedSettingsGroups(projects, threads, "remote")).toEqual([
      {
        kind: "project",
        key: "project:remote:same-project",
        project: projects[1],
        threads: [threads[1]],
      },
    ]);
    expect(selectArchivedSettingsGroups(projects, threads, "missing")).toEqual([]);
  });
  it("keeps each node's archive separate in the legacy combined view", () => {
    expect(selectArchivedSettingsGroups(projects, threads)).toEqual([
      {
        kind: "project",
        key: "project:local:same-project",
        project: projects[0],
        threads: [threads[0]],
      },
      {
        kind: "project",
        key: "project:remote:same-project",
        project: projects[1],
        threads: [threads[1]],
      },
    ]);
  });
});

describe("archived chats", () => {
  const chat = (id: string, environmentId = "local") => ({
    id,
    environmentId,
    kind: "chat" as const,
  });
  const thread = (
    id: string,
    projectId: string,
    archivedAt: string | null,
    environmentId = "local",
  ) => ({ id, projectId, environmentId, createdAt: "2026-01-01", archivedAt });

  const project = { id: "project", environmentId: "local", kind: "project" as const };
  const legacyProject = { id: "legacy", environmentId: "local" };
  const projects = [chat("trip"), project, chat("recipes"), legacyProject, chat("notes", "remote")];
  const threads = [
    thread("trip-thread", "trip", "2026-01-03"),
    thread("recipes-thread", "recipes", "2026-01-05"),
    thread("project-thread", "project", "2026-01-04"),
    thread("legacy-thread", "legacy", "2026-01-02"),
    thread("active-chat", "trip", null),
    thread("notes-thread", "notes", "2026-01-06", "remote"),
  ];

  it("gathers a node's chats under one No project section after its projects", () => {
    const groups = selectArchivedSettingsGroups(projects, threads, "local");
    expect(groups.map((group) => [group.kind, group.key])).toEqual([
      ["project", "project:local:project"],
      ["project", "project:local:legacy"],
      ["no-project", "no-project:local"],
    ]);
    const chats = groups[2]!;
    expect(chats.kind === "no-project" && chats.environmentId).toBe("local");
    // Newest archived first, across every chat; active chats stay out.
    expect(chats.threads.map((entry) => entry.id)).toEqual(["recipes-thread", "trip-thread"]);
  });

  it("never names a section after a chat", () => {
    const groups = selectArchivedSettingsGroups(projects, threads);
    const projectIds = groups.flatMap((group) =>
      group.kind === "project" ? [group.project.id] : [],
    );
    expect(projectIds).toEqual(["project", "legacy"]);
    expect(
      groups
        .filter((group) => group.kind === "no-project")
        .map((group) => [group.environmentId, group.threads.map((entry) => entry.id)]),
    ).toEqual([
      ["local", ["recipes-thread", "trip-thread"]],
      ["remote", ["notes-thread"]],
    ]);
  });

  it("omits the No project section when no chat is archived", () => {
    expect(
      selectArchivedSettingsGroups(projects, [thread("active-chat", "trip", null)], "local"),
    ).toEqual([]);
  });
});

describe("trashed conversation place", () => {
  const folder = "/home/me/.ryco/chats/plan-a-trip";
  const chatProject = { kind: "chat" as const, cwd: folder };
  const regularProject = { kind: "project" as const, cwd: "/repo/ryco" };

  it("trusts the node's project kind, even once the store no longer lists the project", () => {
    expect(
      describeTrashedThreadPlace({ projectKind: "chat", projectTitle: "Plan a trip" }, null),
    ).toEqual({ label: "No project", chatFolder: null });
    expect(
      describeTrashedThreadPlace({ projectKind: "chat", projectTitle: "Plan a trip" }, chatProject),
    ).toEqual({ label: "No project", chatFolder: folder });
    // The node's answer wins over a stale store.
    expect(
      describeTrashedThreadPlace({ projectKind: "project", projectTitle: "Ryco" }, chatProject),
    ).toEqual({ label: "Ryco", chatFolder: null });
  });

  it("falls back to the store for nodes that send no project kind", () => {
    expect(describeTrashedThreadPlace({ projectTitle: "Plan a trip" }, chatProject)).toEqual({
      label: "No project",
      chatFolder: folder,
    });
    expect(describeTrashedThreadPlace({ projectTitle: "Ryco" }, regularProject)).toEqual({
      label: "Ryco",
      chatFolder: null,
    });
    expect(describeTrashedThreadPlace({ projectTitle: null }, undefined)).toEqual({
      label: "Removed project",
      chatFolder: null,
    });
  });
});
