import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type EnvironmentApi,
  type EffectiveProjectPreferences,
  type OrchestrationThread,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import type { KVService } from "../../platform/index.ts";
import { readEffectiveProjectPreferences } from "../settings/projectPreferences.ts";
import {
  batchSelectionKey,
  createBatchLaunch,
  createBatchLaunchStore,
  prepareBatchDestination,
  normalizeBatchSelection,
  deriveBatchResultEvidence,
  type BatchLaunchPorts,
  readBatchResultEvidence,
} from "./batchLaunch.ts";

const env = EnvironmentId.make("fixture-node");
const project = ProjectId.make("fixture-project");
const date = "2026-09-30T00:00:00.000Z";
const provider = (id: string, options = true): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: date,
  slashCommands: [],
  skills: [],
  models: [
    {
      slug: "model",
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: options
          ? [
              {
                id: "reasoningEffort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "low", label: "Low", isDefault: true },
                  { id: "high", label: "High" },
                ],
              },
              { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
            ]
          : [],
      },
    },
  ],
});
const providers = [provider("personal"), provider("work", false)];
const selections = [
  createModelSelection(providers[0]!.instanceId, "model", [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ]),
  createModelSelection(providers[1]!.instanceId, "model", [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ]),
];
const batch = (id = "fixture") =>
  createBatchLaunch({
    id,
    ownerKey: "draft",
    environmentId: env,
    projectId: project,
    selections,
    providers,
    prompt: "Fix the issue",
    isGitRepo: true,
    baseBranch: "main",
    createdAt: date,
  });
