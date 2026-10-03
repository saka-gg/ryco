import { describe, expect, it } from "vitest";

import {
  diffPickerSelection,
  filterPickerCandidates,
  pickerCandidates,
  reviewerRows,
} from "./peopleFacts.logic";

describe("diffPickerSelection", () => {
  it("returns null when nothing changed, whatever the order", () => {
    expect(diffPickerSelection(["a", "b"], ["b", "a"])).toBeNull();
    expect(diffPickerSelection([], [])).toBeNull();
  });

  it("adds in picked order and removes in original order", () => {
    expect(diffPickerSelection(["a", "b", "c"], ["c", "e", "d"])).toEqual({
      add: ["e", "d"],
      remove: ["a", "b"],
    });
  });

  it("collapses duplicates", () => {
    expect(diffPickerSelection(["a", "a"], ["b", "b"])).toEqual({ add: ["b"], remove: ["a"] });
  });
});

describe("reviewerRows", () => {
  it("puts verdicts first, then pending requests, teams after people", () => {
    const rows = reviewerRows({
      reviewerStates: [
        { login: "org/web", kind: "team", state: "requested", isCodeOwner: true },
        { login: "pat", kind: "user", state: "requested" },
        { login: "mara", kind: "user", state: "approved" },
        { login: "eliot", kind: "user", state: "changes_requested" },
      ],
      reviewers: undefined,
    });
    expect(rows.map((row) => [row.login, row.state, row.isCodeOwner, row.canRerequest])).toEqual([
      ["eliot", "changes_requested", false, true],
      ["mara", "approved", false, true],
      ["pat", "requested", false, false],
      ["org/web", "requested", true, false],
    ]);
  });

  it("falls back to plain requested logins", () => {
    expect(
      reviewerRows({ reviewerStates: [], reviewers: ["pat", "org/web"] }).map((row) => [
        row.login,
        row.kind,
        row.state,
      ]),
    ).toEqual([
      ["pat", "user", "requested"],
      ["org/web", "team", "requested"],
    ]);
  });
});

describe("picker candidates", () => {
  it("keeps selected values (even unoffered ones) and drops excluded ones", () => {
    expect(
      pickerCandidates({
        offered: ["a", "author", "b"],
        selected: ["org/team", "a"],
        exclude: ["author"],
      }),
    ).toEqual(["org/team", "a", "b"]);
  });

  it("filters by value or description and pins selected values on top", () => {
    const describe_ = (value: string) => ({ mv: "Mara Vogt", tk: "Tom Kessler" })[value] ?? value;
    expect(filterPickerCandidates(["mv", "tk", "jw"], ["tk"], "", describe_)).toEqual([
      "tk",
      "mv",
      "jw",
    ]);
    expect(filterPickerCandidates(["mv", "tk", "jw"], [], "vogt", describe_)).toEqual(["mv"]);
    expect(filterPickerCandidates(["mv", "tk"], [], "  TK ", describe_)).toEqual(["tk"]);
  });
});
