import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPlainLinkClick,
  resolveMarkdownChangeRequestCheckout,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/ryco/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/ryco",
      ),
    ).toMatchObject({
      displayPath: "ryco/apps/web/src/session-logic.ts:501",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/ryco/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/ryco",
      ),
    ).toMatchObject({
      displayPath: "ryco/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });

  it("resolves relative links from a base directory and displays them relative to cwd", () => {
    expect(resolveMarkdownFileLinkMeta("../notes.md:4", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/../notes.md",
      line: 4,
    });
    expect(resolveMarkdownFileLinkMeta("./guide.md", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/./guide.md",
      basename: "guide.md",
    });
    expect(resolveMarkdownFileLinkMeta("guide.md", "/repo")).toMatchObject({
      filePath: "/repo/guide.md",
    });
  });
});

it("resolves only bounded, well-formed thread references in the current environment", async () => {
  const { resolveMarkdownThreadHref } = await import("./markdown-links");
  expect(resolveMarkdownThreadHref("/ryco/thread/child", "env")).toBe("/env/child");
  expect(resolveMarkdownThreadHref("/ryco/thread/child", undefined)).toBeNull();
  expect(resolveMarkdownThreadHref("/ryco/thread/%2fother", "env")).toBeNull();
  expect(resolveMarkdownThreadHref("/ryco/thread/%", "env")).toBeNull();
  expect(resolveMarkdownThreadHref("/ryco/thread/" + "a".repeat(257), "env")).toBeNull();
});

describe("resolveMarkdownChangeRequestCheckout", () => {
  const local = EnvironmentId.make("env-local");
  const studio = EnvironmentId.make("env-studio");
  const laptop = EnvironmentId.make("env-laptop");
  const project = (
    id: string,
    environmentId: typeof local,
    remoteUrl: string | null,
    kind?: "chat",
  ) => ({
    id: ProjectId.make(id),
    environmentId,
    ...(kind ? { kind } : {}),
    repositoryIdentity: remoteUrl ? { locator: { remoteUrl } } : null,
  });
  const resolve = (
    href: string,
    projects: ReadonlyArray<ReturnType<typeof project>>,
    options: {
      readonly threadEnvironmentId?: typeof local;
      readonly primaryEnvironmentId?: typeof local | null;
      readonly available?: (environmentId: typeof local) => boolean;
    } = {},
  ) =>
    resolveMarkdownChangeRequestCheckout({
      href,
      projects,
      threadEnvironmentId: options.threadEnvironmentId,
      primaryEnvironmentId: options.primaryEnvironmentId ?? null,
      isEnvironmentAvailable: options.available ?? (() => true),
    });
  const link = "https://github.com/acme/app/pull/12";

  it("prefers the thread's environment, then the primary one, then project order", () => {
    const projects = [
      project("laptop-app", laptop, "https://github.com/acme/app.git"),
      project("studio-app", studio, "git@github.com:Acme/App.git"),
      project("local-app", local, "ssh://git@github.com/acme/app.git"),
    ];
    expect(
      resolve(link, projects, { threadEnvironmentId: studio, primaryEnvironmentId: local }),
    ).toEqual({ environmentId: studio, projectId: ProjectId.make("studio-app"), number: 12 });
    expect(resolve(link, projects, { primaryEnvironmentId: local })).toEqual({
      environmentId: local,
      projectId: ProjectId.make("local-app"),
      number: 12,
    });
    expect(resolve(link, projects)).toMatchObject({ projectId: ProjectId.make("laptop-app") });
  });

  it("skips chat projects, unknown repositories and environments that can't be read now", () => {
    expect(resolve(link, [project("chat", local, "git@github.com:acme/app.git", "chat")])).toBe(
      null,
    );
    expect(resolve(link, [project("other", local, "git@github.com:acme/other.git")])).toBeNull();
    expect(resolve(link, [project("bare", local, null)])).toBeNull();
    const projects = [
      project("offline", laptop, "git@github.com:acme/app.git"),
      project("online", studio, "git@github.com:acme/app.git"),
    ];
    expect(
      resolve(link, projects, {
        threadEnvironmentId: laptop,
        available: (environmentId) => environmentId !== laptop,
      }),
    ).toMatchObject({ environmentId: studio });
    expect(resolve(link, projects.slice(0, 1), { available: () => false })).toBeNull();
  });

  it("matches only the remote a number resolves in, so a fork opens upstream's links alone", () => {
    // A fork whose identity follows `upstream`.
    const fork = project("fork", local, "https://github.com/acme/app.git");
    expect(resolve("https://github.com/me/app/pull/3", [fork])).toBeNull();
    expect(resolve("https://github.com/acme/app/pull/3", [fork])).toMatchObject({ number: 3 });
  });

  it("matches Azure DevOps SSH remotes and self-hosted ports", () => {
    expect(
      resolve("https://dev.azure.com/org/proj/_git/repo/pullrequest/5", [
        project("azure", local, "git@ssh.dev.azure.com:v3/org/proj/repo"),
      ]),
    ).toMatchObject({ number: 5, projectId: ProjectId.make("azure") });
    expect(
      resolve("https://ghe.example.com:8443/team/app/pull/2", [
        project("ghe", local, "git@ghe.example.com:team/app.git"),
      ]),
    ).toMatchObject({ number: 2 });
  });

  it("opens the tab a link names and leaves comment links to the host", () => {
    const projects = [project("app", local, "git@github.com:acme/app.git")];
    expect(resolve(`${link}/files`, projects)).toMatchObject({ number: 12, tab: "files" });
    expect(resolve(`${link}/checks`, projects)).toMatchObject({ tab: "checks" });
    expect(resolve(`${link}#issuecomment-1`, projects)).toBeNull();
    expect(resolve(`${link}/files#discussion_r2`, projects)).toBeNull();
    expect(resolve("https://github.com/acme/app/issues/12", projects)).toBeNull();
  });
});

describe("isPlainLinkClick", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("is only a primary click without modifiers", () => {
    expect(isPlainLinkClick(click)).toBe(true);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(isPlainLinkClick({ ...click, [modifier]: true }), modifier).toBe(false);
    }
    expect(isPlainLinkClick({ ...click, button: 1 })).toBe(false);
  });
});
