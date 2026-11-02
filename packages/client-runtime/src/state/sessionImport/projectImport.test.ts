import { ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  discoverProjectImportCandidates,
  findContainingImportProject,
  groupProjectImportCandidates,
  planProjectImport,
  projectImportDestinationOptions,
  projectImportGroupSelection,
  runProjectImport,
  setProjectImportGroupSelected,
  type ProjectImportCandidate,
  type ProjectImportItemStatus,
  type ProjectImportProject,
} from "./projectImport.ts";

let sequence = 0;
function candidate(overrides: Partial<ProjectImportCandidate> = {}): ProjectImportCandidate {
  sequence += 1;
  return {
    key: `key-${sequence}`,
    source: "codex",
    title: `Conversation ${sequence}`,
    cwd: "",
    canonicalCwd: null,
    archived: false,
    messageCount: 2,
    importedThreadId: null,
    quarantined: false,
    origin: "codex:default",
    ...overrides,
  };
}

const project = (id: string, workspaceRoot: string): ProjectImportProject => ({
  id: ProjectId.make(id),
  name: id,
  workspaceRoot,
});

describe("groupProjectImportCandidates", () => {
  it("groups by the folder the node resolved, not by the recorded spelling, name or source", () => {
    const viaLink = candidate({ cwd: "/home/me/link/app", canonicalCwd: "/srv/app" });
    const direct = candidate({
      source: "claudeAgent",
      title: "Same title elsewhere",
      cwd: "/srv/app/",
      canonicalCwd: "/srv/app",
    });
    const sameName = candidate({ cwd: "/other/app", canonicalCwd: "/other/app" });

    const groups = groupProjectImportCandidates([viaLink, direct, sameName], []);

    expect(groups.map((group) => [group.folder, group.candidates.map((item) => item.key)])).toEqual(
      [
        ["/other/app", [sameName.key]],
        ["/srv/app", [viaLink.key, direct.key]],
      ],
    );
    expect(groups[1]!.sources).toEqual(["claudeAgent", "codex"]);
  });

  it("maps a folder to the closest project that holds it, else proposes a new project there", () => {
    const projects = [project("repo", "/srv/repo"), project("pkg", "/srv/repo/packages/pkg")];
    const inPackage = candidate({
      cwd: "/srv/repo/packages/pkg/src",
      canonicalCwd: "/srv/repo/packages/pkg/src",
    });
    const atRoot = candidate({ cwd: "/srv/repo", canonicalCwd: "/srv/repo" });
    // `/srv/repository` only shares a prefix with `/srv/repo`; it is not inside it.
    const sibling = candidate({ cwd: "/srv/repository", canonicalCwd: "/srv/repository" });

    const groups = groupProjectImportCandidates([inPackage, atRoot, sibling], projects);

    expect(groups.map((group) => [group.folder, group.suggested])).toEqual([
      ["/srv/repo", { kind: "project", projectId: "repo" }],
      ["/srv/repo/packages/pkg/src", { kind: "project", projectId: "pkg" }],
      ["/srv/repository", { kind: "new", workspaceRoot: "/srv/repository" }],
    ]);
  });

  it("never proposes a new project for a gone or unknown folder, and lists those last", () => {
    const projects = [project("repo", "/srv/repo")];
    const deletedWorktree = candidate({ cwd: "/srv/repo/.worktrees/gone", canonicalCwd: null });
    const deletedElsewhere = candidate({ cwd: "/tmp/gone", canonicalCwd: null });
    const noFolder = candidate({ cwd: "", canonicalCwd: null });
    const present = candidate({ cwd: "/zzz", canonicalCwd: "/zzz" });

    const groups = groupProjectImportCandidates(
      [noFolder, deletedElsewhere, deletedWorktree, present],
      projects,
    );

    expect(groups.map((group) => [group.folderState, group.folder, group.suggested])).toEqual([
      ["found", "/zzz", { kind: "new", workspaceRoot: "/zzz" }],
      ["missing", "/srv/repo/.worktrees/gone", { kind: "project", projectId: "repo" }],
      ["missing", "/tmp/gone", { kind: "none" }],
      ["unknown", null, { kind: "none" }],
    ]);
  });

  it("groups by the recorded folder when an older node does not resolve folders", () => {
    const first = candidate({ cwd: "/srv/app", canonicalCwd: undefined });
    const second = candidate({ cwd: "/srv/app/", canonicalCwd: undefined });

    const [group] = groupProjectImportCandidates([first, second], []);

    expect(group).toMatchObject({
      folderState: "found",
      folder: "/srv/app",
      suggested: { kind: "new", workspaceRoot: "/srv/app" },
    });
    expect(group!.candidates).toHaveLength(2);
  });

  it("compares Windows folders case-insensitively", () => {
    const projects = [project("win", "C:\\Work\\App")];
    const nested = candidate({ cwd: "c:\\work\\app\\src", canonicalCwd: "c:\\work\\app\\src" });

    expect(findContainingImportProject("c:\\work\\app\\src", projects)?.id).toBe("win");
    expect(groupProjectImportCandidates([nested], projects)[0]!.suggested).toEqual({
      kind: "project",
      projectId: "win",
    });
  });
});

