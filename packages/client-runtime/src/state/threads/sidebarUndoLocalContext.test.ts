import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createSidebarUndoLocalContextReader } from "./sidebarUndoLocalContext.ts";
import type { Project, SidebarThreadOrStub } from "./types.ts";

const target = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("t") };
const thread = {
  id: "t",
  projectId: "p",
  title: "Fix",
  archivedAt: null,
} as unknown as SidebarThreadOrStub;
const project = { id: "p" } as unknown as Project;

describe("sidebar undo local context", () => {
  it("reads the thread's ordering revision and its project through the bound store", () => {
    const subscribe = vi.fn(() => () => {});
    const selectProject = vi.fn(() => project);
    const read = createSidebarUndoLocalContextReader({
      getState: () => "state",
      subscribe,
      selectThread: (state, ref) => (state === "state" && ref === target ? thread : null),
      selectProject,
    });
    const context = read(target);
    expect(context).toMatchObject({ parentRevision: project, threadTitle: "Fix", subscribe });
    expect(typeof context?.threadRevision).toBe("string");
    expect(selectProject).toHaveBeenCalledWith("state", {
      environmentId: target.environmentId,
      projectId: "p",
    });
  });

  it("has nothing without the thread or its project", () => {
    const base = { getState: () => null, subscribe: () => () => {} };
    expect(
      createSidebarUndoLocalContextReader({
        ...base,
        selectThread: () => null,
        selectProject: () => project,
      })(target),
    ).toBeNull();
    expect(
      createSidebarUndoLocalContextReader({
        ...base,
        selectThread: () => thread,
        selectProject: () => null,
      })(target),
    ).toBeNull();
  });
});
