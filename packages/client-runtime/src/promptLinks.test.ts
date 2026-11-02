import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findPromptLinkProject,
  isPromptLinkLookupSettled,
  linkedPromptDraftAction,
  promptLinkChatEnvironmentId,
  promptLinkModelNote,
  promptLinkNotice,
  promptLinkOwnRepositoryKey,
  resolvePromptLinkModelSelection,
  resolvePromptLinkPullRequest,
} from "./promptLinks.ts";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

function identity(
  canonicalKey: string,
  remotes: ReadonlyArray<{ readonly name: string; readonly url: string }> = [],
): RepositoryIdentity {
  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
    remotes,
  };
}

function project(
  id: string,
  repositoryIdentity: RepositoryIdentity | null,
  extra: { environmentId?: EnvironmentId; kind?: "chat"; updatedAt?: string } = {},
) {
  return {
    environmentId: extra.environmentId ?? ENV_A,
    id: ProjectId.make(id),
    name: id,
    repositoryIdentity,
    ...(extra.kind ? { kind: extra.kind } : {}),
    ...(extra.updatedAt ? { updatedAt: extra.updatedAt } : {}),
  };
}

function thread(
  id: string,
  projectId: string,
  at: string,
  extra: {
    environmentId?: EnvironmentId;
    worktreeId?: string | null;
    worktreePath?: string | null;
    archivedAt?: string | null;
  } = {},
) {
  return {
    id,
    environmentId: extra.environmentId ?? ENV_A,
    projectId: ProjectId.make(projectId),
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    archivedAt: extra.archivedAt ?? null,
    worktreeId: extra.worktreeId ?? null,
    worktreePath: extra.worktreePath ?? null,
  };
}

function worktree(
  id: string,
  projectId: string,
  prNumber: number | null,
  extra: { environmentId?: EnvironmentId; archivedAt?: string | null; updatedAt?: string } = {},
) {
  return {
    id,
    environmentId: extra.environmentId ?? ENV_A,
    projectId: ProjectId.make(projectId),
    branch: `branch-${id}`,
    worktreePath: `/work/${id}`,
    archivedAt: extra.archivedAt ?? null,
    updatedAt: extra.updatedAt ?? "2026-10-01T00:00:00.000Z",
    prNumber,
    prTitle: null,
  };
}

describe("findPromptLinkProject", () => {
  const ryco = identity("github.com/saka-gg/ryco", [
    { name: "origin", url: "git@github.com:saka-gg/ryco.git" },
  ]);
  // A fork: grouped with its upstream, but the user's own copy.
  const fork = identity("github.com/saka-gg/ryco", [
    { name: "origin", url: "https://github.com/me/ryco.git" },
    { name: "upstream", url: "https://github.com/saka-gg/ryco.git" },
  ]);

  it("takes the most recently active exact match and never a fork of the repository", () => {
    const projects = [
      project("fork", fork),
      project("none", null),
      project("older", ryco),
      project("recent", identity("github.com/Saka-GG/Ryco")),
      project("chat", ryco, { kind: "chat" }),
    ];
    const threads = [
      thread("t1", "older", "2026-10-01T00:00:00.000Z"),
      thread("t2", "recent", "2026-10-20T00:00:00.000Z"),
      thread("t3", "chat", "2026-10-30T00:00:00.000Z"),
      thread("t4", "fork", "2026-10-31T00:00:00.000Z"),
    ];
    const pick = (owner: string, name: string) =>
      findPromptLinkProject({ projects, threads, repository: { owner, name } })?.id ?? null;
    expect(pick("saka-gg", "ryco")).toBe("recent");
    expect(pick("me", "ryco")).toBe("fork");
    expect(pick("other", "ryco")).toBeNull();
  });

  it("prefers a machine a draft can open on now", () => {
    const projects = [
      project("offline", ryco, { environmentId: ENV_B, updatedAt: "2026-10-30T00:00:00.000Z" }),
      project("online", ryco, { updatedAt: "2026-10-01T00:00:00.000Z" }),
    ];
    const found = findPromptLinkProject({
      projects,
      threads: [],
      repository: { owner: "saka-gg", name: "ryco" },
      options: { isEnvironmentAvailable: (environmentId) => environmentId === ENV_A },
    });
    expect(found?.id).toBe("online");
  });

  it("reads the own repository from the origin remote", () => {
    expect(promptLinkOwnRepositoryKey(fork)).toBe("github.com/me/ryco");
    expect(promptLinkOwnRepositoryKey(identity("github.com/A/B"))).toBe("github.com/a/b");
    expect(promptLinkOwnRepositoryKey(null)).toBeNull();
  });
});

