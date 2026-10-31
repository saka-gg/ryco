import { describe, expect, it } from "vite-plus/test";

import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type ServerConfig,
} from "@ryco/contracts";
import { promptLinkSearchFromParams } from "@ryco/shared/promptLinks";

import {
  CLEARED_PROMPT_LINK_PARAMS,
  isMobilePromptLinkLookupSettled,
  planMobilePromptLink,
} from "./promptLinkModel";

const ENV = EnvironmentId.make("env-phone");
const OTHER = EnvironmentId.make("env-other");
const PROJECT = ProjectId.make("project-ryco");
const AT = "2026-10-30T09:00:00.000Z";

const project = {
  id: PROJECT,
  environmentId: ENV,
  name: "ryco",
  cwd: "/repo/ryco",
  repositoryIdentity: {
    canonicalKey: "github.com/saka-gg/ryco",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
    remotes: [],
  },
  defaultModelSelection: null,
  scripts: [],
} as unknown as Project;

const worktree = {
  id: WorktreeId.make("worktree-pr-42"),
  environmentId: ENV,
  projectId: PROJECT,
  branch: "fix/check",
  worktreePath: "/repo/ryco-42",
  origin: "pr",
  prNumber: 42,
  prTitle: null,
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
} as unknown as SidebarWorktreeSummary;

const thread = {
  id: ThreadId.make("thread-pr-42"),
  environmentId: ENV,
  projectId: PROJECT,
  createdAt: AT,
  archivedAt: null,
  worktreeId: worktree.id,
  worktreePath: "/repo/ryco-42",
  latestUserMessageAt: AT,
} as unknown as SidebarThreadSummary;

const serverConfigs = new Map([
  [
    ENV,
    {
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          status: "ready",
          models: [
            { slug: "gpt-5.4", name: "GPT-5.4", isDefault: true },
            { slug: "gpt-5.5", name: "GPT-5.5" },
          ],
        },
      ],
    } as unknown as ServerConfig,
  ],
]);

const environments = [{ environmentId: ENV, connectionState: "connected" as const }];

function plan(params: Record<string, string>, extra: { withPullRequest?: boolean } = {}) {
  const search = promptLinkSearchFromParams(params);
  if (search === null) throw new Error("no link");
  return planMobilePromptLink({
    search,
    projects: [project],
    threads: extra.withPullRequest ? [thread] : [],
    worktrees: extra.withPullRequest ? [worktree] : [],
    environments,
    serverConfigs,
    fallbackEnvironmentId: ENV,
  });
}

describe("planMobilePromptLink", () => {
  it("fills the task with the prompt, the linked project and the requested model", () => {
    expect(
      plan({ prompt: "Fix the build", repo: "saka-gg/ryco", provider: "codex", model: "gpt-5.5" }),
    ).toEqual({
      kind: "draft",
      prompt: "Fix the build",
      target: { environmentId: ENV, projectId: PROJECT },
      worktreeId: null,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      notice: "This prompt came from a link. Read it before you send it.",
    });
  });

  it("keeps the sheet's own choices for what the link cannot get", () => {
    expect(plan({ prompt: "Hi\u200B", repo: "someone/else", provider: "cursor" })).toEqual({
      kind: "draft",
      prompt: "Hi",
      target: null,
      worktreeId: null,
      modelSelection: null,
      notice:
        "This prompt had 1 hidden character, so it may be malicious. Ryco removed it. Read the prompt before you send it. The link asked for cursor, which is not set up here, so your default model is used. You don't have someone/else, so pick a project for it.",
    });
  });

  it("starts a pull request link's task in the checkout that already carries it", () => {
    expect(
      plan({ pr: "saka-gg/ryco/42", prompt: "Fix the check" }, { withPullRequest: true }),
    ).toMatchObject({
      kind: "draft",
      prompt: "Fix the check",
      target: { environmentId: ENV, projectId: PROJECT },
      worktreeId: "worktree-pr-42",
      notice: "This prompt came from a link. Read it before you send it.",
    });
    // Without one, the phone says it cannot check the pull request out.
    const elsewhere = plan({ pr: "saka-gg/ryco/7" });
    expect(elsewhere).toMatchObject({ kind: "draft", prompt: "", worktreeId: null });
    expect(elsewhere.kind === "draft" && elsewhere.notice).toBe(
      "The phone cannot check out saka-gg/ryco#7 yet, so this task starts in the project's checkout. Open the link in the web or desktop app to work on its branch. Nothing is sent until you press Send.",
    );
  });

  it("refuses links the shared parser refuses", () => {
    expect(plan({ prompt: "x".repeat(8_001) })).toEqual({
      kind: "invalid",
      message: "This prompt is longer than 8,000 characters, so Ryco did not open it.",
    });
    expect(plan({ prompt: "x", repo: "../etc" }).kind).toBe("invalid");
  });

  it("clears every link key from the route", () => {
    expect(Object.keys(CLEARED_PROMPT_LINK_PARAMS).toSorted()).toEqual([
      "model",
      "pr",
      "prompt",
      "provider",
      "repo",
    ]);
  });
});

describe("isMobilePromptLinkLookupSettled", () => {
  it("waits only for machines still reconnecting without their projects", () => {
    expect(
      isMobilePromptLinkLookupSettled([
        { environmentId: ENV, connectionState: "connected", shellCurrent: true },
        { environmentId: OTHER, connectionState: "offline" },
      ]),
    ).toBe(true);
    expect(
      isMobilePromptLinkLookupSettled([{ environmentId: OTHER, connectionState: "reconnecting" }]),
    ).toBe(false);
  });
});
