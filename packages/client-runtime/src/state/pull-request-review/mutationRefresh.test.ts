import type { ChangeRequestUpdateAction } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveChangeRequestRefreshScope,
  type ChangeRequestRefreshScope,
} from "./mutationRefresh.ts";

const NONE: ChangeRequestRefreshScope = {
  checkout: false,
  detail: false,
  activity: false,
  lists: false,
};
const CHECKOUT: ChangeRequestRefreshScope = { ...NONE, checkout: true };
const ACTIVITY: ChangeRequestRefreshScope = { ...NONE, activity: true };
const ACTIVITY_AND_LISTS: ChangeRequestRefreshScope = { ...NONE, activity: true, lists: true };

function update(action: ChangeRequestUpdateAction) {
  return resolveChangeRequestRefreshScope({ kind: "update", action });
}

describe("resolveChangeRequestRefreshScope", () => {
  it("refreshes only the activity for comments, reactions, edits, and replies", () => {
    for (const kind of ["comment", "comment-update", "reaction", "thread-reply"] as const) {
      expect(resolveChangeRequestRefreshScope({ kind })).toEqual(ACTIVITY);
    }
  });

  it("refreshes the detail with the activity when a thread is resolved", () => {
    expect(resolveChangeRequestRefreshScope({ kind: "thread-resolve" })).toEqual({
      ...ACTIVITY,
      detail: true,
    });
  });

  it("refreshes detail, activity, and lists after a review, never the checkout", () => {
    expect(resolveChangeRequestRefreshScope({ kind: "review" })).toEqual({
      checkout: false,
      detail: true,
      activity: true,
      lists: true,
    });
  });

  it("refreshes the activity and list rows for metadata and state actions", () => {
    const actions: ReadonlyArray<ChangeRequestUpdateAction> = [
      { kind: "labels", add: ["ui"], remove: [] },
      { kind: "assignees", add: ["octocat"], remove: [] },
      { kind: "reviewers", add: [], remove: ["mvogt"] },
      { kind: "set-draft", draft: false },
      { kind: "close" },
      { kind: "close", deleteBranch: true },
      { kind: "reopen" },
      { kind: "edit", title: "Renamed" },
      { kind: "edit", title: "Renamed", body: "Body" },
    ];
    for (const action of actions) expect(update(action)).toEqual(ACTIVITY_AND_LISTS);
  });

  it("refreshes nothing for a body-only edit (the host returns the fresh detail)", () => {
    expect(update({ kind: "edit", body: "- [x] task" })).toEqual(NONE);
  });

  it("refreshes only the activity for auto-merge and branch deletion", () => {
    expect(update({ kind: "auto-merge", enabled: true, mergeMethod: "squash" })).toEqual(ACTIVITY);
    expect(update({ kind: "auto-merge", enabled: false })).toEqual(ACTIVITY);
    expect(update({ kind: "delete-branch" })).toEqual(ACTIVITY);
  });

  it("invalidates the checkout when the head or base moves", () => {
    expect(update({ kind: "update-branch", method: "merge", expectedHeadSha: "abc" })).toEqual(
      CHECKOUT,
    );
    expect(update({ kind: "edit", baseRefName: "release" })).toEqual(CHECKOUT);
  });

  it("escalates to the checkout when the returned detail merged or moved the head", () => {
    const action: ChangeRequestUpdateAction = { kind: "auto-merge", enabled: true };
    expect(
      resolveChangeRequestRefreshScope({
        kind: "update",
        action,
        previous: { state: "open", headSha: "a" },
        next: { state: "merged", headSha: "a" },
      }),
    ).toEqual(CHECKOUT);
    expect(
      resolveChangeRequestRefreshScope({
        kind: "update",
        action: { kind: "labels", add: ["ui"], remove: [] },
        previous: { state: "open", headSha: "a" },
        next: { state: "open", headSha: "b" },
      }),
    ).toEqual(CHECKOUT);
    // Unknown previous head (summary not loaded) does not escalate.
    expect(
      resolveChangeRequestRefreshScope({
        kind: "update",
        action: { kind: "labels", add: ["ui"], remove: [] },
        previous: null,
        next: { state: "open", headSha: "b" },
      }),
    ).toEqual(ACTIVITY_AND_LISTS);
  });
});
