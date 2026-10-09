import { describe, expect, it } from "vite-plus/test";

import { excludeChatProjects, isChatProject, projectKindOf } from "./projectKind.ts";

describe("project kind", () => {
  it("recognises only explicit chats", () => {
    expect(isChatProject({ kind: "chat" })).toBe(true);
    expect(isChatProject({ kind: "project" })).toBe(false);
    expect(isChatProject({})).toBe(false);
    expect(isChatProject({ kind: undefined })).toBe(false);
    expect(isChatProject(null)).toBe(false);
    expect(isChatProject(undefined)).toBe(false);
  });

  it("reads absent and unknown kinds as regular projects", () => {
    expect(projectKindOf({ kind: "chat" })).toBe("chat");
    expect(projectKindOf({ kind: "project" })).toBe("project");
    expect(projectKindOf({})).toBe("project");
    expect(projectKindOf(null)).toBe("project");
    // A cache written by a newer client must not surface an unrecognised kind.
    expect(projectKindOf({ kind: "workspace" } as never)).toBe("project");
  });
});

describe("excludeChatProjects", () => {
  it("drops chat projects and keeps regular and legacy (kind-less) projects", () => {
    const projects = [
      { id: "a", kind: "project" as const },
      { id: "chat", kind: "chat" as const },
      { id: "legacy" },
    ];
    expect(excludeChatProjects(projects).map((project) => project.id)).toEqual(["a", "legacy"]);
  });

  it("returns the same array when there is nothing to drop", () => {
    const projects = [{ id: "a", kind: "project" as const }, { id: "legacy" }];
    expect(excludeChatProjects(projects)).toBe(projects);
  });
});
