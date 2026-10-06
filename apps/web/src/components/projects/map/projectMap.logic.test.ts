import { describe, expect, it } from "vite-plus/test";

import {
  automationCycle,
  buildProjectMap,
  expandableWorkspaceKeys,
  mapKey,
  mapLineage,
  type MapAutomation,
  type MapCheckout,
  type MapOptions,
  type MapThread,
  type MapWorkspace,
} from "./projectMap.logic";

const thread = (id: string, glyph: MapThread["glyph"] = "idle"): MapThread => ({
  id,
  title: id,
  glyph,
  glyphLabel: glyph,
  archived: false,
  activityAt: null,
});

const workspace = (id: string, overrides: Partial<MapWorkspace> = {}): MapWorkspace => ({
  id,
  registeredId: id,
  title: null,
  branch: id,
  main: false,
  archived: false,
  checkoutRemoved: false,
  origin: null,
  facts: [],
  threads: [],
  ...overrides,
});

const automation = (id: string, overrides: Partial<MapAutomation> = {}): MapAutomation => ({
  id,
  title: id,
  enabled: true,
  scheduleLabel: "Every 30 min",
  nextRunAt: null,
  intervalMs: null,
  envMode: "local",
  pendingProposalId: null,
  running: false,
  lastRunFailed: false,
  threadIds: [],
  runningThreadIds: [],
  ...overrides,
});

const checkout = (key: string, overrides: Partial<MapCheckout> = {}): MapCheckout => ({
  key,
  environmentId: `env-${key}`,
  projectId: `p-${key}`,
  cwd: `/${key}`,
  deviceLabel: key,
  isPrimary: key === "mac",
  status: "online",
  workspaces: [workspace("main", { main: true, branch: "main" })],
  automations: [],
  ...overrides,
});

const options = (overrides: Partial<MapOptions> = {}): MapOptions => ({
  hiddenCheckouts: new Set(),
  expanded: new Set(),
  showArchived: true,
  showAutomations: true,
  offsets: new Map(),
  ...overrides,
});

const node = (layout: ReturnType<typeof buildProjectMap>, key: string) =>
  layout.nodes.find((candidate) => candidate.key === key);

