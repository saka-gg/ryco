import { describe, expect, it } from "vite-plus/test";
import { selectArchivedSettingsGroups } from "./archivedSettings";

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
      { project: projects[1], threads: [threads[1]] },
    ]);
    expect(selectArchivedSettingsGroups(projects, threads, "missing")).toEqual([]);
  });
  it("keeps each node's archive separate in the legacy combined view", () => {
    expect(selectArchivedSettingsGroups(projects, threads)).toEqual([
      { project: projects[0], threads: [threads[0]] },
      { project: projects[1], threads: [threads[1]] },
    ]);
  });
});
