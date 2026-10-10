import { describe, expect, it } from "vitest";

import { parseProjectsSearch, resolveProjectsView } from "./projectsSearch";

describe("parseProjectsSearch", () => {
  it("keeps a checkout and a known section", () => {
    expect(parseProjectsSearch({ env: "env-1", project: "p-1", section: "actions" })).toEqual({
      env: "env-1",
      project: "p-1",
      section: "actions",
    });
  });

  it("drops an environment that names no project", () => {
    expect(parseProjectsSearch({ env: "env-1" })).toEqual({});
  });

  it("ignores unknown sections and retired params", () => {
    expect(parseProjectsSearch({ project: "p", tab: "settings", section: "general" })).toEqual({
      project: "p",
    });
  });

  it("trims ids and rejects empty or oversized ones", () => {
    expect(parseProjectsSearch({ project: "  p  ", env: " e " })).toEqual({
      project: "p",
      env: "e",
    });
    expect(parseProjectsSearch({ project: "   " })).toEqual({});
    expect(parseProjectsSearch({ project: "x".repeat(300) })).toEqual({});
  });

  it("keeps a workspace and its review, and drops a review without a workspace", () => {
    expect(
      parseProjectsSearch({
        env: "e",
        project: "p",
        section: "workspaces",
        workspace: "wt-1",
        review: "remove-checkout",
      }),
    ).toEqual({
      env: "e",
      project: "p",
      section: "workspaces",
      workspace: "wt-1",
      review: "remove-checkout",
    });
    expect(parseProjectsSearch({ project: "p", review: "remove-checkout" })).toEqual({
      project: "p",
    });
  });

  it("only reviews actions that change a checkout", () => {
    expect(parseProjectsSearch({ project: "p", workspace: "wt-1", review: "archive" })).toEqual({
      project: "p",
      workspace: "wt-1",
    });
    expect(parseProjectsSearch({ workspace: "wt-1", review: "remove-checkout" })).toEqual({});
  });

  it("keeps a known view and opens on the map unless a section names settings", () => {
    expect(parseProjectsSearch({ project: "p", view: "settings" })).toEqual({
      project: "p",
      view: "settings",
    });
    expect(parseProjectsSearch({ project: "p", view: "graph" })).toEqual({ project: "p" });
    expect(resolveProjectsView({})).toBe("map");
    expect(resolveProjectsView({ section: "actions" })).toBe("settings");
    expect(resolveProjectsView({ section: "actions", view: "map" })).toBe("map");
  });
});
