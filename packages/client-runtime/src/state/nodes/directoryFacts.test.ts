import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AppState } from "../threads/store.ts";
import type { Project } from "../threads/types.ts";
import { readNodeDirectoryFacts, subscribeNodeDirectoryProjects } from "./directoryFacts.ts";

const MINI = "env-mini" as EnvironmentId;

function project(id: string, overrides: Partial<Project>): Project {
  return { id: id as ProjectId, environmentId: MINI, cwd: `/code/${id}`, ...overrides } as Project;
}

function stateWith(input: {
  readonly bootstrapComplete: boolean;
  readonly projects: ReadonlyArray<Project>;
}): AppState {
  return {
    environmentStateById: {
      [MINI]: {
        bootstrapComplete: input.bootstrapComplete,
        projectIds: input.projects.map((entry) => entry.id),
        projectById: Object.fromEntries(input.projects.map((entry) => [entry.id, entry])),
      },
    },
  } as unknown as AppState;
}

const repo = (key: string) => ({ repositoryIdentity: { canonicalKey: key } }) as Partial<Project>;

describe("readNodeDirectoryFacts", () => {
  it("publishes repository projects once the node's shell arrived, never chats", () => {
    const state = stateWith({
      bootstrapComplete: true,
      projects: [
        project("notes", repo("github.com/acme/notes")),
        project("scratch", {}),
        project("chat", { ...repo("github.com/acme/chat"), kind: "chat" }),
      ],
    });
    expect(readNodeDirectoryFacts(state, MINI, "/code")).toEqual({
      defaultProjectDirectory: "/code",
      projects: [{ repositoryCanonicalKey: "github.com/acme/notes", path: "/code/notes" }],
    });
  });

  it("does not claim a node has no projects before its shell arrived", () => {
    const state = stateWith({
      bootstrapComplete: false,
      projects: [project("notes", repo("github.com/acme/notes"))],
    });
    expect(readNodeDirectoryFacts(state, MINI, null)).toEqual({
      defaultProjectDirectory: null,
      projects: null,
    });
  });
});

describe("subscribeNodeDirectoryProjects", () => {
  it("fires only when the projects change", () => {
    let state = stateWith({ bootstrapComplete: true, projects: [project("notes", {})] });
    const listeners = new Set<(next: AppState) => void>();
    const store = {
      getState: () => state,
      subscribe: (listener: (next: AppState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const listener = vi.fn();
    const stop = subscribeNodeDirectoryProjects(store, listener);
    const emit = () => {
      for (const each of Array.from(listeners)) each(state);
    };
    emit();
    expect(listener).not.toHaveBeenCalled();
    state = stateWith({
      bootstrapComplete: true,
      projects: [project("notes", {}), project("docs", {})],
    });
    emit();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});
