import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { createBatchSourceDraftStore } from "./batchSourceDraft.ts";
import {
  BATCH_LAUNCH_MAX_HISTORY,
  createBatchLaunch,
  createBatchLaunchStore,
} from "./batchLaunch.ts";
import type { KVService } from "../../platform/index.ts";

it("restores a native source on restart and retries only its proven pre-dispatch failure", async () => {
  const values = new Map<string, string>();
  const storage: KVService = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const environmentId = EnvironmentId.make("fixture-node");
  const projectId = ProjectId.make("fixture-project");
  const selections = ["first", "second", "third"].map((id) => ({
    instanceId: ProviderInstanceId.make(id),
    model: "model",
  }));
  const providers = selections.map((selection) => ({
    instanceId: selection.instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "model", name: "Model", capabilities: {} }],
    slashCommands: [],
    skills: [],
  })) as unknown as ServerProvider[];
  const first = createBatchLaunchStore(storage);
  const drafts = createBatchSourceDraftStore(storage, {
    isSourceReleased: first.isSourceReleased,
    newSourceId: () => "rotated-source",
  });
  const saved = await drafts.claim({
    id: "stable-source",
    environmentId,
    projectId,
    prompt: "Original source context",
    projectCwd: "/fixture/project",
    baseBranch: "main",
    selections,
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "balanced",
    attachments: [
      {
        type: "image",
        name: "fixture.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,YQ==",
      },
    ],
  });
  const batch = await first.add(
    createBatchLaunch({
      id: saved.id,
      ownerKey: saved.id,
      environmentId,
      projectId,
      prompt: saved.prompt,
      selections: saved.selections,
      providers,
      isGitRepo: true,
      baseBranch: saved.baseBranch,
      createdAt: "2026-09-30T00:00:00.000Z",
    }),
  );
  await first.run(batch.id, {
    assertMutationReady: () => {},
    prepare: async (target) => {
      if (target.threadId === batch.destinations[1]!.threadId)
        throw new Error("Pre-dispatch upload failure");
      return async () => {
        if (target.threadId === batch.destinations[2]!.threadId)
          throw new Error("Lost acknowledgement");
      };
    },
  });
  // Simulate process restart: no component state, File/URI, or retry-port ref survives.
  const restoredLedger = createBatchLaunchStore(storage);
  const restoredSource = await createBatchSourceDraftStore(storage, {
    isSourceReleased: restoredLedger.isSourceReleased,
    newSourceId: () => "restored-source",
  }).load(environmentId, projectId);
  expect(restoredSource).toEqual(saved);
  await restoredLedger.ready;
  const retained = restoredLedger.useStore.getState().batches[0]!;
  expect(retained.destinations.map((target) => target.status)).toEqual([
    "launched",
    "failed",
    "uncertain",
  ]);
  const prepare = vi.fn(async () => async () => {});
  await restoredLedger.run(retained.id, { assertMutationReady: () => {}, prepare });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({
    threadId: batch.destinations[1]!.threadId,
    messageId: batch.destinations[1]!.messageId,
  });
  // A second claim preserves the immutable prompt, stable ID, and durable image bytes.
  expect(await drafts.claim({ ...saved, id: "new-random-id", prompt: "Changed" })).toEqual(saved);
  expect([...values.values()].join("\n")).not.toContain("previewUri");
});

