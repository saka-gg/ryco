import type { SourceControlIssueDetail, SourceControlIssueSummary } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  applyPolishedIssueContent,
  assigneeOptions,
  buildCreateIssueInput,
  buildPolishIssueInput,
  commentBodyToSend,
  deriveIssueDetail,
  deriveIssueDetailItems,
  deriveIssueListScreen,
  EMPTY_NEW_ISSUE_DRAFT,
  issueListRow,
  planIssueSearch,
  toggleValue,
  type IssueRead,
} from "./issuesModel";

const AT = DateTime.makeUnsafe("2026-11-01T10:00:00Z");

function issue(number: number, title: string, extra?: Partial<SourceControlIssueSummary>) {
  return {
    provider: "github",
    number,
    title,
    url: `https://github.com/acme/app/issues/${number}`,
    state: "open",
    updatedAt: Option.some(AT),
    ...extra,
  } as SourceControlIssueSummary;
}

type Rows = ReadonlyArray<SourceControlIssueSummary>;

function read(data: Rows | null, extra?: Partial<IssueRead<Rows>>): IssueRead<Rows> {
  return { data, error: null, isLoading: false, ...extra };
}

const ISSUES = [issue(12, "Login fails on Safari"), issue(7, "Dark mode colors")];

describe("issue rows", () => {
  it("shows three labels with their tint and counts the rest", () => {
    const row = issueListRow(
      issue(3, "Crash", {
        author: "alice",
        commentsCount: 4,
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "p1" },
          { name: "ios", color: "#00ff00" },
          { name: "extra" },
        ],
      }),
    );
    expect(row).toMatchObject({
      key: "github:3",
      author: "alice",
      comments: 4,
      moreLabels: 1,
      updatedAtMs: DateTime.toEpochMillis(AT),
    });
    expect(row.labels.map((label) => label.name)).toEqual(["bug", "p1", "ios"]);
    expect(row.labels[0]?.colors?.borderColor).toBe("rgba(215, 58, 74, 0.35)");
    expect(row.labels[1]?.colors).toBeNull();
  });
});

describe("planIssueSearch", () => {
  it("narrows what was read and leaves the host alone while something matches", () => {
    const plan = planIssueSearch({ items: ISSUES, query: "safari", settledQuery: "safari" });
    expect(plan.local.map((entry) => entry.number)).toEqual([12]);
    expect(plan.searchHost).toBe(false);
  });

  it("asks the host once a settled query matches nothing read", () => {
    expect(
      planIssueSearch({ items: ISSUES, query: "keyboard", settledQuery: "keyboard" }).searchHost,
    ).toBe(true);
    expect(planIssueSearch({ items: ISSUES, query: "kz", settledQuery: "k" }).searchHost).toBe(
      false,
    );
  });
});

describe("deriveIssueListScreen", () => {
  it("lists the read rows", () => {
    const plan = planIssueSearch({ items: ISSUES, query: "", settledQuery: "" });
    const screen = deriveIssueListScreen({
      list: read(ISSUES),
      search: read(null),
      plan,
      query: "",
      state: "open",
    });
    expect(screen.status).toBe("ready");
    expect(screen.rows.map((row) => row.number)).toEqual([12, 7]);
  });

  it("is loading until the first read lands", () => {
    const plan = planIssueSearch({ items: [], query: "", settledQuery: "" });
    expect(
      deriveIssueListScreen({
        list: read(null),
        search: read(null),
        plan,
        query: "",
        state: "open",
      }).status,
    ).toBe("loading");
  });

  it("answers a host search with the host's rows", () => {
    const plan = planIssueSearch({ items: ISSUES, query: "keyboard", settledQuery: "keyboard" });
    const screen = deriveIssueListScreen({
      list: read(ISSUES),
      search: read([issue(99, "Keyboard covers composer")]),
      plan,
      query: "keyboard",
      state: "open",
    });
    expect(screen.rows.map((row) => row.number)).toEqual([99]);
  });

  it("says why it is empty", () => {
    const plan = planIssueSearch({ items: [], query: "", settledQuery: "" });
    const screen = deriveIssueListScreen({
      list: read([]),
      search: read(null),
      plan,
      query: "",
      state: "closed",
    });
    expect(screen).toMatchObject({ status: "empty", emptyTitle: "No closed issues" });
  });

  it("states a failed read and keeps the rows already read", () => {
    const plan = planIssueSearch({ items: ISSUES, query: "", settledQuery: "" });
    const failed = deriveIssueListScreen({
      list: read(null, { error: new Error("HTTP 500") }),
      search: read(null),
      plan: planIssueSearch({ items: [], query: "", settledQuery: "" }),
      query: "",
      state: "open",
    });
    expect(failed.status).toBe("problem");
    expect(failed.problem?.detail).toBe("HTTP 500");
    const stale = deriveIssueListScreen({
      list: read(ISSUES, { error: new Error("HTTP 500") }),
      search: read(null),
      plan,
      query: "",
      state: "open",
    });
    expect(stale.status).toBe("ready");
    expect(stale.problem).not.toBeNull();
  });
});