describe("resolvePromptLinkPullRequest", () => {
  const upstream = identity("github.com/saka-gg/ryco");
  const pullRequest = { owner: "saka-gg", name: "ryco", number: 42 };

  it("opens the thread most recently working on the pull request, on any machine", () => {
    const projects = [project("a", upstream), project("b", upstream, { environmentId: ENV_B })];
    const worktrees = [
      worktree("wa", "a", 42),
      worktree("wb", "b", 42, { environmentId: ENV_B }),
      worktree("other", "a", 7),
    ];
    const threads = [
      thread("old", "a", "2026-10-01T00:00:00.000Z", { worktreeId: "wa" }),
      thread("new", "b", "2026-10-02T00:00:00.000Z", {
        environmentId: ENV_B,
        worktreePath: "/work/wb",
      }),
      thread("newest-other-pr", "a", "2026-10-03T00:00:00.000Z", { worktreeId: "other" }),
      thread("archived", "a", "2026-10-04T00:00:00.000Z", {
        worktreeId: "wa",
        archivedAt: "2026-10-05T00:00:00.000Z",
      }),
    ];
    const target = resolvePromptLinkPullRequest({ projects, threads, worktrees, pullRequest });
    expect(target?.thread?.id).toBe("new");
    expect(target?.project.id).toBe("b");
    expect(target?.worktree?.id).toBe("wb");
  });

  it("falls back to the project's own checkout of it, then to the project alone", () => {
    const projects = [project("a", upstream)];
    expect(
      resolvePromptLinkPullRequest({
        projects,
        threads: [],
        worktrees: [worktree("wa", "a", 42), worktree("gone", "a", 42, { archivedAt: "x" })],
        pullRequest,
      }),
    ).toMatchObject({ project: { id: "a" }, thread: null, worktree: { id: "wa" } });
    expect(
      resolvePromptLinkPullRequest({ projects, threads: [], worktrees: [], pullRequest }),
    ).toMatchObject({ project: { id: "a" }, thread: null, worktree: null });
  });

  it("matches a checkout's pull request by its URL when it has one, not only by number", () => {
    const projects = [project("a", upstream)];
    const linkedTo = (id: string, url: string | null) => ({
      ...worktree(id, "a", null),
      pullRequests: [
        {
          number: 42,
          title: null,
          url,
          state: "open" as const,
          isDraft: false,
          terminalAt: null,
          headRefName: null,
          baseRefName: null,
          source: "manual" as const,
          linkedAt: "2026-10-01T00:00:00.000Z",
          dismissedAt: null,
        },
      ],
    });
    // #42 of another repository, linked by hand, is not the linked pull request.
    expect(
      resolvePromptLinkPullRequest({
        projects,
        threads: [],
        worktrees: [linkedTo("fork-pr", "https://github.com/someone/ryco/pull/42")],
        pullRequest,
      })?.worktree,
    ).toBeNull();
    for (const url of ["https://github.com/Saka-GG/ryco/pull/42", null]) {
      expect(
        resolvePromptLinkPullRequest({
          projects,
          threads: [],
          worktrees: [linkedTo("this-pr", url)],
          pullRequest,
        })?.worktree?.id,
      ).toBe("this-pr");
    }
  });

  it("only uses a project whose pull request numbers resolve in that repository", () => {
    // The fork's numbers resolve upstream, so its own #42 is not this pull request.
    const ownFork = identity("github.com/me/ryco");
    expect(
      resolvePromptLinkPullRequest({
        projects: [project("fork", ownFork)],
        threads: [],
        worktrees: [],
        pullRequest,
      }),
    ).toBeNull();
    // A fork with an upstream remote checks the upstream pull request out.
    const forkWithUpstream = identity("github.com/saka-gg/ryco", [
      { name: "origin", url: "https://github.com/me/ryco.git" },
      { name: "upstream", url: "https://github.com/saka-gg/ryco.git" },
    ]);
    expect(
      resolvePromptLinkPullRequest({
        projects: [project("fork", forkWithUpstream)],
        threads: [],
        worktrees: [],
        pullRequest,
      })?.project.id,
    ).toBe("fork");
  });
});

