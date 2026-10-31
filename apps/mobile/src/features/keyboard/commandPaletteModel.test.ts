import type { Project, SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts/base-schemas";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCommandPaletteSources,
  commandPaletteHighlightIndex,
  commandPaletteItemForKey,
  commandPaletteRowLayouts,
  COMMAND_PALETTE_ITEM_ROW_HEIGHT,
  COMMAND_PALETTE_LABEL_ROW_HEIGHT,
  searchCommandPalette,
  stepCommandPaletteHighlight,
  type CommandPaletteItem,
} from "./commandPaletteModel";

const node = EnvironmentId.make("node");
const laptop = EnvironmentId.make("laptop");

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make(id),
    environmentId: node,
    name,
    cwd: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    ...overrides,
  } as Project;
}

function thread(
  id: string,
  title: string,
  updatedAt: string,
  overrides: Record<string, unknown> = {},
): SidebarThreadOrStub {
  return {
    id: ThreadId.make(id),
    environmentId: node,
    projectId: ProjectId.make("mobile"),
    title,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    latestUserMessageAt: updatedAt,
    archivedAt: null,
    branch: null,
    ...overrides,
  } as unknown as SidebarThreadOrStub;
}

const projects = [
  project("mobile", "Mobile app"),
  project("web", "Web app"),
  project("chats", "No project", { kind: "chat" }),
];
const threads = [
  thread("older", "Polish the mobile app icons", "2026-10-20T00:00:00.000Z"),
  thread("newest", "Keyboard shortcuts", "2026-10-30T00:00:00.000Z", { branch: "ipad-keys" }),
  thread("archived", "Old mobile work", "2026-10-31T00:00:00.000Z", {
    archivedAt: "2026-10-31T00:00:00.000Z",
  }),
  thread("web-thread", "Mobile app", "2026-10-25T00:00:00.000Z", {
    projectId: ProjectId.make("web"),
  }),
];

function sources(overrides: Partial<Parameters<typeof buildCommandPaletteSources>[0]> = {}) {
  return buildCommandPaletteSources({
    projects,
    threads,
    machineLabels: new Map([[node, "Studio"]]),
    activeThread: null,
    threadCommands: [],
    ...overrides,
  });
}

function shown(query: string, input = sources()) {
  return searchCommandPalette(input, query).rows.map((row) =>
    row.kind === "label" ? `# ${row.label}` : row.item.value,
  );
}

describe("command palette sources", () => {
  it("opens on actions, then recent threads newest first without archived ones", () => {
    expect(shown("")).toEqual([
      "# Actions",
      "action:new-task",
      "action:add-project",
      "action:machines",
      "action:settings:Settings",
      "action:settings:SettingsAppearance",
      "action:settings:SettingsWorkspace",
      "action:settings:SettingsProviderAccounts",
      "action:settings:SettingsInbox",
      "action:settings:SettingsStatistics",
      "# Recent Threads",
      "thread:node:newest",
      "thread:node:web-thread",
      "thread:node:older",
    ]);
  });

  it("searches projects and threads while typing, ranked like the web palette", () => {
    expect(shown("mobile app")).toEqual([
      "# Projects",
      "project:node:mobile",
      "# Threads",
      // The exact title, a title containing the query, then a match on the project only.
      "thread:node:web-thread",
      "thread:node:older",
      "thread:node:newest",
    ]);
    // A thread's branch and ID find it too; the "No project" chats are not a project to open.
    expect(shown("ipad-keys")).toEqual(["# Threads", "thread:node:newest"]);
    expect(shown("no project")).toEqual([]);
  });

  it("shows only actions after a leading >", () => {
    expect(shown("> appearance")).toEqual(["# Actions", "action:settings:SettingsAppearance"]);
    expect(shown("> mobile")).toEqual([]);
  });

  it("offers the open thread's project and tools, and marks the thread", () => {
    const input = sources({
      activeThread: { environmentId: node, threadId: ThreadId.make("newest") },
      threadCommands: ["files", "review"],
    });
    const rows = searchCommandPalette(input, "");
    const items = rows.rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
    expect(items.slice(0, 2).map((item) => [item.title, item.intent])).toEqual([
      ["New task in Mobile app", { type: "newTask", environmentId: node, projectId: "mobile" }],
      ["New task", { type: "newTask" }],
    ]);
    expect(items.map((item) => item.value)).toEqual(
      expect.arrayContaining(["action:files", "action:review"]),
    );
    expect(items.map((item) => item.value)).not.toContain("action:terminal");
    expect(items.find((item) => item.value === "thread:node:newest")?.detail).toBe(
      "Mobile app · #ipad-keys · Current thread",
    );
  });

  it("names the machine beside threads and projects once there is more than one", () => {
    const input = sources({
      machineLabels: new Map([
        [node, "Studio"],
        [laptop, "Laptop"],
      ]),
    });
    const items = searchCommandPalette(input, "mobile").rows.flatMap((row) =>
      row.kind === "item" ? [row.item] : [],
    );
    expect(items.find((item) => item.value === "project:node:mobile")?.detail).toBe(
      "/work/mobile · Studio",
    );
    expect(items.find((item) => item.value === "thread:node:older")?.detail).toBe(
      "Mobile app · Studio",
    );
  });
});