describe("buildProjectMap", () => {
  it("puts the project on top and one device per column, centred under it", () => {
    const layout = buildProjectMap([checkout("mac"), checkout("studio")], options());
    const mac = node(layout, mapKey.device("mac"))!;
    const studio = node(layout, mapKey.device("studio"))!;
    const project = node(layout, mapKey.project())!;
    expect(studio.x).toBeGreaterThan(mac.x);
    expect(mac.y).toBe(studio.y);
    expect(project.x + project.w / 2).toBe((mac.x + studio.x + studio.w) / 2);
    expect(layout.parent[mapKey.device("mac")]).toBe(mapKey.project());
  });

  it("folds threads until their workspace is expanded, pushing what is below down", () => {
    const mac = checkout("mac", {
      workspaces: [
        workspace("main", { main: true, branch: "main", threads: [thread("t1"), thread("t2")] }),
        workspace("feature"),
      ],
    });
    const folded = buildProjectMap([mac], options());
    expect(folded.nodes.some((candidate) => candidate.kind === "thread")).toBe(false);
    const mainKey = mapKey.workspace("mac", "main");
    const open = buildProjectMap([mac], options({ expanded: new Set([mainKey]) }));
    expect(open.nodes.filter((candidate) => candidate.kind === "thread")).toHaveLength(2);
    expect(node(open, mapKey.workspace("mac", "feature"))!.y).toBeGreaterThan(
      node(folded, mapKey.workspace("mac", "feature"))!.y,
    );
    expect(open.parent[mapKey.thread("mac", "t1")]).toBe(mainKey);
  });

  it("hides archived workspaces and automations on request, and whole devices", () => {
    const mac = checkout("mac", {
      workspaces: [workspace("old", { archived: true })],
      automations: [automation("nightly")],
    });
    const layout = buildProjectMap(
      [mac, checkout("studio")],
      options({
        showArchived: false,
        showAutomations: false,
        hiddenCheckouts: new Set(["studio"]),
      }),
    );
    expect(node(layout, mapKey.workspace("mac", "old"))).toBeUndefined();
    expect(node(layout, mapKey.automation("mac", "nightly"))).toBeUndefined();
    expect(node(layout, mapKey.device("studio"))).toBeUndefined();
  });

  it("joins the same branch on two devices with one arc, never the main checkout", () => {
    const layout = buildProjectMap(
      [
        checkout("mac", {
          workspaces: [
            workspace("main", { main: true, branch: "main" }),
            workspace("a", { branch: "projects-page" }),
          ],
        }),
        checkout("studio", {
          workspaces: [
            workspace("main", { main: true, branch: "main" }),
            workspace("b", { branch: "projects-page" }),
          ],
        }),
      ],
      options(),
    );
    const same = layout.edges.filter((edge) => edge.kind === "same-branch");
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({
      from: mapKey.workspace("mac", "a"),
      to: mapKey.workspace("studio", "b"),
    });
    expect(layout.labels.filter((label) => label.kind === "same-branch")).toHaveLength(1);
  });

  it("links an automation to the threads it started, or their workspace while folded", () => {
    const mac = checkout("mac", {
      workspaces: [
        workspace("main", { main: true, branch: "main", threads: [thread("t1", "working")] }),
      ],
      automations: [
        automation("triage", { threadIds: ["t1"], runningThreadIds: ["t1"], running: true }),
      ],
    });
    const folded = buildProjectMap([mac], options());
    const run = folded.edges.find((edge) => edge.kind === "run")!;
    expect(run).toMatchObject({
      from: mapKey.automation("mac", "triage"),
      to: mapKey.workspace("mac", "main"),
      flow: true,
    });
    const open = buildProjectMap(
      [mac],
      options({ expanded: new Set([mapKey.workspace("mac", "main")]) }),
    );
    expect(open.edges.find((edge) => edge.kind === "run")!.to).toBe(mapKey.thread("mac", "t1"));
  });

  it("runs a slow dash only along wires that lead to running work", () => {
    const mac = checkout("mac", {
      workspaces: [
        workspace("main", { main: true, branch: "main", threads: [thread("t1", "working")] }),
        workspace("quiet", { threads: [thread("t2", "idle")] }),
      ],
    });
    const layout = buildProjectMap([mac], options());
    const flow = (to: string) => layout.edges.find((edge) => edge.to === to)!.flow;
    expect(flow(mapKey.device("mac"))).toBe(true);
    expect(flow(mapKey.workspace("mac", "main"))).toBe(true);
    expect(flow(mapKey.workspace("mac", "quiet"))).toBe(false);
  });

  it("applies manual moves on top of the layout", () => {
    const base = buildProjectMap([checkout("mac")], options());
    const moved = buildProjectMap(
      [checkout("mac")],
      options({ offsets: new Map([[mapKey.device("mac"), { dx: 40, dy: -10 }]]) }),
    );
    expect(node(moved, mapKey.device("mac"))!.x).toBe(node(base, mapKey.device("mac"))!.x + 40);
  });
});

describe("mapLineage", () => {
  it("lights ancestors, descendants and run partners", () => {
    const mac = checkout("mac", {
      workspaces: [workspace("main", { main: true, branch: "main", threads: [thread("t1")] })],
      automations: [automation("triage", { threadIds: ["t1"] })],
    });
    const layout = buildProjectMap(
      [mac, checkout("studio")],
      options({ expanded: new Set([mapKey.workspace("mac", "main")]) }),
    );
    const lit = mapLineage(layout, mapKey.automation("mac", "triage"));
    expect(lit.has(mapKey.device("mac"))).toBe(true);
    expect(lit.has(mapKey.project())).toBe(true);
    expect(lit.has(mapKey.thread("mac", "t1"))).toBe(true);
    expect(lit.has(mapKey.device("studio"))).toBe(false);
    const fromDevice = mapLineage(layout, mapKey.device("mac"));
    expect(fromDevice.has(mapKey.thread("mac", "t1"))).toBe(true);
  });
});

describe("helpers", () => {
  it("lists every workspace that can fan out", () => {
    const mac = checkout("mac", {
      workspaces: [workspace("main", { main: true, threads: [thread("t1")] }), workspace("empty")],
    });
    expect(expandableWorkspaceKeys([mac])).toEqual([mapKey.workspace("mac", "main")]);
  });

  it("fills a countdown ring as the next run approaches", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const due = automation("x", { nextRunAt: "2026-10-05T12:10:00.000Z", intervalMs: 30 * 60_000 });
    expect(automationCycle(due, now)).toBeCloseTo(2 / 3);
    expect(automationCycle({ ...due, enabled: false }, now)).toBe(0);
    expect(automationCycle({ ...due, intervalMs: null }, now)).toBe(0);
  });
});
