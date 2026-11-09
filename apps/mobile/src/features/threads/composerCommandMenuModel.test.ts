import { detectComposerTrigger } from "@ryco/client-runtime/state/composer";
import { ThreadId, type ServerProviderSkill } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerCommandItems,
  COMPOSER_MENU_MAX_THREADS,
  matchesSlashSkillQuery,
  resolveComposerCommandSelection,
  type ComposerCommandItem,
  type ComposerCommandOffers,
} from "./composerCommandMenuModel";

const ALL_OFFERS: ComposerCommandOffers = {
  model: true,
  interactionMode: true,
  sideChat: true,
  goal: true,
};

function skill(name: string, extra: Partial<ServerProviderSkill> = {}): ServerProviderSkill {
  return { name, path: `/skills/${name}/SKILL.md`, enabled: true, ...extra };
}

function items(
  text: string,
  overrides: Partial<Parameters<typeof buildComposerCommandItems>[0]> = {},
): ComposerCommandItem[] {
  return buildComposerCommandItems({
    trigger: detectComposerTrigger(text, text.length),
    slashCommands: [{ name: "review", description: "Review the diff" }, { name: "compact" }],
    skills: [skill("frontend-design", { shortDescription: "Distinctive UI" }), skill("pdf")],
    offers: ALL_OFFERS,
    threads: [],
    currentThreadId: null,
    pathEntries: [],
    ...overrides,
  });
}

describe("buildComposerCommandItems", () => {
  it("lists built-in and provider commands, then skills, for a bare slash", () => {
    expect(items("/").map((item) => item.label)).toEqual([
      "/model",
      "/plan",
      "/default",
      "/goal",
      "/btw",
      "/review",
      "/compact",
      "skill:frontend-design",
      "skill:pdf",
    ]);
  });

  it("ranks matching commands and skills for a slash query", () => {
    expect(items("/rev").map((item) => item.id)).toEqual(["pcmd:review"]);
    expect(items("/design").map((item) => item.id)).toEqual(["skill:frontend-design"]);
    expect(items("/skill:").map((item) => item.type)).toEqual(["skill", "skill"]);
  });

  it("leaves out built-ins the composer cannot run", () => {
    const labels = items("/", {
      offers: { model: false, interactionMode: false, sideChat: false },
    }).map((item) => item.label);
    expect(labels).not.toContain("/model");
    expect(labels).not.toContain("/plan");
    expect(labels).not.toContain("/btw");
    expect(labels).not.toContain("/goal");
    expect(labels).toContain("/review");
  });

  it("offers provider commands only at the start of the message", () => {
    const labels = items("first line\n/").map((item) => item.label);
    expect(labels).toContain("/plan");
    expect(labels).not.toContain("/review");
  });

  it("ranks skills for a dollar trigger and skips disabled ones", () => {
    expect(
      items("use $fr", {
        skills: [skill("frontend-design"), skill("fresh", { enabled: false })],
      }).map((item) => item.label),
    ).toEqual(["Frontend Design"]);
  });

  it("puts matching recent threads before workspace files for an at trigger", () => {
    const threads = [
      { id: ThreadId.make("a"), title: "Fix login", createdAt: "2026-11-01", archivedAt: null },
      {
        id: ThreadId.make("b"),
        title: "Login copy",
        createdAt: "2026-11-01",
        updatedAt: "2026-11-05",
        archivedAt: null,
      },
      { id: ThreadId.make("c"), title: "Login old", createdAt: "2026-11-02", archivedAt: "x" },
      { id: ThreadId.make("d"), title: "Login here", createdAt: "2026-11-09", archivedAt: null },
    ];
    const result = items("see @login", {
      threads,
      currentThreadId: ThreadId.make("d"),
      pathEntries: [{ path: "src/login.ts", kind: "file", parentPath: "src" }],
    });
    expect(result.map((item) => item.id)).toEqual([
      "thread:b",
      "thread:a",
      "path:file:src/login.ts",
    ]);
    expect(result[2]).toMatchObject({ label: "login.ts", description: "src" });
  });

  it("caps thread rows", () => {
    const threads = Array.from({ length: 9 }, (_, index) => ({
      id: ThreadId.make(`t${index}`),
      title: `Thread ${index}`,
      createdAt: `2026-11-0${index}`,
      archivedAt: null,
    }));
    expect(items("@", { threads })).toHaveLength(COMPOSER_MENU_MAX_THREADS);
  });

  it("lists nothing for source-control triggers or plain text", () => {
    expect(items("#12")).toEqual([]);
    expect(items("hello")).toEqual([]);
  });
});

describe("matchesSlashSkillQuery", () => {
  it("treats the skill prefix as a filter for skills", () => {
    expect(matchesSlashSkillQuery(skill("pdf"), "skill")).toBe(true);
    expect(matchesSlashSkillQuery(skill("pdf"), "skill:pd")).toBe(true);
    expect(matchesSlashSkillQuery(skill("pdf"), "skill:x")).toBe(false);
    expect(matchesSlashSkillQuery(skill("pdf", { enabled: false }), "")).toBe(false);
  });
});

describe("resolveComposerCommandSelection", () => {
  function pick(text: string, cursor: number, item: ComposerCommandItem) {
    const trigger = detectComposerTrigger(text, cursor);
    if (!trigger) throw new Error("no trigger");
    return resolveComposerCommandSelection({ draft: text, trigger, item });
  }

  it("inserts a file mention, quoting paths with spaces", () => {
    const item = items("@x", {
      pathEntries: [{ path: "docs/my notes.md", kind: "file" }],
    })[0]!;
    expect(pick("read @x please", 7, item)).toEqual({
      text: 'read @"docs/my notes.md" please',
      cursor: 25,
      action: null,
    });
  });

  it("inserts a thread mention token", () => {
    const item = items("@fix", {
      threads: [{ id: ThreadId.make("abc"), title: "Fix", createdAt: "x", archivedAt: null }],
    })[0]!;
    expect(pick("@fix", 4, item).text).toBe("@thread:abc ");
  });

  it("inserts skills and provider commands with a trailing space", () => {
    const skillItem = items("$pd")[0]!;
    expect(pick("$pd", 3, skillItem)).toMatchObject({ text: "$pdf ", cursor: 5 });
    const command = items("/rev")[0]!;
    expect(pick("/rev", 4, command)).toMatchObject({ text: "/review ", cursor: 8 });
  });

  it("turns built-ins into actions and removes the typed token", () => {
    const plan = items("/pla").find((item) => item.id === "cmd:plan")!;
    expect(pick("/pla", 4, plan)).toEqual({
      text: "",
      cursor: 0,
      action: { kind: "interaction-mode", mode: "plan" },
    });
    const model = items("/mod").find((item) => item.id === "cmd:model")!;
    expect(pick("/mod", 4, model).action).toEqual({ kind: "open-model-picker" });
  });

  it("writes /goal out so its objective can follow", () => {
    const goal = items("/go").find((item) => item.id === "cmd:goal")!;
    expect(pick("/go", 3, goal)).toEqual({ text: "/goal ", cursor: 6, action: null });
  });
});
