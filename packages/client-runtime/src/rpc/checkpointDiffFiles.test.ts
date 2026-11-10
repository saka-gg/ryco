import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atomRegistry.ts";
import {
  createCheckpointDiffFilePatches,
  readCheckpointDiffFileIndex,
} from "./checkpointDiffFiles.ts";
import type { CheckpointDiffInput } from "./checkpointDiffStore.ts";

const threadId = "thread-1" as ThreadId;
const input: CheckpointDiffInput = {
  environmentId: "env-a" as EnvironmentId,
  threadId,
  fromTurnCount: 0,
  toTurnCount: 2,
  ignoreWhitespace: false,
  fileIndex: true,
};
const segment = (name: string) =>
  [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
const commits = { fromCommitOid: "c0", toCommitOid: "c2" };
const served = {
  commits,
  files: [0, 1, 2].map((index) => ({
    index,
    path: `f${index}.ts`,
    status: "modified" as const,
    additions: 1,
    deletions: 1,
    patchChars: 60,
  })),
  localPatches: null,
};

describe("readCheckpointDiffFileIndex", () => {
  it("takes a node's file list, and splits an older node's whole diff", () => {
    expect(
      readCheckpointDiffFileIndex({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 2,
        diff: "",
        fileView: { ...commits, files: served.files },
      }),
    ).toEqual(served);
    const whole = readCheckpointDiffFileIndex({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: `${segment("a.ts")}\n${segment("b.ts")}\n`,
    });
    expect(whole.commits).toBeNull();
    expect(whole.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([
      ["a.ts", 1, 1],
      ["b.ts", 1, 1],
    ]);
    expect(whole.localPatches?.[1]).toBe(segment("b.ts"));
  });
});

describe("createCheckpointDiffFilePatches", () => {
  function setup() {
    const getFullThreadDiff = vi.fn(
      async (request: { fileView?: { kind: string; indices?: ReadonlyArray<number> } }) => ({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 2,
        diff: "",
        fileView: {
          ...commits,
          patches: (request.fileView?.indices ?? []).map((index) => ({
            index,
            patch: segment(`f${index}.ts`),
          })),
        },
      }),
    );
    const store = createCheckpointDiffFilePatches({
      resolveOrchestrationApi: () => ({ getFullThreadDiff, getTurnDiff: vi.fn() }) as never,
      maxRetainedChars: 100,
    });
    const read = (key: string) => appAtomRegistry.get(store.filePatchAtom(key));
    return { store, read, getFullThreadDiff };
  }

  it("loads files opened in one tick with one request, and never twice", async () => {
    const { store, read, getFullThreadDiff } = setup();
    const first = store.loadFilePatch(input, served, 0);
    const second = store.loadFilePatch(input, served, 2);
    store.loadFilePatch(input, served, 0);
    expect(read(first).isLoading).toBe(true);
    await vi.waitFor(() => expect(read(second).patch).toBe(segment("f2.ts")));
    expect(getFullThreadDiff).toHaveBeenCalledTimes(1);
    expect(getFullThreadDiff.mock.calls[0]?.[0]).toMatchObject({
      fileView: { kind: "files", indices: [0, 2] },
    });
    store.loadFilePatch(input, served, 2);
    expect(getFullThreadDiff).toHaveBeenCalledTimes(1);
    store.clear();
  });

  it("refuses patches of another commit pair and bounds what it keeps", async () => {
    const { store, read } = setup();
    const moved = { ...served, commits: { fromCommitOid: "c0", toCommitOid: "other" } };
    const key = store.loadFilePatch(input, moved, 1);
    await vi.waitFor(() => expect(read(key).error).toContain("changed"));

    // 60-character patches against a 100-character bound: the older one goes.
    const a = store.loadFilePatch(input, served, 0);
    await vi.waitFor(() => expect(read(a).patch).not.toBeNull());
    const b = store.loadFilePatch(input, served, 1);
    await vi.waitFor(() => expect(read(b).patch).not.toBeNull());
    expect(read(a).patch).toBeNull();
    store.clear();
  });

  it("serves an older node's whole diff from the split, with no request", () => {
    const { store, read, getFullThreadDiff } = setup();
    const whole = readCheckpointDiffFileIndex({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: segment("a.ts"),
    });
    expect(read(store.loadFilePatch(input, whole, 0)).patch).toBe(segment("a.ts"));
    expect(getFullThreadDiff).not.toHaveBeenCalled();
    store.clear();
  });
});
