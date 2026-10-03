import { describe, expect, it } from "vitest";

import {
  applyTaskToggles,
  readTaskState,
  rebaseTaskToggle,
  sameTextIgnoringTaskStates,
  setTaskState,
} from "./markdownTasks";

const body = ["Intro", "", "- [x] First", "- [ ] Second", "> 1. [X] Quoted", "- [\t] Tab"].join(
  "\n",
);
/** Offset of the state character that ends `prefix`. */
const at = (text: string, prefix: string) => text.indexOf(prefix) + prefix.length - 1;
const FIRST = at(body, "- [x");
const SECOND = at(body, "- [ ");
const QUOTED = at(body, "1. [X");
const TAB = at(body, "- [\t");

describe("readTaskState / setTaskState", () => {
  it("reads and rewrites only the state character between brackets", () => {
    expect([FIRST, SECOND, QUOTED, TAB].map((offset) => readTaskState(body, offset))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    const next = setTaskState(body, SECOND, true);
    expect(next.split("\n")[3]).toBe("- [x] Second");
    expect(setTaskState(next, SECOND, false)).toBe(body);
    expect(setTaskState(body, QUOTED, false).split("\n")[4]).toBe("> 1. [ ] Quoted");
    expect(setTaskState(body, TAB, true).split("\n")[5]).toBe("- [x] Tab");
  });

  it("returns the same string for a no-op or an offset that is not a box", () => {
    expect(setTaskState(body, FIRST, true)).toBe(body);
    expect(setTaskState(body, 0, true)).toBe(body);
    expect(setTaskState(body, body.length + 4, true)).toBe(body);
    expect(readTaskState(body, Number.NaN)).toBeNull();
  });

  it("handles CRLF bodies", () => {
    const crlf = "- [ ] One\r\n- [ ] Two\r\n";
    expect(setTaskState(crlf, at(crlf, "\n- [ "), true)).toBe("- [ ] One\r\n- [x] Two\r\n");
  });
});

describe("sameTextIgnoringTaskStates", () => {
  it("accepts bodies that differ only in ticked boxes", () => {
    const ticked = setTaskState(setTaskState(body, SECOND, true), FIRST, false);
    expect(sameTextIgnoringTaskStates(body, ticked)).toBe(true);
  });

  it("rejects any other edit, even one of the same length", () => {
    expect(sameTextIgnoringTaskStates(body, body.replace("Intro", "Outro"))).toBe(false);
    expect(sameTextIgnoringTaskStates(body, `${body}\n- [ ] Third`)).toBe(false);
    expect(sameTextIgnoringTaskStates("[a]", "[b]")).toBe(false);
  });
});

describe("rebaseTaskToggle / applyTaskToggles", () => {
  it("applies onto a newer body that only ticked other boxes, keeping those ticks", () => {
    const teammate = setTaskState(body, QUOTED, false);
    expect(rebaseTaskToggle(teammate, { base: body, offset: SECOND, checked: true })).toBe(
      setTaskState(teammate, SECOND, true),
    );
  });

  it("refuses a body whose text changed since the click", () => {
    // Same length, so the old offset now lands on a different task.
    const edited = body.replace("- [x] First", "- [x] Fir5t");
    expect(rebaseTaskToggle(edited, { base: body, offset: SECOND, checked: true })).toBeNull();
    const longer = `Lead\n${body}`;
    expect(rebaseTaskToggle(longer, { base: body, offset: SECOND, checked: true })).toBeNull();
  });

  it("applies toggles in order and counts the ones it had to skip", () => {
    const toggles = [
      { base: body, offset: SECOND, checked: true },
      { base: body, offset: SECOND, checked: false },
      { base: body, offset: FIRST, checked: false },
      { base: "something else", offset: TAB, checked: true },
    ];
    expect(applyTaskToggles(body, toggles)).toEqual({
      body: setTaskState(body, FIRST, false),
      rejected: 1,
    });
  });
});