it.each(["delete failure", "crash before delete", "history at capacity"])(
  "rotates a completed native source after %s without replaying accepted targets",
  async (interruption) => {
    const values = new Map<string, string>();
    const storage: KVService = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async () => {
        throw new Error("Fixture delete failure");
      },
    };
    const environmentId = EnvironmentId.make("fixture-node");
    const projectId = ProjectId.make("fixture-project");
    const selections = ["first", "second"].map((id) => ({
      instanceId: ProviderInstanceId.make(id),
      model: "model",
    }));
    const providers = selections.map((selection) => ({
      instanceId: selection.instanceId,
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "model", name: "Model", capabilities: {} }],
      slashCommands: [],
      skills: [],
    })) as unknown as ServerProvider[];
    const ledger = createBatchLaunchStore(storage);
    const drafts = createBatchSourceDraftStore(storage, {
      isSourceReleased: ledger.isSourceReleased,
      newSourceId: () => "live-rotated-source",
    });
    const saved = await drafts.claim({
      id: "completed-source",
      environmentId,
      projectId,
      prompt: "Original accepted context",
      projectCwd: "/fixture/project",
      baseBranch: "main",
      selections,
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "balanced",
      attachments: [],
    });
    const makeBatch = (source: typeof saved) =>
      createBatchLaunch({
        id: source.id,
        ownerKey: source.id,
        environmentId,
        projectId,
        prompt: source.prompt,
        selections: source.selections,
        providers,
        isGitRepo: true,
        baseBranch: source.baseBranch,
        createdAt: "2026-09-30T00:00:00.000Z",
      });
    const original = await ledger.add(makeBatch(saved));
    const accepted = vi.fn(async () => {});
    await ledger.run(original.id, { assertMutationReady: () => {}, prepare: async () => accepted });
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(await ledger.releaseSource(original.id)).toBe(true);
    if (interruption === "delete failure")
      await expect(drafts.remove(saved)).rejects.toThrow("Fixture delete failure");
    expect([...values.values()].some((raw) => raw.includes("Original accepted context"))).toBe(
      true,
    );

    if (interruption === "history at capacity") {
      const completed = ledger.useStore.getState().batches[0]!;
      // Fixture terminal history fills the bound; production never evicts old markers.
      const retained = Array.from({ length: BATCH_LAUNCH_MAX_HISTORY - 1 }, (_, index) => {
        const item = makeBatch({ ...saved, id: `retained-${index}` });
        return {
          ...item,
          ownerKey: `completed:${item.id}`,
          destinations: item.destinations.map((target) =>
            Object.assign({}, target, { status: "launched" }),
          ),
        };
      });
      await storage.setItem(
        "ryco:batch-launches:v1",
        JSON.stringify({ version: 1, batches: [completed, ...retained] }),
      );
    }
    // Both the ledger and draft store restart, as they do on native remount/relaunch.
    const restoredLedger = createBatchLaunchStore(storage);
    const restoredDrafts = createBatchSourceDraftStore(storage, {
      isSourceReleased: restoredLedger.isSourceReleased,
      newSourceId: () => "fresh-source",
    });
    expect(await restoredDrafts.load(environmentId, projectId)).toBeNull();
    const setItem = storage.setItem;
    storage.setItem = async () => {
      throw new Error("Fixture replacement failure");
    };
    await expect(
      restoredDrafts.claim({ ...saved, prompt: "New comparison context" }),
    ).rejects.toThrow("Fixture replacement failure");
    expect([...values.values()].some((raw) => raw.includes("Original accepted context"))).toBe(
      true,
    );
    storage.setItem = setItem;
    // Also covers a live composer retaining the old ID after failed cleanup.
    const fresh = await restoredDrafts.claim({ ...saved, prompt: "New comparison context" });
    expect(fresh.id).toBe("fresh-source");
    expect(await restoredDrafts.load(environmentId, projectId)).toEqual(fresh);
    if (interruption === "history at capacity") {
      await expect(restoredLedger.add(makeBatch(fresh))).rejects.toThrow("history is full");
      expect(restoredLedger.useStore.getState().batches).toHaveLength(BATCH_LAUNCH_MAX_HISTORY);
      expect(await restoredLedger.isSourceReleased(saved)).toBe(true);
      expect(await restoredDrafts.claim(saved)).toEqual(fresh);
      const prepare = vi.fn(async () => async () => {});
      await restoredLedger.run(original.id, { assertMutationReady: () => {}, prepare });
      expect(prepare).not.toHaveBeenCalled();
      expect(restoredLedger.useStore.getState().batches[0]?.ownerKey).toBe(
        `completed:${original.id}`,
      );
      return;
    }
    const next = await restoredLedger.add(makeBatch(fresh));
    expect(next.id).not.toBe(original.id);
    expect(
      next.destinations.every((target) =>
        original.destinations.every(
          (old) => old.threadId !== target.threadId && old.messageId !== target.messageId,
        ),
      ),
    ).toBe(true);
    const dispatch = vi.fn(async () => {});
    const prepare = vi.fn(async () => dispatch);
    await restoredLedger.run(original.id, { assertMutationReady: () => {}, prepare });
    expect(prepare).not.toHaveBeenCalled();
    await expect(restoredLedger.add(makeBatch(saved))).rejects.toThrow("fresh source draft");
    expect(restoredLedger.useStore.getState().storageError).toBeNull();
    await restoredLedger.run(next.id, { assertMutationReady: () => {}, prepare });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      prepare.mock.calls.every(([target]) =>
        next.destinations.some((item) => item.threadId === target.threadId),
      ),
    ).toBe(true);
    expect(
      restoredLedger.useStore
        .getState()
        .batches.find((item) => item.id === original.id)
        ?.destinations.map((target) => target.status),
    ).toEqual(["launched", "launched"]);
  },
);
