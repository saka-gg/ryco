import { ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseTasksSearch } from "./components/tasks/tasksSearch";
import { buildTasksPageLocation, TASKS_ROUTE_PATH } from "./tasksRoute";

describe("buildTasksPageLocation", () => {
  it("opens every task without a project", () => {
    expect(buildTasksPageLocation()).toEqual({ to: TASKS_ROUTE_PATH, search: {} });
    expect(buildTasksPageLocation({ projectId: null })).toEqual({
      to: TASKS_ROUTE_PATH,
      search: {},
    });
  });

  it("filters to one project", () => {
    expect(buildTasksPageLocation({ projectId: ProjectId.make("p-ryco") })).toEqual({
      to: TASKS_ROUTE_PATH,
      search: { project: "p-ryco" },
    });
  });
});

describe("parseTasksSearch", () => {
  it("keeps a project id and drops everything else", () => {
    expect(parseTasksSearch({ project: " p-ryco ", tab: "x" })).toEqual({ project: "p-ryco" });
  });

  it("ignores empty, oversized and non-string projects", () => {
    expect(parseTasksSearch({})).toEqual({});
    expect(parseTasksSearch({ project: "  " })).toEqual({});
    expect(parseTasksSearch({ project: 42 })).toEqual({});
    expect(parseTasksSearch({ project: "p".repeat(257) })).toEqual({});
  });
});
