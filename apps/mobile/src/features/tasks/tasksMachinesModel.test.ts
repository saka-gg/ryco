import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TASKS_TAB_STATE,
  deriveTaskMachines,
  rememberCapture,
  resolveCaptureMachine,
  resolveCaptureProject,
  resolveTaskMachineFilter,
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
      { environmentId: MAC, label: "MacBook", connected: true, reachable: true },
      { environmentId: MINI, label: "Mac mini", connected: false, reachable: false },
    ]);
  });

  it("counts a Hub machine online but not connected now as reachable", () => {
    const machines = deriveTaskMachines({
      environments: [{ environmentId: MINI, label: "Mac mini", connectionState: "offline" }],
      supported: new Map(),
      forbidden: {},
      reachable: new Set([MINI]),
    });
    expect(machines).toEqual([
      { environmentId: MINI, label: "Mac mini", connected: false, reachable: true },
    ]);
  });
});

describe("machine filter and capture machine", () => {
  const machines = [
    { environmentId: MINI, label: "Mac mini", connected: false, reachable: false },
    { environmentId: MAC, label: "MacBook", connected: true, reachable: true },
    { environmentId: SHARED, label: "Studio", connected: false, reachable: true },
  ];
  const idOf = (machine: ReturnType<typeof resolveCaptureMachine>) =>
    machine === null || machine === "unavailable" ? machine : machine.environmentId;

  it("filters to the machine picked last while it is listed, else shows every machine", () => {
    expect(resolveTaskMachineFilter(machines, MINI)?.environmentId).toBe(MINI);
    expect(resolveTaskMachineFilter(machines, "env-gone")).toBeNull();
    expect(resolveTaskMachineFilter(machines, null)).toBeNull();
  });

  it("adds new tasks to the first reachable machine asked for", () => {
    expect(idOf(resolveCaptureMachine(machines, [MINI, MAC]))).toBe(MAC);
    expect(idOf(resolveCaptureMachine(machines, [MINI, SHARED]))).toBe(SHARED);
    expect(idOf(resolveCaptureMachine(machines, [null, undefined]))).toBe(MAC);
    expect(resolveCaptureMachine([machines[0]!], [MINI])).toBeNull();
  });

  it("never sends a chat's or pull request's task to another machine", () => {
    expect(idOf(resolveCaptureMachine(machines, [MINI, MAC], MINI))).toBe("unavailable");
    expect(idOf(resolveCaptureMachine(machines, [MAC], "env-not-mine"))).toBe("unavailable");
    expect(idOf(resolveCaptureMachine(machines, [MAC], SHARED))).toBe(SHARED);
  });

  it("starts a new task in the asked, filtered or last used project the machine still has", () => {
    const projects = [{ id: ProjectId.make("p-a") }, { id: ProjectId.make("p-b") }];
    const state = rememberCapture(DEFAULT_TASKS_TAB_STATE, MAC, "p-b");
    expect(state.captureEnvironmentId).toBe(MAC);
    expect(resolveCaptureProject(state, MAC, projects)).toBe("p-b");
    expect(resolveCaptureProject(state, MAC, projects, "p-a")).toBe("p-a");
    expect(resolveCaptureProject(state, MAC, projects, null)).toBeNull();
    expect(
      resolveCaptureProject({ ...state, environmentId: MAC, projectId: "p-a" }, MAC, projects),
    ).toBe("p-a");
    expect(resolveCaptureProject(state, MINI, projects)).toBeNull();
    expect(resolveCaptureProject(state, MAC, [{ id: ProjectId.make("p-a") }])).toBeNull();
  });
});

describe("tasks tab state", () => {
  it("reads only well-formed ids back", () => {
    expect(sanitizeTasksTabState(null)).toEqual(DEFAULT_TASKS_TAB_STATE);
    expect(
      sanitizeTasksTabState({ environmentId: "env", projectId: 4, showAllDone: true }),
    ).toEqual({
      environmentId: "env",
      projectId: null,
      showAllDone: true,
      captureEnvironmentId: null,
      captureProjectIds: {},
    });
  });

  it("drops the project filter when another machine is picked", () => {
    const state = { ...DEFAULT_TASKS_TAB_STATE, environmentId: MAC, projectId: "p" };
    expect(selectTaskMachine(state, MAC)).toBe(state);
    expect(selectTaskMachine(state, MINI)).toMatchObject({ environmentId: MINI, projectId: null });
    expect(selectTaskMachine(state, null)).toMatchObject({ environmentId: null, projectId: null });
  });

  it("keeps the project filter only while the machine has the project", () => {
    const state = { ...DEFAULT_TASKS_TAB_STATE, environmentId: MAC, projectId: "p-ryco" };
    expect(resolveTaskProjectFilter(state, [{ id: ProjectId.make("p-ryco") }])).toBe("p-ryco");
    expect(resolveTaskProjectFilter(state, [{ id: ProjectId.make("p-other") }])).toBeNull();
  });
});
