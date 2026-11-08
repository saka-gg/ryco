import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TASKS_TAB_STATE,
  deriveTaskMachines,
  resolveTaskMachine,
  resolveTaskProjectFilter,
  sanitizeTasksTabState,
  selectTaskMachine,
} from "./tasksMachinesModel";

const MAC = EnvironmentId.make("env-mac");
const MINI = EnvironmentId.make("env-mini");
const SHARED = EnvironmentId.make("env-shared");
const OLD = EnvironmentId.make("env-old");
const REFUSED = EnvironmentId.make("env-refused");

describe("deriveTaskMachines", () => {
  it("lists the owner's machines that have tasks, while their config is unknown too", () => {
    const machines = deriveTaskMachines({
      environments: [
        { environmentId: MAC, label: "MacBook", connectionState: "connected", role: "owner" },
        { environmentId: MINI, label: "Mac mini", connectionState: "offline" },
        { environmentId: SHARED, label: "Team box", connectionState: "connected", role: "viewer" },
        { environmentId: OLD, label: "Old node", connectionState: "connected" },
        { environmentId: REFUSED, label: "Refused", connectionState: "connected" },
      ],
      supported: new Map([
        [MAC, true],
        [OLD, false],
      ]),
      forbidden: { [REFUSED]: true },
    });
    expect(machines).toEqual([
      { environmentId: MAC, label: "MacBook", connected: true },
      { environmentId: MINI, label: "Mac mini", connected: false },
    ]);
  });
});

describe("resolveTaskMachine", () => {
  const machines = [
    { environmentId: MINI, label: "Mac mini", connected: false },
    { environmentId: MAC, label: "MacBook", connected: true },
  ];

  it("keeps the machine picked last, else takes the first connected one", () => {
    expect(resolveTaskMachine(machines, MINI)?.environmentId).toBe(MINI);
    expect(resolveTaskMachine(machines, "env-gone")?.environmentId).toBe(MAC);
    expect(resolveTaskMachine(machines, null)?.environmentId).toBe(MAC);
    expect(resolveTaskMachine([], null)).toBeNull();
  });
});

describe("tasks tab state", () => {
  it("reads only well-formed ids back", () => {
    expect(sanitizeTasksTabState(null)).toEqual(DEFAULT_TASKS_TAB_STATE);
    expect(
      sanitizeTasksTabState({ environmentId: "env", projectId: 4, showAllDone: true }),
    ).toEqual({ environmentId: "env", projectId: null, showAllDone: true });
  });

  it("drops the project filter when another machine is picked", () => {
    const state = { environmentId: MAC, projectId: "p", showAllDone: false };
    expect(selectTaskMachine(state, MAC)).toBe(state);
    expect(selectTaskMachine(state, MINI)).toEqual({
      environmentId: MINI,
      projectId: null,
      showAllDone: false,
    });
  });

  it("keeps the project filter only while the machine has the project", () => {
    const state = { environmentId: MAC, projectId: "p-ryco", showAllDone: false };
    expect(resolveTaskProjectFilter(state, [{ id: ProjectId.make("p-ryco") }])).toBe("p-ryco");
    expect(resolveTaskProjectFilter(state, [{ id: ProjectId.make("p-other") }])).toBeNull();
  });
});