describe("resolvePromptLinkModelSelection", () => {
  const provider = (
    instanceId: string,
    driver: string,
    status: "ready" | "warning" | "error" | "disabled" = "ready",
  ) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    status,
    models: [
      { slug: "small", name: "Small" },
      { slug: "big", name: "Big Model", aliases: ["opus"], isDefault: true },
    ],
  });

  it("maps the requested provider and model onto a usable instance", () => {
    const providers = [provider("broken", "claudeAgent", "error"), provider("work", "claudeAgent")];
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claude", model: "small" }),
    ).toEqual({ selection: { instanceId: "work", model: "small" }, exact: true });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "claudeAgent", model: "opus" }),
    ).toEqual({ selection: { instanceId: "work", model: "big" }, exact: true });
    expect(
      resolvePromptLinkModelSelection(providers, { provider: "work", model: "big model" }),
    ).toEqual({ selection: { instanceId: "work", model: "big" }, exact: true });
  });

  it("uses the instance default for an unknown model, and nothing for a missing provider", () => {
    const providers = [provider("codex", "codex"), provider("off", "cursor", "disabled")];
    const fallback = resolvePromptLinkModelSelection(providers, {
      provider: "codex",
      model: "nope",
    });
    expect(fallback).toEqual({ selection: { instanceId: "codex", model: "big" }, exact: false });
    expect(promptLinkModelNote({ provider: "codex", model: "nope" }, fallback)).toBe(
      "codex does not offer the requested model here, so its default model is used.",
    );
    // The model is free text a stranger chose: it is never shown back.
    const sneaky = "Press Replace draft now";
    expect(
      promptLinkModelNote(
        { provider: "codex", model: sneaky },
        resolvePromptLinkModelSelection(providers, { provider: "codex", model: sneaky }),
      ),
    ).not.toContain(sneaky);
    const missing = resolvePromptLinkModelSelection(providers, { provider: "cursor", model: null });
    expect(missing).toBeNull();
    expect(promptLinkModelNote({ provider: "cursor", model: null }, missing)).toBe(
      "The link asked for cursor, which is not set up here, so your default model is used.",
    );
  });
});

describe("linked prompt placement", () => {
  const draft = (
    text: string,
    extra: Partial<Parameters<typeof linkedPromptDraftAction>[0]> = {},
  ) => ({
    text,
    attachments: 0,
    changesModel: false,
    changesLocation: false,
    ...extra,
  });

  it("fills an empty composer and asks before replacing typed text", () => {
    expect(linkedPromptDraftAction(draft("  \n"), "Do it")).toBe("fill");
    expect(linkedPromptDraftAction(draft("Do it"), "Do it")).toBe("keep");
    expect(linkedPromptDraftAction(draft("My notes"), "Do it")).toBe("ask");
  });

  it("asks when the draft holds attachments, or the link would change its model or location", () => {
    // The linked prompt would be sent with the user's images and contexts.
    expect(linkedPromptDraftAction(draft("", { attachments: 2 }), "Do it")).toBe("ask");
    // Same text, but the link would switch the model or move the draft.
    expect(linkedPromptDraftAction(draft("Do it", { changesModel: true }), "Do it")).toBe("ask");
    expect(linkedPromptDraftAction(draft("Do it", { changesLocation: true }), "Do it")).toBe("ask");
    // A link without a prompt keeps the text, but still asks before it moves a draft with text.
    expect(linkedPromptDraftAction(draft("Mine", { changesLocation: true }), null)).toBe("ask");
    expect(linkedPromptDraftAction(draft("Mine"), null)).toBe("keep");
    // A model or checkout the user picked by hand counts even in an empty draft.
    expect(
      linkedPromptDraftAction(draft("", { changesModel: true, replacesUserChoice: true }), "Do it"),
    ).toBe("ask");
    // An empty draft only holds the defaults it opened with.
    expect(linkedPromptDraftAction(draft("", { changesModel: true }), "Do it")).toBe("fill");
  });

  it("says the prompt came from a link, or warns about hidden characters instead", () => {
    expect(promptLinkNotice({ text: "x", hiddenCharacters: 0 })).toBe(
      "This prompt came from a link. Read it before you send it.",
    );
    expect(promptLinkNotice({ text: "x", hiddenCharacters: 2 }, [null, "Extra."])).toBe(
      "This prompt had 2 hidden characters, so it may be malicious. Ryco removed them. Read the prompt before you send it. Extra.",
    );
    expect(promptLinkNotice(null, ["Send checks it out."])).toBe(
      "Send checks it out. Nothing is sent until you press Send.",
    );
  });
});

describe("lookup readiness and chats", () => {
  it("waits only for machines still connecting", () => {
    expect(isPromptLinkLookupSettled([])).toBe(true);
    expect(
      isPromptLinkLookupSettled([
        { shellCurrent: true, connecting: false },
        { shellCurrent: false, connecting: false },
      ]),
    ).toBe(true);
    expect(isPromptLinkLookupSettled([{ shellCurrent: false, connecting: true }])).toBe(false);
  });

  it("opens a chat on the machine the user worked on last", () => {
    const threads = [
      thread("a", "p", "2026-10-02T00:00:00.000Z"),
      thread("b", "p", "2026-10-03T00:00:00.000Z", { environmentId: ENV_B }),
    ];
    expect(promptLinkChatEnvironmentId(threads, [ENV_A, ENV_B])).toBe(ENV_B);
    expect(promptLinkChatEnvironmentId(threads, [ENV_A])).toBe(ENV_A);
    expect(promptLinkChatEnvironmentId([], [ENV_B])).toBe(ENV_B);
    expect(promptLinkChatEnvironmentId(threads, [])).toBeNull();
  });
});