describe("destinations and selection", () => {
  it("offers a new project only in the group's own existing folder that no project uses", () => {
    const projects = [project("repo", "/srv/repo")];
    const [atRepo, elsewhere] = groupProjectImportCandidates(
      [
        candidate({ cwd: "/srv/repo", canonicalCwd: "/srv/repo" }),
        candidate({ cwd: "/srv/web", canonicalCwd: "/srv/web" }),
      ],
      projects,
    );
    expect(projectImportDestinationOptions(atRepo!, projects)).toEqual([
      { kind: "project", projectId: "repo" },
    ]);
    expect(projectImportDestinationOptions(elsewhere!, projects)).toEqual([
      { kind: "new", workspaceRoot: "/srv/web" },
      { kind: "project", projectId: "repo" },
    ]);
  });

  it("selects a whole group except conversations already imported or paused", () => {
    const pending = candidate({ cwd: "/srv/app", canonicalCwd: "/srv/app" });
    const imported = candidate({
      cwd: "/srv/app",
      canonicalCwd: "/srv/app",
      importedThreadId: ThreadId.make("existing"),
    });
    const paused = candidate({ cwd: "/srv/app", canonicalCwd: "/srv/app", quarantined: true });
    const doneHere = candidate({ cwd: "/srv/app", canonicalCwd: "/srv/app" });
    const [group] = groupProjectImportCandidates([pending, imported, paused, doneHere], []);
    const done = new Set([doneHere.key]);

    const selected = setProjectImportGroupSelected(group!, new Set(), done, true);

    expect([...selected]).toEqual([pending.key]);
    expect(projectImportGroupSelection(group!, selected, done)).toBe("all");
    expect(projectImportGroupSelection(group!, new Set(), done)).toBe("none");
    expect([...setProjectImportGroupSelected(group!, selected, done, false)]).toEqual([]);
  });
});

