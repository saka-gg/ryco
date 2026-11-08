import { describe, expect, it } from "vitest";

import { pullRequestLiveChecksIntervalMs } from "./pullRequestCheckRingModel";

import {
  applyCompletion,
  completionTokenAt,
  rankPeople,
  rankReferences,
} from "./pullRequestCompletionModel";
import {
  derivePullRequestReviewers,
  pullRequestDetailsEdit,
  pullRequestListEdit,
} from "./pullRequestPeopleModel";

describe("completion", () => {
  it("finds the @ or # token at the cursor, and nothing inside a word", () => {
    expect(completionTokenAt("cc @oct", 7)).toEqual({
      trigger: "@",
      query: "oct",
      start: 3,
      end: 7,
    });
    expect(completionTokenAt("fixes #12", 9)).toEqual({
      trigger: "#",
      query: "12",
      start: 6,
      end: 9,
    });
    expect(completionTokenAt("(#", 2)?.trigger).toBe("#");
    expect(completionTokenAt("mail@host", 9)).toBeNull();
    expect(completionTokenAt("@oct and more", 13)).toBeNull();
  });

  it("replaces the token and leaves the cursor after a space", () => {
    const token = completionTokenAt("cc @oc please", 6)!;
    expect(applyCompletion("cc @oc please", token, { insert: "@octocat" })).toEqual({
      text: "cc @octocat please",
      cursor: 12,
    });
    const end = completionTokenAt("see #4", 6)!;
    expect(applyCompletion("see #4", end, { insert: "#42" })).toEqual({
      text: "see #42 ",
      cursor: 8,
    });
  });

  it("ranks people by login prefix, then name, then substring", () => {
    const people = [
      { login: "zed", displayName: "Octavia Z" },
      { login: "bob-oct" },
      { login: "octocat" },
      { login: "amy" },
    ];
    expect(rankPeople(people, "oct").map((entry) => entry.title)).toEqual([
      "octocat",
      "zed",
      "bob-oct",
    ]);
  });

  it("matches references by number prefix or title words", () => {
    const items = [
      { number: 42, title: "Fix login", kind: "issue" as const },
      { number: 420, title: "Speed up", kind: "pull request" as const },
      { number: 7, title: "Login page", kind: "pull request" as const },
    ];
    expect(rankReferences(items, "42").map((entry) => entry.insert)).toEqual(["#42", "#420"]);
    expect(rankReferences(items, "login").map((entry) => entry.insert)).toEqual(["#42", "#7"]);
  });
});

describe("people", () => {
  it("computes the add/remove edit, or null when nothing changed", () => {
    expect(pullRequestListEdit(["a", "b"], ["b", "c"])).toEqual({ add: ["c"], remove: ["a"] });
    expect(pullRequestListEdit(["a"], ["a"])).toBeNull();
  });

  it("edits from what the picker opened with, so a label added meanwhile stays", () => {
    // Opened with [bug]; someone adds "urgent" while the sheet is open; the
    // reader adds "ui". Diffing against the opening list leaves "urgent" alone.
    expect(pullRequestListEdit(["bug"], ["bug", "ui"])).toEqual({ add: ["ui"], remove: [] });
  });

  it("sends only the title or description the reader changed", () => {
    const start = { title: "Fix login", body: "Old body" };
    expect(pullRequestDetailsEdit(start, { title: " Fix login now ", body: "Old body" })).toEqual({
      kind: "edit",
      title: "Fix login now",
    });
    expect(pullRequestDetailsEdit(start, { title: "Fix login", body: "New" })).toEqual({
      kind: "edit",
      body: "New",
    });
    expect(pullRequestDetailsEdit(start, { title: "Fix login ", body: "Old body" })).toBeNull();
  });

  it("lists reviewers with their state, requested ones as pending", () => {
    expect(
      derivePullRequestReviewers({
        reviewers: ["zoe", "amy"],
        reviewerStates: [
          { login: "amy", kind: "user", state: "approved" },
          { login: "kim", kind: "user", state: "changes_requested" },
        ],
      }),
    ).toEqual([
      { login: "amy", state: "approved" },
      { login: "kim", state: "changes-requested" },
      { login: "zoe", state: "pending" },
    ]);
  });
});

describe("live checks", () => {
  it("reads sooner while checks run or none are reported yet", () => {
    expect(pullRequestLiveChecksIntervalMs("pending")).toBe(45_000);
    expect(pullRequestLiveChecksIntervalMs("none")).toBe(45_000);
    expect(pullRequestLiveChecksIntervalMs("passing")).toBe(60_000);
  });
});