function memory() {
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
  return { storage, values };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const statuses = (store: ReturnType<typeof createBatchLaunchStore>) =>
  store.useStore.getState().batches[0]!.destinations.map((target) => target.status);

describe("batch launch", () => {
  it("keeps exact instance identity and independently normalizes options", () => {
    const result = batch();
    expect(result.destinations[0]!.modelSelection).toEqual(selections[0]);
    expect(result.destinations[1]!.modelSelection).toEqual(
      createModelSelection(providers[1]!.instanceId, "model"),
    );
    expect(result.destinations[0]!.threadId).not.toBe(result.destinations[1]!.threadId);
    expect(() =>
      normalizeBatchSelection(
        { ...selections[0]!, instanceId: ProviderInstanceId.make("missing") },
        providers,
        "",
      ),
    ).toThrow("unavailable");
  });
  it("deduplicates combinations after capability normalization, including option order", () => {
    expect(batchSelectionKey(selections[0]!)).toBe(
      batchSelectionKey({ ...selections[0]!, options: selections[0]!.options!.toReversed() }),
    );
    expect(() =>
      createBatchLaunch({
        ...batch(),
        selections: [selections[0]!, selections[0]!],
        providers,
        prompt: "x",
        isGitRepo: true,
        baseBranch: "main",
      }),
    ).toThrow("unique");
  });
  it("bounds fanout and rejects non-Git or missing branch scenarios", () => {
    const input = {
      ...batch(),
      selections,
      providers,
      prompt: "x",
      isGitRepo: true,
      baseBranch: "main",
    };
    expect(() => createBatchLaunch({ ...input, isGitRepo: false })).toThrow("Git");
    expect(() => createBatchLaunch({ ...input, baseBranch: null })).toThrow("Git");
    expect(() => createBatchLaunch({ ...input, selections: [selections[0]!] })).toThrow(
      "between 2 and 4",
    );
    expect(() =>
      createBatchLaunch({
        ...input,
        selections: Array.from({ length: 5 }, (_, index) =>
          createModelSelection(ProviderInstanceId.make(`p${index}`), "model"),
        ),
        providers: Array.from({ length: 5 }, (_, index) => provider(`p${index}`)),
      }),
    ).toThrow("between 2 and 4");
  });
  it("writes destination intent before dispatch and prevents concurrent/repeated sends", async () => {
    const { storage, values } = memory();
    const store = createBatchLaunchStore(storage);
    const item = await store.add(batch());
    expect((await store.add(batch("different"))).id).toBe(item.id);
    const gate = deferred();
    const dispatch = vi.fn(async () => {
      expect(
        JSON.parse([...values.values()][0]!).batches[0].destinations.some(
          (target: { status: string }) => target.status === "dispatching",
        ),
      ).toBe(true);
      await gate.promise;
    });
    const ports = { assertMutationReady: () => {}, prepare: async () => dispatch };
    const first = store.run(item.id, ports);
    const second = store.run(item.id, ports);
    expect(first).toBe(second);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    gate.resolve();
    await first;
    await store.run(item.id, ports);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(statuses(store)).toEqual(["launched", "launched"]);
  });
  it("retries only proven pre-dispatch failures, preserving accepted and uncertain destinations", async () => {
    const store = createBatchLaunchStore(memory().storage);
    const item = await store.add(batch());
    let failed = false;
    const dispatch = vi.fn(async () => {});
    const ports: BatchLaunchPorts = {
      assertMutationReady: () => {},
      prepare: async (target) => {
        if (target.threadId === item.destinations[0]!.threadId && !failed) {
          failed = true;
          throw new Error("Upload failed before dispatch");
        }
        return dispatch;
      },
    };
    await store.run(item.id, ports);
    expect(statuses(store)).toEqual(["failed", "launched"]);
    await store.run(item.id, ports);
    expect(statuses(store)).toEqual(["launched", "launched"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      store.useStore.getState().batches[0]!.destinations.map((target) => target.attempts),
    ).toEqual([2, 1]);
  });
  it("never retries an uncertain transport error and reconciles only exact accepted evidence", async () => {
    const { storage } = memory();
    const store = createBatchLaunchStore(storage);
    const item = await store.add(batch());
    const dispatch = vi.fn(async () => {
      throw new Error("Connection lost after write");
    });
    const ports = { assertMutationReady: () => {}, prepare: async () => dispatch };
    await store.run(item.id, ports);
    await store.run(item.id, ports);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(statuses(store)).toEqual(["uncertain", "uncertain"]);
    await store.reconcile(item.id, [
      {
        ...item.destinations[0]!,
        messageId: item.destinations[1]!.messageId,
        worktreePath: "/fixture",
      },
    ]);
    expect(statuses(store)[0]).toBe("uncertain");
    await store.reconcile(item.id, [{ ...item.destinations[0]!, worktreePath: null }]);
    expect(statuses(store)[0]).toBe("uncertain");
    await store.reconcile(item.id, [{ ...item.destinations[0]!, worktreePath: "/fixture" }]);
    expect(statuses(store)).toEqual(["launched", "uncertain"]);
    const restored = createBatchLaunchStore(storage);
    await restored.ready;
    await restored.run(item.id, ports);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("reload converts outstanding dispatches into uncertainty without replay", async () => {
    const { storage } = memory();
    const store = createBatchLaunchStore(storage);
    const item = await store.add(batch());
    const gate = deferred();
    const dispatch = vi.fn(async () => gate.promise);
    const run = store.run(item.id, {
      assertMutationReady: () => {},
      prepare: async () => dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    const restored = createBatchLaunchStore(storage);
    await restored.ready;
    expect(statuses(restored)).toEqual(["uncertain", "uncertain"]);
    await restored.run(item.id, { assertMutationReady: () => {}, prepare: async () => dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    gate.resolve();
    await run;
  });
  it("cancellation fences delayed preparation, leaving no turn/worktree dispatch", async () => {
    const store = createBatchLaunchStore(memory().storage);
    const item = await store.add(batch());
    const gate = deferred();
    const dispatch = vi.fn(async () => {});
    const prepare = vi.fn(async () => {
      await gate.promise;
      return dispatch;
    });
    const run = store.run(item.id, { assertMutationReady: () => {}, prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await store.cancel(item.id);
    gate.resolve();
    await run;
    expect(dispatch).not.toHaveBeenCalled();
    expect(statuses(store)).toEqual(["cancelled", "cancelled"]);
  });
  it("stop remaining launches does not interrupt accepted model turns", async () => {
    const store = createBatchLaunchStore(memory().storage);
    const item = await store.add(batch());
    const gate = deferred();
    const dispatch = vi.fn(async () => gate.promise);
    const run = store.run(item.id, {
      assertMutationReady: () => {},
      prepare: async () => dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    await store.cancel(item.id);
    gate.resolve();
    await run;
    expect(statuses(store)).toEqual(["launched", "launched"]);
  });
  it("rechecks shell/node readiness after delayed preparation", async () => {
    const store = createBatchLaunchStore(memory().storage);
    const item = await store.add(batch());
    let ready = true;
    const dispatch = vi.fn(async () => {});
    await store.run(item.id, {
      assertMutationReady: () => {
        if (!ready) throw new Error("Shell generation changed");
      },
      prepare: async () => {
        ready = false;
        return dispatch;
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(statuses(store)).toEqual(["failed", "failed"]);
  });
  it("fails closed when write-ahead storage is unavailable", async () => {
    const { storage } = memory();
    const store = createBatchLaunchStore(storage);
    const item = await store.add(batch());
    storage.setItem = async () => {
      throw new Error("Disk unavailable");
    };
    const dispatch = vi.fn(async () => {});
    await store.run(item.id, { assertMutationReady: () => {}, prepare: async () => dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.useStore.getState().storageError).not.toBeNull();
  });
  it("does not reclaim an uncertain source as a new batch", async () => {
    const store = createBatchLaunchStore(memory().storage);
    const item = await store.add(batch());
    await store.run(item.id, {
      assertMutationReady: () => {},
      prepare: async () => async () => {
        throw new Error("timeout");
      },
    });
    expect(await store.releaseSource(item.id)).toBe(false);
    expect((await store.add(batch("next"))).id).toBe(item.id);
  });
  it("normal send path carries required-worktree bootstrap and exact options/context", async () => {
    const item = batch();
    const commands: unknown[] = [];
    const api = {
      server: {
        getConfig: async () => ({
          providers,
          environment: { environmentId: env, capabilities: { requiredWorktreeBootstrap: true } },
          settings: { worktreeBranchPrefix: "team/tasks" },
        }),
      },
      orchestration: {
        dispatchCommand: async (command: unknown) => {
          commands.push(command);
        },
      },
    } as unknown as EnvironmentApi;
    for (const destination of item.destinations) {
      const dispatch = await prepareBatchDestination({
        api,
        batch: item,
        destination,
        providers,
        prompt: "Same initial context",
        projectCwd: "/fixture/project",
        baseBranch: "main",
        fetchOrigin: false,
        runtimeMode: "full-access",
        interactionMode: "ask",
        tokenMode: "balanced",
        sourceControlContexts: [],
        attachments: [],
        assertMutationReady: () => {},
      });
      await dispatch();
    }
    expect(commands).toHaveLength(2);
    for (let index = 0; index < commands.length; index++)
      expect(commands[index]).toMatchObject({
        type: "thread.turn.start",
        modelSelection: item.destinations[index]!.modelSelection,
        interactionMode: "default",
        message: { text: "Same initial context", messageId: item.destinations[index]!.messageId },
        commandId: `composer-send:${item.destinations[index]!.threadId}:${item.destinations[index]!.messageId}`,
        bootstrap: {
          requireWorktree: true,
          prepareWorktree: {
            projectCwd: "/fixture/project",
            baseBranch: "main",
            fetchOrigin: false,
            branch: `team/tasks/batch-fixture-${index}`,
          },
          runSetupScript: true,
        },
      });
  });
});

it("bounds concurrency across separate source drafts, not only within one batch", async () => {
  const store = createBatchLaunchStore(memory().storage);
  const first = await store.add(batch("first"));
  const second = await store.add({ ...batch("second"), ownerKey: "other-draft" });
  const gate = deferred();
  let active = 0;
  let maximum = 0;
  const dispatch = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
  });
  const ports = { assertMutationReady: () => {}, prepare: async () => dispatch };
  const runs = [store.run(first.id, ports), store.run(second.id, ports)];
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
  gate.resolve();
  await Promise.all(runs);
  expect(dispatch).toHaveBeenCalledTimes(4);
  expect(maximum).toBe(2);
});

it("rejects oversized metadata before retaining it and fails closed on oversized restore", async () => {
  const { storage, values } = memory();
  const store = createBatchLaunchStore(storage);
  await expect(store.add({ ...batch(), ownerKey: "x".repeat(256 * 1024) })).rejects.toThrow("full");
  expect(store.useStore.getState().batches).toEqual([]);
  values.set("ryco:batch-launches:v1", "x".repeat(256 * 1024 + 1));
  const restored = createBatchLaunchStore(storage);
  await restored.ready;
  expect(restored.useStore.getState().storageError).not.toBeNull();
});

it("does not invent missing diff/usage/test evidence or accept another project", () => {
  const item = batch();
  const target = item.destinations[0]!;
  const thread = {
    id: target.threadId,
    projectId: item.projectId,
    deletedAt: null,
    checkpoints: [],
    activities: [],
    messages: [],
    latestTurn: null,
    session: null,
    worktreePath: null,
  } as unknown as OrchestrationThread;
  expect(deriveBatchResultEvidence(item, target, thread)).toMatchObject({
    accepted: false,
    files: null,
    tokens: null,
    worktreePath: null,
  });
  expect(
    deriveBatchResultEvidence(item, target, {
      ...thread,
      projectId: ProjectId.make("other-project"),
    }),
  ).toBeNull();
});

it("atomically retains different sources across two stale stores and claims one shared source once", async () => {
  const { storage, values } = memory();
  const first = createBatchLaunchStore(storage);
  const second = createBatchLaunchStore(storage);
  await Promise.all([first.ready, second.ready]);
  await Promise.all([
    first.add(batch("a")),
    second.add({ ...batch("b"), ownerKey: "other-source" }),
  ]);
  expect(
    JSON.parse(values.get("ryco:batch-launches:v1")!).batches.map(
      (item: { id: string }) => item.id,
    ),
  ).toEqual(["a", "b"]);
  const claims = await Promise.all([
    first.add({ ...batch("c"), ownerKey: "shared-source" }),
    second.add({ ...batch("d"), ownerKey: "shared-source" }),
  ]);
  expect(claims[0]!.id).toBe(claims[1]!.id);
  const dispatch = vi.fn(async () => {});
  const ports = { assertMutationReady: () => {}, prepare: async () => dispatch };
  await Promise.all([first.run(claims[0]!.id, ports), second.run(claims[1]!.id, ports)]);
  expect(dispatch).toHaveBeenCalledTimes(2);
  await first.refresh();
  expect(first.useStore.getState().batches).toHaveLength(3);
  expect(
    first.useStore
      .getState()
      .batches.find((item) => item.id === claims[0]!.id)
      ?.destinations.every((target) => target.status === "launched"),
  ).toBe(true);
});

it("retries safe failures under a fresh authority generation with immutable dispatch IDs", async () => {
  const store = createBatchLaunchStore(memory().storage);
  const item = await store.add(batch());
  let generation = 1;
  const commands: Array<{ threadId: string; messageId: string }> = [];
  const ports: BatchLaunchPorts = {
    assertMutationReady: () => {
      throw new Error("Old port must not be used");
    },
    captureMutationReadiness: () => {
      const captured = generation;
      return () => {
        if (captured !== generation) throw new Error("Disconnected");
      };
    },
    prepare: async (target, _signal, guard) => {
      if (generation === 1) generation = 2;
      guard();
      return async () => {
        commands.push({ threadId: target.threadId, messageId: target.messageId });
      };
    },
  };
  await store.run(item.id, ports);
  expect(statuses(store)).toEqual(["failed", "failed"]);
  expect(commands).toEqual([]);
  await store.run(item.id, ports);
  await store.run(item.id, ports);
  expect(commands).toEqual(
    item.destinations.map(({ threadId, messageId }) => ({ threadId, messageId })),
  );
});

it("finds authoritative acceptance after arbitrarily many assistant responses following a lost ack", async () => {
  const item = batch();
  const target = item.destinations[0]!;
  const thread = {
    id: target.threadId,
    projectId: project,
    deletedAt: null,
    worktreePath: "/fixture/worktree",
    messages: [{ id: "last-assistant", role: "assistant" }],
    activities: [],
    checkpoints: [],
    session: null,
    latestTurn: null,
  } as unknown as OrchestrationThread;
  const history = vi.fn(async () => ({
    collection: "messages",
    items: [{ id: target.messageId, role: "user" }],
  }));
  const api = {
    orchestration: { getThreadWindow: async () => ({ thread }), getThreadHistoryPage: history },
  } as unknown as EnvironmentApi;
  const store = createBatchLaunchStore(memory().storage);
  await store.add(item);
  await store.run(item.id, {
    assertMutationReady: () => {},
    prepare: async () => async () => {
      throw new Error("lost ack");
    },
  });
  const evidence = await readBatchResultEvidence({
    api,
    batch: item,
    destination: target,
    assertMutationReady: () => {},
  });
  expect(history).toHaveBeenCalledWith({
    threadId: target.threadId,
    collection: "messages",
    mode: { kind: "around", anchorId: target.messageId },
    limit: 1,
  });
  expect(evidence?.accepted).toBe(true);
  if (evidence?.accepted) await store.reconcile(item.id, [evidence]);
  expect(statuses(store)).toEqual(["launched", "uncertain"]);
});

it("uses effective project branch/setup defaults but preserves each explicit target and required worktree", async () => {
  const item = batch();
  const dispatch = vi.fn(async () => {});
  const config = {
    providers,
    environment: {
      environmentId: env,
      capabilities: { projectPreferences: true, requiredWorktreeBootstrap: true },
    },
    settings: { worktreeBranchPrefix: "node-default" },
  };
  const effective: EffectiveProjectPreferences = {
    worktreeBranchPrefix: { value: "project", source: "project" },
    runSetupScript: { value: false, source: "project" },
    initialModelSelection: {
      value: { instanceId: ProviderInstanceId.make("other-preset"), model: "other" },
      source: "project",
    },
    defaultThreadEnvMode: { value: "local", source: "node" },
    worktreeRoot: { value: "/node/project-worktrees", source: "project" },
    overrides: { runSetupScript: false },
  };
  const readPreferences = vi.fn(async () => effective);
  const api = {
    server: { getConfig: async () => config, getProjectPreferences: readPreferences },
    orchestration: { dispatchCommand: dispatch },
  } as unknown as EnvironmentApi;
  const input = {
    api,
    batch: item,
    destination: item.destinations[0]!,
    providers,
    prompt: "same",
    projectCwd: "/fixture/project",
    baseBranch: "main",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    tokenMode: "balanced" as const,
    attachments: [],
    sourceControlContexts: [],
    assertMutationReady: () => {},
  };
  await expect(prepareBatchDestination(input)).rejects.toThrow("resolver");
  const prepared = await prepareBatchDestination({
    ...input,
    readProjectPreferences: readEffectiveProjectPreferences,
  });
  await prepared();
  expect(readPreferences).toHaveBeenCalledExactlyOnceWith({ projectId: project });
  expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
    modelSelection: item.destinations[0]!.modelSelection,
    bootstrap: {
      requireWorktree: true,
      runSetupScript: false,
      prepareWorktree: { branch: "project/batch-fixture-0" },
    },
  });
  await expect(
    prepareBatchDestination({
      ...input,
      api: {
        ...api,
        server: {
          ...api.server,
          getProjectPreferences: async () => {
            throw new Error("Capable read failed");
          },
        },
      } as unknown as EnvironmentApi,
      readProjectPreferences: readEffectiveProjectPreferences,
    }),
  ).rejects.toThrow("Capable read failed");
});

it("never replays accepted turns when acknowledgement succeeded but saving launch history failed", async () => {
  const { storage } = memory();
  const store = createBatchLaunchStore(storage);
  const item = await store.add(batch());
  const save = storage.setItem;
  const dispatch = vi.fn(async () => {});
  storage.setItem = async (key, value) => {
    if (
      JSON.parse(value).batches.some((batch: { destinations: Array<{ status: string }> }) =>
        batch.destinations.some((target) => target.status === "launched"),
      )
    )
      throw new Error("Durability lost after acknowledgement");
    await save(key, value);
  };
  await store.run(item.id, { assertMutationReady: () => {}, prepare: async () => dispatch });
  expect(store.useStore.getState().storageError).not.toBeNull();
  storage.setItem = save;
  const recovered = createBatchLaunchStore(storage);
  await recovered.ready;
  await recovered.run(item.id, { assertMutationReady: () => {}, prepare: async () => dispatch });
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(statuses(recovered)).toEqual(["uncertain", "uncertain"]);
});

it("does not downgrade another store's authoritative acceptance when a late lost ack arrives", async () => {
  const { storage } = memory();
  const first = createBatchLaunchStore(storage);
  const second = createBatchLaunchStore(storage);
  const item = await first.add(batch());
  const gate = deferred();
  const run = first.run(item.id, {
    assertMutationReady: () => {},
    prepare: async () => async () => {
      await gate.promise;
      throw new Error("Late lost ack");
    },
  });
  await vi.waitFor(() => expect(statuses(first)).toEqual(["dispatching", "dispatching"]));
  await second.reconcile(
    item.id,
    item.destinations.map((target) =>
      Object.assign({}, target, { worktreePath: "/fixture/worktree" }),
    ),
  );
  gate.resolve();
  await run;
  await first.refresh();
  expect(statuses(first)).toEqual(["launched", "launched"]);
});

it("bounds retained history entries without discarding an old accepted source", async () => {
  const { storage, values } = memory();
  values.set(
    "ryco:batch-launches:v1",
    JSON.stringify({
      version: 1,
      batches: Array.from({ length: 128 }, (_, index) => {
        const item = batch(`retained-${index}`);
        return {
          ...item,
          ownerKey: `completed:${item.id}`,
          destinations: item.destinations.map((target) =>
            Object.assign({}, target, { status: "launched" }),
          ),
        };
      }),
    }),
  );
  const restored = createBatchLaunchStore(storage);
  await restored.ready;
  await expect(restored.add({ ...batch("new-source"), ownerKey: "new-source" })).rejects.toThrow(
    "full",
  );
  expect(restored.useStore.getState().batches).toHaveLength(128);
  expect(restored.useStore.getState().storageError).toBeNull();
});
