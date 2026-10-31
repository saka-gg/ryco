import { describe, expect, it } from "vite-plus/test";

import {
  buildCommandPaletteRootGroups,
  buildCommandPaletteRows,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  isCommandPaletteActionsQuery,
  normalizeSearchText,
  type CommandPaletteSearchGroup,
} from "./search.ts";

interface Item {
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly idSearchTerms?: ReadonlyArray<string>;
  readonly disabled?: boolean;
}

function item(value: string, ...searchTerms: string[]): Item {
  return { value, searchTerms };
}

const actions = [
  item("new-task", "New task", "create", "chat"),
  item("settings", "Open settings", "preferences"),
  item("add-project", "Add project", "folder", "repository"),
];
const recent = [item("thread:recent", "Fix login", "Mobile app")];
const projects = [item("project:mobile", "Mobile app", "/work/mobile")];
const threads = [
  item("thread:one", "Keyboard shortcuts", "Mobile app", "ipad"),
  item("thread:two", "Mobile app", "Web"),
  item("thread:three", "Polish the mobile app icons", "Design"),
];

function values(groups: ReadonlyArray<CommandPaletteSearchGroup<Item>>) {
  return groups.map((group) => [group.value, group.items.map((entry) => entry.value)]);
}

function filter(query: string, isInSubmenu = false) {
  return filterCommandPaletteGroups({
    activeGroups: buildCommandPaletteRootGroups({
      actionItems: actions,
      recentThreadItems: recent,
    }),
    query,
    isInSubmenu,
    searchGroups: [
      { value: "projects-search", label: "Projects", items: projects },
      { value: "threads-search", label: "Threads", items: threads },
    ],
  });
}

describe("normalizeSearchText", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeSearchText("  Mobile \n  APP ")).toBe("mobile app");
  });
});

describe("filterCommandPaletteGroups", () => {
  it("shows the root groups unchanged while the query is empty", () => {
    expect(values(filter(""))).toEqual([
      ["actions", ["new-task", "settings", "add-project"]],
      ["recent-threads", ["thread:recent"]],
    ]);
    expect(values(filter("   "))).toEqual(values(filter("")));
  });

  it("replaces recent threads with projects and threads while typing, ranked by field and match", () => {
    expect(values(filter("mobile app"))).toEqual([
      ["projects-search", ["project:mobile"]],
      // The exact title first, then a title that contains the query, then a later field.
      ["threads-search", ["thread:two", "thread:three", "thread:one"]],
    ]);
  });

  it("matches the whole query, not separate words", () => {
    expect(values(filter("keyboard mobile"))).toEqual([]);
    expect(values(filter("shortcuts mobile"))).toEqual([["threads-search", ["thread:one"]]]);
  });

  it("narrows to actions with a leading >, with or without a query", () => {
    expect(isCommandPaletteActionsQuery("> new")).toBe(true);
    expect(isCommandPaletteActionsQuery("new")).toBe(false);
    expect(values(filter(">"))).toEqual([["actions", ["new-task", "settings", "add-project"]]]);
    expect(values(filter("> preferences"))).toEqual([["actions", ["settings"]]]);
    expect(values(filter(">mobile"))).toEqual([]);
  });

  it("keeps recent threads and skips typed groups inside a submenu", () => {
    expect(values(filter("fix", true))).toEqual([["recent-threads", ["thread:recent"]]]);
  });

  it("lists at most a typed group's limit, best matches first", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "mobile",
      isInSubmenu: false,
      searchGroups: [{ value: "threads-search", label: "Threads", items: threads, limit: 2 }],
    });
    expect(values(groups)).toEqual([["threads-search", ["thread:two", "thread:three"]]]);
  });

  it("finds an item by a whole ID or a digit-bearing fragment, after term matches", () => {
    const byId: Item = {
      value: "thread:id",
      searchTerms: ["Unrelated"],
      idSearchTerms: ["thread-0f3a9c"],
    };
    const groups = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups: [],
        query,
        isInSubmenu: false,
        searchGroups: [
          {
            value: "threads-search",
            label: "Threads",
            items: [byId, item("thread:term", "Note about 0f3a9c")],
          },
        ],
      });
    expect(values(groups("0f3a9c"))).toEqual([["threads-search", ["thread:term", "thread:id"]]]);
    expect(values(groups("thread"))).toEqual([]);
    expect(values(groups("THREAD-0F3A9C"))).toEqual([["threads-search", ["thread:id"]]]);
  });
});

describe("buildCommandPaletteRows", () => {
  it("numbers only enabled items and maps them back to their rows", () => {
    const groups = [
      {
        value: "actions",
        label: "Actions",
        items: [item("a", "A"), { ...item("b", "B"), disabled: true }, item("c", "C")],
      },
      { value: "threads", label: "Threads", items: [item("d", "D")] },
    ];
    const rows = buildCommandPaletteRows(groups);
    expect(rows.rows.map((row) => row.key)).toEqual([
      "group:actions",
      "actions:a",
      "actions:b",
      "actions:c",
      "group:threads",
      "threads:d",
    ]);
    expect(rows.itemValues).toEqual(["a", "c", "d"]);
    expect(rows.rowIndexByItemIndex).toEqual([1, 3, 5]);
    expect(findHighlightedCommandPaletteItem(groups, "c")?.value).toBe("c");
    expect(findHighlightedCommandPaletteItem(groups, "b")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, null)).toBeNull();
  });
});