describe("command palette keys", () => {
  const rows = searchCommandPalette(sources(), "mobile app");
  const values = rows.itemValues;

  it("highlights the first result until another is chosen, and keeps a listed choice", () => {
    expect(commandPaletteHighlightIndex(values, null)).toBe(0);
    expect(commandPaletteHighlightIndex(values, "thread:node:older")).toBe(2);
    expect(commandPaletteHighlightIndex(values, "gone")).toBe(0);
    expect(commandPaletteHighlightIndex([], null)).toBe(-1);
  });

  it("wraps the arrow keys at both ends", () => {
    expect(stepCommandPaletteHighlight(values, null, 1)).toBe("thread:node:web-thread");
    expect(stepCommandPaletteHighlight(values, null, -1)).toBe("thread:node:newest");
    expect(stepCommandPaletteHighlight(values, "thread:node:newest", 1)).toBe(
      "project:node:mobile",
    );
    expect(stepCommandPaletteHighlight([], null, 1)).toBeNull();
  });

  it("picks the highlighted item on Return and the numbered one on Command-1…9", () => {
    const pick = (key: Parameters<typeof commandPaletteItemForKey>[2], highlighted = null) =>
      (commandPaletteItemForKey(rows, highlighted, key) as CommandPaletteItem | null)?.value ??
      null;
    expect(pick("return")).toBe("project:node:mobile");
    expect(commandPaletteItemForKey(rows, "thread:node:older", "return")?.value).toBe(
      "thread:node:older",
    );
    expect(pick("thread.jump.2")).toBe("thread:node:web-thread");
    expect(pick("thread.jump.4")).toBe("thread:node:newest");
    expect(pick("thread.jump.5")).toBeNull();
    expect(pick("paletteNext")).toBeNull();
    expect(commandPaletteItemForKey(searchCommandPalette(sources(), "zzz"), null, "return")).toBe(
      null,
    );
  });
});

describe("commandPaletteRowLayouts", () => {
  it("stacks label and item rows at their fixed heights", () => {
    const rows = searchCommandPalette(sources(), "mobile app").rows;
    const layouts = commandPaletteRowLayouts(rows);
    const label = COMMAND_PALETTE_LABEL_ROW_HEIGHT;
    const item = COMMAND_PALETTE_ITEM_ROW_HEIGHT;
    expect(layouts.map((layout) => layout.offset)).toEqual([
      0,
      label,
      label + item,
      2 * label + item,
      2 * label + 2 * item,
      2 * label + 3 * item,
    ]);
    expect(layouts.at(-1)?.length).toBe(item);
  });
});
