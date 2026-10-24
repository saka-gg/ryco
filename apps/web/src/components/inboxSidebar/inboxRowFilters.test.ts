import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inboxRowFilterActions } from "./inboxRowFilters";

describe("inboxRowFilterActions", () => {
  const STUDIO = EnvironmentId.make("studio");
  const LAPTOP = EnvironmentId.make("laptop");
  type FilterRow = Parameters<typeof inboxRowFilterActions>[0];
  const filterRow = (overrides: Partial<FilterRow> = {}): FilterRow => ({
    environmentId: STUDIO,
    machineLabel: "Studio",
    projectLabel: "Ryco",
    isChat: false,
    showProject: true,
    spansMachines: true,
    ...overrides,
  });
  const NO_FILTERS = { projectKey: null, environmentId: null };
  const kinds = (actions: ReturnType<typeof inboxRowFilterActions>) =>
    actions.map((action) => action.kind);

  it("narrows to the row's project and machine", () => {
    expect(inboxRowFilterActions(filterRow(), "repo:ryco", NO_FILTERS)).toEqual([
      {
        kind: "project",
        label: "Filter by Ryco",
        active: false,
        project: { logicalKey: "repo:ryco", label: "Ryco" },
      },
      { kind: "machine", label: "Filter by Studio", active: false, environmentId: STUDIO },
    ]);
  });

  it("shows everything again when the row already matches the filter", () => {
    const actions = inboxRowFilterActions(filterRow(), "repo:ryco", {
      projectKey: "repo:ryco",
      environmentId: STUDIO,
    });
    expect(actions.map((action) => [action.label, action.active])).toEqual([
      ["Show all projects", true],
      ["Show all machines", true],
    ]);
  });

  it("switches from another project or machine to the row's", () => {
    const actions = inboxRowFilterActions(filterRow(), "repo:ryco", {
      projectKey: "repo:hub",
      environmentId: LAPTOP,
    });
    expect(actions.map((action) => [action.label, action.active])).toEqual([
      ["Filter by Ryco", false],
      ["Filter by Studio", false],
    ]);
  });

  it("offers only what can narrow the Inbox", () => {
    expect(kinds(inboxRowFilterActions(filterRow({ isChat: true }), "chat", NO_FILTERS))).toEqual([
      "machine",
    ]);
    expect(
      kinds(inboxRowFilterActions(filterRow({ showProject: false }), "repo:ryco", NO_FILTERS)),
    ).toEqual(["machine"]);
    expect(kinds(inboxRowFilterActions(filterRow(), null, NO_FILTERS))).toEqual(["machine"]);
    expect(
      kinds(inboxRowFilterActions(filterRow({ spansMachines: false }), "repo:ryco", NO_FILTERS)),
    ).toEqual(["project"]);
  });
});