describe("one issue", () => {
  const detail: SourceControlIssueDetail = {
    ...issue(12, "Login fails on Safari", {
      state: "closed",
      author: "alice",
      assignees: ["bob"],
      labels: [{ name: "bug" }],
    }),
    body: "Steps:\n1. Open Safari",
    comments: [
      { id: "c1", author: "bob", body: "Repro'd", createdAt: AT },
      { author: "carol", body: "Fixed", createdAt: AT },
    ],
    truncated: true,
    linkedChangeRequestNumbers: [40],
  };

  it("derives the header, body and comments", () => {
    const view = deriveIssueDetail(detail);
    expect(view.header).toMatchObject({
      number: 12,
      state: "closed",
      stateLabel: "Closed",
      author: "alice",
      assignees: ["bob"],
      hostName: "GitHub",
      linkedPullRequests: [40],
    });
    expect(view.body).toBe("Steps:\n1. Open Safari");
    expect(view.comments.map((comment) => comment.key)).toEqual(["c1", "comment-1"]);
  });

  it("lists the body, the comments and a note for a shortened issue", () => {
    const items = deriveIssueDetailItems(deriveIssueDetail(detail));
    expect(items.map((item) => item.kind)).toEqual([
      "body",
      "section",
      "comment",
      "comment",
      "note",
    ]);
    expect(deriveIssueDetailItems(null)).toEqual([]);
  });

  it("drops an empty body and says there are no comments", () => {
    const items = deriveIssueDetailItems(
      deriveIssueDetail({ ...detail, body: "  ", comments: [], truncated: false }),
    );
    expect(items.map((item) => item.key)).toEqual(["comments", "no-comments"]);
  });

  it("sends a comment only with something in it", () => {
    expect(commentBodyToSend("  \n ")).toBeNull();
    expect(commentBodyToSend("Looks good\n\n")).toBe("Looks good");
  });
});

describe("new issue", () => {
  it("needs a title", () => {
    expect(buildCreateIssueInput("/work/app", EMPTY_NEW_ISSUE_DRAFT)).toEqual({
      ok: false,
      message: "Give the issue a title.",
    });
  });

  it("builds the request, labels and assignees only when chosen", () => {
    expect(
      buildCreateIssueInput("/work/app", {
        ...EMPTY_NEW_ISSUE_DRAFT,
        title: " Crash ",
        body: "x\n",
      }),
    ).toEqual({ ok: true, input: { cwd: "/work/app", title: "Crash", body: "x" } });
    expect(
      buildCreateIssueInput("/work/app", {
        title: "Crash",
        body: "",
        labels: ["bug", "bug", " "],
        assignees: ["alice"],
      }),
    ).toEqual({
      ok: true,
      input: { cwd: "/work/app", title: "Crash", body: "", labels: ["bug"], assignees: ["alice"] },
    });
  });

  it("toggles a chosen value", () => {
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("names assignees by display name and login", () => {
    expect(
      assigneeOptions([{ login: "alice", displayName: "Alice" }, { login: "bob" }]).map(
        (option) => option.label,
      ),
    ).toEqual(["Alice (@alice)", "@bob"]);
    expect(assigneeOptions(null)).toEqual([]);
  });

  it("polishes the body, and fills the title only while it is empty", () => {
    expect(buildPolishIssueInput("/w", EMPTY_NEW_ISSUE_DRAFT)).toBeNull();
    expect(
      buildPolishIssueInput("/w", { ...EMPTY_NEW_ISSUE_DRAFT, title: "T", body: "rough" }),
    ).toEqual({ cwd: "/w", mode: "polish", rough: "rough", currentTitle: "T" });
    const empty = { ...EMPTY_NEW_ISSUE_DRAFT, body: "rough" };
    expect(applyPolishedIssueContent(empty, { title: "Title", body: "Polished" })).toMatchObject({
      title: "Title",
      body: "Polished",
    });
    expect(
      applyPolishedIssueContent({ ...empty, title: "Mine" }, { title: "Title", body: "Polished" })
        .title,
    ).toBe("Mine");
  });
});