describe("planProjectImport", () => {
  it("plans selected conversations by destination and counts groups still without one", () => {
    const projects = [project("repo", "/srv/repo")];
    const toRepo = candidate({ cwd: "/srv/repo/src", canonicalCwd: "/srv/repo/src" });
    const toNew = candidate({ cwd: "/srv/web", canonicalCwd: "/srv/web" });
    const unassigned = candidate({ cwd: "/gone", canonicalCwd: null });
    const notSelected = candidate({ cwd: "/srv/api", canonicalCwd: "/srv/api" });
    const groups = groupProjectImportCandidates([toRepo, toNew, unassigned, notSelected], projects);

    const plan = planProjectImport({
      groups,
      selected: new Set([toRepo.key, toNew.key, unassigned.key]),
      done: new Set(),
      destinations: {},
      projects,
    });

    expect(plan.items.map((item) => [item.candidate.key, item.target])).toEqual([
      [toRepo.key, { kind: "project", projectId: "repo" }],
      [toNew.key, { kind: "new", workspaceRoot: "/srv/web" }],
    ]);
    expect(plan.newProjects).toEqual(["/srv/web"]);
    expect(plan.unassigned).toBe(1);

    const assigned = planProjectImport({
      groups,
      selected: new Set([unassigned.key]),
      done: new Set(),
      destinations: {
        [groups.find((group) => group.folderState === "missing")!.key]: {
          kind: "project",
          projectId: ProjectId.make("repo"),
        },
      },
      projects,
    });
    expect(assigned.unassigned).toBe(0);
    expect(assigned.items[0]!.target).toEqual({ kind: "project", projectId: "repo" });
  });

  it("imports into a project that now uses the folder instead of creating another, and unassigns a deleted one", () => {
    const toNew = candidate({ cwd: "/srv/web", canonicalCwd: "/srv/web" });
    const groups = groupProjectImportCandidates([toNew], []);
    const selected = new Set([toNew.key]);

    const reused = planProjectImport({
      groups,
      selected,
      done: new Set(),
      destinations: {},
      projects: [project("created", "/srv/web")],
    });
    expect(reused.items[0]!.target).toEqual({ kind: "project", projectId: "created" });
    expect(reused.newProjects).toEqual([]);

    const deleted = planProjectImport({
      groups,
      selected,
      done: new Set(),
      destinations: { [groups[0]!.key]: { kind: "project", projectId: ProjectId.make("gone") } },
      projects: [],
    });
    expect(deleted.items).toEqual([]);
    expect(deleted.unassigned).toBe(1);
  });
});

describe("runProjectImport", () => {
  function harness(options: { failCreate?: boolean; failKeys?: ReadonlySet<string> } = {}) {
    const calls: string[] = [];
    const statuses: [string, ProjectImportItemStatus][] = [];
    let created = 0;
    let stop = false;
    return {
      calls,
      statuses,
      requestStop: () => {
        stop = true;
      },
      handlers: {
        createProject: async (root: string) => {
          calls.push(`create ${root}`);
          if (options.failCreate) throw new Error("Folder is not authorized.");
          created += 1;
          return ProjectId.make(`created-${created}`);
        },
        importCandidate: async (item: ProjectImportCandidate, projectId: ProjectId) => {
          calls.push(`import ${item.key} -> ${projectId}`);
          if (options.failKeys?.has(item.key)) throw new Error("Provider unavailable");
          return { threadId: ThreadId.make(`thread-${item.key}`), alreadyImported: false };
        },
        shouldContinue: () => !stop,
        onProjectCreated: (root: string, projectId: ProjectId) => {
          calls.push(`created ${root} = ${projectId}`);
        },
        onItem: (key: string, status: ProjectImportItemStatus) => {
          statuses.push([key, status]);
        },
      },
    };
  }

  const twoNewOneExisting = () => {
    const projects = [project("repo", "/srv/repo")];
    const first = candidate({ cwd: "/srv/web", canonicalCwd: "/srv/web" });
    const second = candidate({ cwd: "/srv/web", canonicalCwd: "/srv/web" });
    const third = candidate({ cwd: "/srv/repo", canonicalCwd: "/srv/repo" });
    const groups = groupProjectImportCandidates([first, second, third], projects);
    const plan = planProjectImport({
      groups,
      selected: new Set([first.key, second.key, third.key]),
      done: new Set(),
      destinations: {},
      projects,
    });
    return { first, second, third, plan };
  };

  it("creates a new project once, right before its first conversation, and imports in order", async () => {
    const { first, second, third, plan } = twoNewOneExisting();
    const run = harness();

    const summary = await runProjectImport(plan, run.handlers);

    expect(summary).toEqual({ imported: 3, failed: 0, stopped: false });
    expect(run.calls).toEqual([
      `import ${third.key} -> repo`,
      "create /srv/web",
      "created /srv/web = created-1",
      `import ${first.key} -> created-1`,
      `import ${second.key} -> created-1`,
    ]);
  });

  it("keeps going past a failure and fails a group whose project cannot be created without retrying it", async () => {
    const { first, second, third, plan } = twoNewOneExisting();
    const run = harness({ failCreate: true, failKeys: new Set([third.key]) });

    const summary = await runProjectImport(plan, run.handlers);

    expect(summary).toEqual({ imported: 0, failed: 3, stopped: false });
    expect(run.calls.filter((call) => call.startsWith("create"))).toEqual(["create /srv/web"]);
    const failures = run.statuses.filter(([, status]) => status.state === "failed");
    expect(failures).toEqual([
      [third.key, { state: "failed", message: "Provider unavailable" }],
      [
        first.key,
        { state: "failed", message: "Could not create the project: Folder is not authorized." },
      ],
      [
        second.key,
        { state: "failed", message: "Could not create the project: Folder is not authorized." },
      ],
    ]);
  });

  it("stops after the conversation in progress and creates no project it did not reach", async () => {
    const { third, plan } = twoNewOneExisting();
    const run = harness();
    const handlers = {
      ...run.handlers,
      importCandidate: async (item: ProjectImportCandidate, projectId: ProjectId) => {
        run.requestStop();
        return run.handlers.importCandidate(item, projectId);
      },
    };

    const summary = await runProjectImport(plan, handlers);

    expect(summary).toEqual({ imported: 1, failed: 0, stopped: true });
    expect(run.calls).toEqual([`import ${third.key} -> repo`]);
  });
});

