import {
  ThreadId,
  type ChangeRequest,
  type SourceControlIssueSummary,
  type WorkItemSummary,
} from "@ryco/contracts";
import { LocalTaskLink } from "@ryco/contracts/local-tasks";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  describeTaskLink,
  isTaskBranchName,
  parseTaskLinkPaste,
  taskLinkFromSource,
  taskLinkLabel,
  taskLinkLabelIn,
} from "./taskLinks.logic";

const encodes = Schema.is(LocalTaskLink);

describe("parseTaskLinkPaste", () => {
  it("lets a pasted URL say what it is", () => {
    const pr = "https://github.com/acme/app/pull/752/files";
    expect(parseTaskLinkPaste(pr)).toEqual({ kind: "pr", number: 752, url: pr });
    const issueUrl = "https://github.com/acme/app/issues/240#issuecomment-1";
    expect(parseTaskLinkPaste(issueUrl)).toEqual({ kind: "issue", number: 240, url: issueUrl });
    const browse = "https://acme.atlassian.net/browse/OPS-42";
    expect(parseTaskLinkPaste(browse)).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "OPS-42",
      url: browse,
    });
    const board =
      "https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7";
    expect(parseTaskLinkPaste(board)).toMatchObject({ kind: "workItem", key: "OPS-7" });
    expect(parseTaskLinkPaste(" https://linear.app/acme/issue/ENG-1 ")).toEqual({
      kind: "url",
      url: "https://linear.app/acme/issue/ENG-1",
    });
    expect(parseTaskLinkPaste(`https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });

  it("reads a Jira key, and nothing else that isn't a URL", () => {
    expect(parseTaskLinkPaste("abc-123")).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "ABC-123",
    });
    expect(parseTaskLinkPaste("#42")).toBeNull();
    expect(parseTaskLinkPaste("fix the thing")).toBeNull();
    expect(parseTaskLinkPaste("")).toBeNull();
  });

  it("only produces links the contract accepts", () => {
    for (const raw of [
      "https://github.com/acme/app/pull/752",
      "abc_def-9",
      "https://acme.atlassian.net/browse/OPS-42",
      "http://intranet.example/wiki",
    ]) {
      const link = parseTaskLinkPaste(raw);
      expect(link, raw).not.toBeNull();
      expect(encodes(link), raw).toBe(true);
    }
  });
});

describe("taskLinkFromSource", () => {
  it("keeps a picked item's URL and title, as the contract holds them", () => {
    const pr = taskLinkFromSource({
      kind: "pr",
      changeRequest: {
        number: 746,
        title: "  Fix the\nlogin   loop ",
        url: "https://github.com/acme/app/pull/746",
      } as ChangeRequest,
    });
    expect(pr).toEqual({
      kind: "pr",
      number: 746,
      url: "https://github.com/acme/app/pull/746",
      title: "Fix the login loop",
    });
    const issue = taskLinkFromSource({
      kind: "issue",
      issue: { number: 12, title: "x".repeat(400), url: "not a url" } as SourceControlIssueSummary,
    });
    expect(issue).toEqual({ kind: "issue", number: 12, title: "x".repeat(300) });
    const workItem = taskLinkFromSource({
      kind: "workItem",
      workItem: {
        provider: "jira",
        key: "ops-7",
        title: "Rotate keys",
        url: "https://acme.atlassian.net/browse/OPS-7",
      } as WorkItemSummary,
    });
    expect(workItem).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "OPS-7",
      url: "https://acme.atlassian.net/browse/OPS-7",
      title: "Rotate keys",
    });
    for (const link of [pr, issue, workItem]) expect(encodes(link)).toBe(true);
  });

  it("links a branch by name, and refuses one git would", () => {
    expect(taskLinkFromSource({ kind: "branch", branchName: "origin/feature/x" })).toEqual({
      kind: "branch",
      name: "origin/feature/x",
    });
    expect(taskLinkFromSource({ kind: "branch", branchName: "a..b" })).toBeNull();
  });
});

describe("isTaskBranchName", () => {
  it("rejects what git rejects", () => {
    for (const bad of [
      "-leading",
      "trailing/",
      "trailing.",
      "a..b",
      "a//b",
      "a/.hidden",
      ".hidden",
      "x.lock",
      "a@{1}",
      "@",
      "a~1",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "tab\there",
    ]) {
      expect(isTaskBranchName(bad), bad).toBe(false);
    }
    expect(isTaskBranchName("task/fix-login-2")).toBe(true);
    expect(isTaskBranchName("a".repeat(256))).toBe(false);
  });
});

describe("link labels and keys", () => {
  const thread = { kind: "thread", threadId: ThreadId.make("thread-1") } as const;

  it("labels each kind the way chips and the meta line show it", () => {
    expect(taskLinkLabel({ kind: "pr", number: 746 })).toBe("#746");
    expect(taskLinkLabel({ kind: "issue", number: 231 })).toBe("#231");
    expect(taskLinkLabel({ kind: "workItem", provider: "jira", key: "OPS-4" })).toBe("OPS-4");
    expect(taskLinkLabel({ kind: "branch", name: "feature/x" })).toBe("feature/x");
    expect(taskLinkLabel(thread, "Hub reconnect investigation")).toBe(
      "Hub reconnect investigation",
    );
    expect(taskLinkLabel(thread)).toBe("Linked chat");
    expect(taskLinkLabel({ kind: "url", url: "https://www.example.com/docs/" })).toBe(
      "example.com/docs",
    );
    expect(taskLinkLabel({ kind: "url", url: "https://example.com", label: "Spec" })).toBe("Spec");
  });

  it("describes what the popover will add", () => {
    expect(describeTaskLink({ kind: "pr", number: 7 })).toBe("Pull request #7");
    expect(describeTaskLink({ kind: "workItem", provider: "jira", key: "OPS-4" })).toBe(
      "Jira OPS-4",
    );
  });

  it("names a linked chat by the title of the task's chat, as long as it knows one", () => {
    const chats = [{ threadId: thread.threadId, title: "Hub reconnect investigation" }];
    expect(taskLinkLabelIn(thread, chats)).toBe("Hub reconnect investigation");
    expect(taskLinkLabelIn(thread, [{ threadId: thread.threadId, title: null }])).toBe(
      "Linked chat",
    );
    expect(taskLinkLabelIn({ kind: "branch", name: "feature/x" }, chats)).toBe("feature/x");
  });
});
