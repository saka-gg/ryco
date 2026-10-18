import { ThreadId } from "@ryco/contracts";
import { LocalTaskLink } from "@ryco/contracts/local-tasks";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  describeTaskLink,
  isTaskBranchName,
  parseTaskLinkInput,
  taskLinkLabel,
  taskLinkLabelIn,
} from "./taskLinks.logic";

const encodes = Schema.is(LocalTaskLink);

describe("parseTaskLinkInput", () => {
  it("reads a pull request number or URL under Pull request", () => {
    expect(parseTaskLinkInput("pr", "#746")).toEqual({ kind: "pr", number: 746 });
    expect(parseTaskLinkInput("pr", " 12 ")).toEqual({ kind: "pr", number: 12 });
    expect(parseTaskLinkInput("pr", "gh pr checkout 31")).toEqual({ kind: "pr", number: 31 });
    const url = "https://github.com/acme/app/pull/752/files";
    expect(parseTaskLinkInput("pr", url)).toEqual({ kind: "pr", number: 752, url });
    expect(parseTaskLinkInput("pr", "ABC-12")).toBeNull();
    expect(parseTaskLinkInput("pr", "#0")).toBeNull();
  });

  it("reads an issue number, a Jira key or their URLs under Issue", () => {
    expect(parseTaskLinkInput("issue", "#231")).toEqual({ kind: "issue", number: 231 });
    expect(parseTaskLinkInput("issue", "abc-123")).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "ABC-123",
    });
    const issueUrl = "https://github.com/acme/app/issues/240#issuecomment-1";
    expect(parseTaskLinkInput("issue", issueUrl)).toEqual({
      kind: "issue",
      number: 240,
      url: issueUrl,
    });
    const browse = "https://acme.atlassian.net/browse/OPS-42";
    expect(parseTaskLinkInput("issue", browse)).toEqual({
      kind: "workItem",
      provider: "jira",
      key: "OPS-42",
      url: browse,
    });
    const board =
      "https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7";
    expect(parseTaskLinkInput("issue", board)).toMatchObject({ kind: "workItem", key: "OPS-7" });
    expect(parseTaskLinkInput("issue", "fix the thing")).toBeNull();
  });

  it("lets a pasted URL say what it is, whatever kind was picked", () => {
    expect(parseTaskLinkInput("pr", "https://github.com/acme/app/issues/9")).toMatchObject({
      kind: "issue",
      number: 9,
    });
    expect(parseTaskLinkInput("branch", "https://github.com/acme/app/pull/3")).toMatchObject({
      kind: "pr",
      number: 3,
    });
    expect(parseTaskLinkInput("issue", "https://linear.app/acme/issue/ENG-1")).toEqual({
      kind: "url",
      url: "https://linear.app/acme/issue/ENG-1",
    });
    expect(parseTaskLinkInput("pr", `https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });

  it("reads a branch name under Branch", () => {
    expect(parseTaskLinkInput("branch", " feature/login-loop ")).toEqual({
      kind: "branch",
      name: "feature/login-loop",
    });
    expect(parseTaskLinkInput("branch", "has space")).toBeNull();
    expect(parseTaskLinkInput("branch", "")).toBeNull();
  });

  it("only produces links the contract accepts", () => {
    const inputs: ReadonlyArray<readonly ["pr" | "issue" | "branch", string]> = [
      ["pr", "#746"],
      ["pr", "https://github.com/acme/app/pull/752"],
      ["issue", "#1"],
      ["issue", "abc_def-9"],
      ["issue", "https://acme.atlassian.net/browse/OPS-42"],
      ["issue", "http://intranet.example/wiki"],
      ["branch", "release/2026.10"],
    ];
    for (const [kind, raw] of inputs) {
      const link = parseTaskLinkInput(kind, raw);
      expect(link, raw).not.toBeNull();
      expect(encodes(link), raw).toBe(true);
    }
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
