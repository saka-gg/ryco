import { ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dueAtForDay } from "./taskDue.logic";
import {
  parseTaskQuickAdd,
  resolveQuickAddProject,
  splitPastedTaskLines,
} from "./taskQuickAdd.logic";
import type { TaskProjectOption } from "./tasksViewModel";

// Sunday, Oct 18 2026.
const NOW = new Date(2026, 9, 18, 10).getTime();
const day = (date: number) => dueAtForDay(new Date(2026, 9, date).getTime());

const project = (id: string, name: string): TaskProjectOption => ({
  projectId: ProjectId.make(id),
  name,
  color: "#6366f1",
});
const RYCO = project("p-ryco", "ryco");
const INSPECT = project("p-inspect", "cs2inspect-web");
const INSPECT_API = project("p-inspect-api", "cs2inspect-api");
const PAINTS = project("p-paints", "Weapon Paints");
const PROJECTS = [RYCO, INSPECT, INSPECT_API, PAINTS];

describe("parseTaskQuickAdd", () => {
  it("returns the plain title when there are no tokens", () => {
    expect(parseTaskQuickAdd("  Fix   the login loop ", PROJECTS, NOW)).toEqual({
      title: "Fix the login loop",
      projectId: null,
      dueAt: null,
      chips: [],
    });
  });

  it("takes a project and a due day out of the title and shows them as chips", () => {
    const parsed = parseTaskQuickAdd("Fix login #ryco due:fri", PROJECTS, NOW);
    expect(parsed.title).toBe("Fix login");
    expect(parsed.projectId).toBe(RYCO.projectId);
    expect(parsed.dueAt).toBe(day(23));
    expect(parsed.chips).toEqual([
      { kind: "project", project: RYCO },
      { kind: "due", dueAt: day(23) },
    ]);
  });

  it("reads @ and due: alike, case-insensitively, with long weekday names", () => {
    expect(parseTaskQuickAdd("Ship @Tomorrow", PROJECTS, NOW).dueAt).toBe(day(19));
    expect(parseTaskQuickAdd("Ship due:today", PROJECTS, NOW).dueAt).toBe(day(18));
    expect(parseTaskQuickAdd("Ship @wednesday", PROJECTS, NOW).dueAt).toBe(day(21));
    expect(parseTaskQuickAdd("Ship @THURS", PROJECTS, NOW).dueAt).toBe(day(22));
  });

  it("puts today's own weekday a week out", () => {
    expect(parseTaskQuickAdd("Review @sun", PROJECTS, NOW).dueAt).toBe(day(25));
    expect(parseTaskQuickAdd("Review @mon", PROJECTS, NOW).dueAt).toBe(day(19));
  });

  it("matches a project by exact name or by a unique prefix", () => {
    expect(parseTaskQuickAdd("a #RYCO", PROJECTS, NOW).projectId).toBe(RYCO.projectId);
    expect(parseTaskQuickAdd("a #cs2inspect-w", PROJECTS, NOW).projectId).toBe(INSPECT.projectId);
    expect(parseTaskQuickAdd("a #weapon-paints", PROJECTS, NOW).projectId).toBe(PAINTS.projectId);
    expect(parseTaskQuickAdd("a #weap", PROJECTS, NOW).projectId).toBe(PAINTS.projectId);
  });

  it("leaves an ambiguous or unknown #token in the title", () => {
    const ambiguous = parseTaskQuickAdd("Rate limits #cs2inspect", PROJECTS, NOW);
    expect(ambiguous.projectId).toBeNull();
    expect(ambiguous.title).toBe("Rate limits #cs2inspect");
    const issue = parseTaskQuickAdd("Fix #231 on login", PROJECTS, NOW);
    expect(issue.projectId).toBeNull();
    expect(issue.title).toBe("Fix #231 on login");
  });

  it("prefers the first exact match in sidebar order", () => {
    const twin = project("p-ryco-2", "ryco");
    expect(resolveQuickAddProject("ryco", [RYCO, twin])).toBe(RYCO);
    expect(resolveQuickAddProject("ryco", [twin, RYCO])).toBe(twin);
    expect(resolveQuickAddProject("", PROJECTS)).toBeNull();
  });

  it("lets the last token of a kind win and keeps a sentence's full stop", () => {
    const parsed = parseTaskQuickAdd("Polish #ryco @mon copy #weapon @fri.", PROJECTS, NOW);
    expect(parsed.projectId).toBe(PAINTS.projectId);
    expect(parsed.dueAt).toBe(day(23));
    expect(parsed.title).toBe("Polish copy .");
    expect(parseTaskQuickAdd("Ship #ryco.", PROJECTS, NOW).title).toBe("Ship .");
  });

  it("only reads tokens that start a word", () => {
    const parsed = parseTaskQuickAdd("mail me@fri and a#ryco", PROJECTS, NOW);
    expect(parsed.dueAt).toBeNull();
    expect(parsed.projectId).toBeNull();
    expect(parsed.title).toBe("mail me@fri and a#ryco");
    expect(parseTaskQuickAdd("Plan @friday-ish", PROJECTS, NOW).dueAt).toBeNull();
  });

  it("can be all tokens and no title", () => {
    expect(parseTaskQuickAdd("#ryco @fri", PROJECTS, NOW).title).toBe("");
  });
});

describe("splitPastedTaskLines", () => {
  it("splits on any newline and drops blank lines", () => {
    expect(splitPastedTaskLines("One\r\nTwo\n\n  \nThree\r")).toEqual(["One", "Two", "Three"]);
  });

  it("strips bullet, number and checkbox markers", () => {
    expect(
      splitPastedTaskLines(
        "- Dash\n* Star\n• Bullet\n•Tight bullet\n1. One\n12) Twelve\n- [ ] Open box\n- [x] Done box",
      ),
    ).toEqual(["Dash", "Star", "Bullet", "Tight bullet", "One", "Twelve", "Open box", "Done box"]);
  });

  it("keeps text that only looks like a marker", () => {
    expect(splitPastedTaskLines("1.5x faster builds\n-flag cleanup\n*emphasis*")).toEqual([
      "1.5x faster builds",
      "-flag cleanup",
      "*emphasis*",
    ]);
  });
});