describe("discoverProjectImportCandidates", () => {
  const rows = [
    { id: "codex:default", source: "codex", storeKey: "c".repeat(64), label: "Codex" },
    { id: "claude:default", source: "claudeAgent", storeKey: "d".repeat(64), label: "Claude Code" },
  ] as const;

  it("reads every page of every store, tags each conversation with its store and keeps going past a failing store", async () => {
    const requests: string[] = [];
    const first = candidate();
    const second = candidate();
    const discovery = await discoverProjectImportCandidates({
      rows,
      includeArchived: true,
      shouldContinue: () => true,
      discover: async (request) => {
        requests.push(`${request.source}@${request.offset}:${request.includeArchived}`);
        if (request.source === "claudeAgent") throw new Error("Store unavailable");
        return request.offset === 0
          ? { items: [first], nextOffset: 50, notices: ["3 files were skipped."] }
          : { items: [second], nextOffset: null, notices: ["3 files were skipped."] };
      },
    });

    expect(requests).toEqual(["codex@0:true", "codex@50:true", "claudeAgent@0:true"]);
    expect(discovery.candidates.map((item) => [item.key, item.origin])).toEqual([
      [first.key, "codex:default"],
      [second.key, "codex:default"],
    ]);
    expect(discovery.notices).toEqual(["3 files were skipped.", "Claude Code: Store unavailable"]);
    expect(discovery.complete).toBe(true);
  });

  it("ends a store whose page does not move forward, and stops when told to", async () => {
    let calls = 0;
    const stuck = await discoverProjectImportCandidates({
      rows: [rows[0]],
      includeArchived: false,
      shouldContinue: () => true,
      discover: async () => {
        calls += 1;
        return { items: [], nextOffset: 0, notices: [] };
      },
    });
    expect(calls).toBe(1);
    expect(stuck.complete).toBe(true);

    const stopped = await discoverProjectImportCandidates({
      rows,
      includeArchived: false,
      shouldContinue: () => false,
      discover: async () => {
        throw new Error("not read");
      },
    });
    expect(stopped).toEqual({ candidates: [], notices: [], complete: false });
  });
});
