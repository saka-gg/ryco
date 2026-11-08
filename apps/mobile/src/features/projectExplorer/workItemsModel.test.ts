import type { AtlassianProjectLink, WorkItemDetail, WorkItemSummary } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  deriveWorkItemDetail,
  deriveWorkItemDetailItems,
  filterWorkItems,
  isJiraConfigured,
  planWorkItemSearch,
  transitionLabel,
  workItemRow,
} from "./workItemsModel";

const AT = DateTime.makeUnsafe("2026-11-01T10:00:00Z");

function item(key: string, title: string, extra?: Partial<WorkItemSummary>): WorkItemSummary {
  return {
    provider: "jira",
    key,
    title,
    url: `https://acme.atlassian.net/browse/${key}`,
    state: "open",
    assignee: null,
    updatedAt: Option.some(AT),
    ...extra,
  } as WorkItemSummary;
}

const ITEMS = [
  item("APP-1", "Login fails", { issueType: "Bug" }),
  item("APP-2", "Dark mode", { issueType: "Story" }),
];

describe("isJiraConfigured", () => {
  const link = {
    jiraConnectionId: "conn",
    jiraProjectKeys: ["APP"],
  } as unknown as AtlassianProjectLink;

  it("needs a Jira connection and at least one Jira project", () => {
    expect(isJiraConfigured(link)).toBe(true);
    expect(isJiraConfigured({ ...link, jiraProjectKeys: [] })).toBe(false);
    expect(isJiraConfigured({ ...link, jiraConnectionId: null })).toBe(false);
    expect(isJiraConfigured(null)).toBe(false);
  });
});

describe("work item search", () => {
  it("matches key, title and type", () => {
    expect(filterWorkItems(ITEMS, "app-2").map((entry) => entry.key)).toEqual(["APP-2"]);
    expect(filterWorkItems(ITEMS, "bug").map((entry) => entry.key)).toEqual(["APP-1"]);
    expect(filterWorkItems(ITEMS, " ")).toBe(ITEMS);
  });

  it("asks the host only when nothing read matches a settled query", () => {
    expect(
      planWorkItemSearch({ items: ITEMS, query: "login", settledQuery: "login" }).searchHost,
    ).toBe(false);
    expect(
      planWorkItemSearch({ items: ITEMS, query: "billing", settledQuery: "billing" }).searchHost,
    ).toBe(true);
  });
});

describe("workItemRow", () => {
  it("prefers Jira's own status name and the priority's name", () => {
    expect(
      workItemRow(
        item("APP-3", "Crash", {
          state: "in_progress",
          stateName: "In review",
          priority: "P1",
          priorityDetail: { name: "Highest" },
          labels: ["a", "b", "c", "d"],
        }),
      ),
    ).toMatchObject({
      stateLabel: "In review",
      tone: "progress",
      priority: "Highest",
      labels: ["a", "b", "c"],
      moreLabels: 1,
    });
  });
});

describe("one work item", () => {
  const detail = {
    ...item("APP-1", "Login fails", { issueType: "Bug", reporter: "Alice", state: "done" }),
    description: "Steps",
    comments: [{ id: "1", author: "Bob", body: "On it", createdAt: AT }],
    transitions: [{ id: "31", name: "Done", toState: "done", toStateName: "Done" }],
    linkedChangeRequests: [
      { provider: "github", number: 40, title: "Fix login", url: "u", state: "merged" },
    ],
    editableFields: [],
    activity: [],
    truncated: false,
  } as unknown as WorkItemDetail;

  it("lists its fields, saying who it is assigned to", () => {
    const view = deriveWorkItemDetail(detail);
    expect(view.fields).toEqual([
      { label: "Type", value: "Bug" },
      { label: "Assignee", value: "Unassigned" },
      { label: "Reporter", value: "Alice" },
    ]);
    expect(view).toMatchObject({ stateLabel: "Done", tone: "done", description: "Steps" });
  });

  it("lists the description, linked pull requests and comments", () => {
    expect(
      deriveWorkItemDetailItems(deriveWorkItemDetail(detail)).map((entry) => entry.key),
    ).toEqual(["description", "linked", "l:github:40", "comments", "c:1"]);
  });

  it("names a transition and its target once", () => {
    expect(transitionLabel({ id: "1", name: "Done", toState: "done", toStateName: "Done" })).toBe(
      "Done",
    );
    expect(
      transitionLabel({
        id: "2",
        name: "Start work",
        toState: "in_progress",
        toStateName: "Doing",
      }),
    ).toBe("Start work → Doing");
  });
});
