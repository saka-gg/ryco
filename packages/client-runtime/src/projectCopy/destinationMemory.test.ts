import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  copyParentFolderOf,
  createCopyDestinationMemory,
  type StoredCopyDestination,
} from "./destinationMemory.ts";

const MINI = "env-mini" as EnvironmentId;
const LAPTOP = "env-laptop" as EnvironmentId;
const SERVER = "env-server" as EnvironmentId;
const notes = { environmentId: MINI, projectId: "project-notes" as ProjectId };
const docs = { environmentId: MINI, projectId: "project-docs" as ProjectId };

function memoryStorage() {
  let entries: ReadonlyArray<StoredCopyDestination> | null = null;
  return {
    storage: {
      read: () => entries,
      write: (next: ReadonlyArray<StoredCopyDestination>) => {
        entries = next;
      },
    },
    entries: () => entries,
  };
}

describe("createCopyDestinationMemory", () => {
  it("remembers the newest destination per checkout", () => {
    const store = memoryStorage();
    const memory = createCopyDestinationMemory(store.storage, () => 1_000);
    expect(memory.read(notes)).toBeNull();
    memory.remember(notes, { targetEnvironmentId: LAPTOP, parentPath: "/code" });
    memory.remember(docs, { targetEnvironmentId: SERVER, parentPath: null });
    memory.remember(notes, { targetEnvironmentId: SERVER, parentPath: "/srv" });
    expect(memory.read(notes)).toEqual({ targetEnvironmentId: SERVER, parentPath: "/srv" });
    expect(memory.read(docs)).toEqual({ targetEnvironmentId: SERVER, parentPath: null });
    expect(store.entries()?.map((entry) => entry.sourceProjectId)).toEqual([
      "project-notes",
      "project-docs",
    ]);
  });

  it("forgets quietly when the storage fails", () => {
    const memory = createCopyDestinationMemory({
      read: () => {
        throw new Error("corrupt");
      },
      write: () => {
        throw new Error("full");
      },
    });
    expect(() =>
      memory.remember(notes, { targetEnvironmentId: LAPTOP, parentPath: null }),
    ).not.toThrow();
    expect(memory.read(notes)).toBeNull();
  });
});

describe("copyParentFolderOf", () => {
  const remembered = { targetEnvironmentId: LAPTOP, parentPath: "/code" };

  it("uses the remembered folder on its own node until the user picks one", () => {
    expect(copyParentFolderOf({ targetId: LAPTOP, picked: null, remembered })).toEqual({
      path: "/code",
      remembered: true,
    });
    expect(copyParentFolderOf({ targetId: SERVER, picked: null, remembered })).toEqual({
      path: null,
      remembered: false,
    });
    expect(
      copyParentFolderOf({
        targetId: LAPTOP,
        picked: { targetId: LAPTOP, path: "/elsewhere" },
        remembered,
      }),
    ).toEqual({ path: "/elsewhere", remembered: false });
    // A folder picked for another node does not follow the user to this one.
    expect(
      copyParentFolderOf({
        targetId: LAPTOP,
        picked: { targetId: SERVER, path: "/srv" },
        remembered,
      }),
    ).toEqual({ path: "/code", remembered: true });
  });
});
