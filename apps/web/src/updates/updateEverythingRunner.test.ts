import type {
  UpdateEverythingEnvironmentInput,
  UpdateEverythingIo,
  UpdateEverythingLocalApp,
  UpdateEverythingResultDescription,
} from "@ryco/client-runtime/updates";
import {
  EnvironmentId,
  type NodeUpdateInput,
  type ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { nodeUpdateState, updatableProvider } from "./testing/updateFixtures";
import {
  createUpdateEverythingRunner,
  type UpdateEverythingRunnerDeps,
} from "./updateEverythingRunner";

const LOCAL = EnvironmentId.make("env-local");
const SERVER = EnvironmentId.make("env-server");
const LAPTOP = EnvironmentId.make("env-laptop");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<UpdateEverythingEnvironmentInput> = {},
): UpdateEverythingEnvironmentInput {
  return {
    environmentId,
    label,
    connected: true,
    canMutate: true,
    hostedByThisApp: false,
    serverVersion: "0.1.35",
    supportsNodeUpdate: true,
    nodeUpdate: nodeUpdateState({ availability: "current", latestVersion: "0.1.35" }),
    providers: [updatableProvider("codex")],
    busyProviderInstanceIds: [],
    runningChatCount: 0,
    continueThreadsAfterRestart: true,
    ...overrides,
  };
}

function providerAnswer(instanceId: string): ServerProviderUpdatedPayload {
  return {
    providers: [
      {
        ...updatableProvider(instanceId),
        updateState: {
          status: "succeeded",
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        },
      },
    ],
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(input: {
  readonly environments: ReadonlyArray<UpdateEverythingEnvironmentInput>;
  readonly localApp?: UpdateEverythingLocalApp;
  readonly io?: Partial<UpdateEverythingIo>;
  readonly checkAll?: UpdateEverythingRunnerDeps["checkAll"];
}) {
  const calls: string[] = [];
  const shown: UpdateEverythingResultDescription[] = [];
  let requests = 0;
  const io: UpdateEverythingIo = {
    updateProvider: vi.fn(async (environmentId, provider) => {
      calls.push(`provider ${environmentId} ${provider.instanceId}`);
      return providerAnswer(provider.instanceId);
    }),
    updateNode: vi.fn(async (environmentId, update: NodeUpdateInput) => {
      calls.push(`node ${environmentId} ${update.targetVersion}`);
      return nodeUpdateState({
        currentVersion: update.targetVersion,
        run: { status: "succeeded", requestId: update.requestId },
      });
    }),
    waitForNodeOutcome: vi.fn(async () => ({ outcome: "succeeded" as const, message: null })),
    isStillAllowed: () => true,
    installThisApp: vi.fn(async () => {
      calls.push("this app");
      return true;
    }),
    newRequestId: () => `request-${++requests}`,
    ...input.io,
  };
  const runner = createUpdateEverythingRunner({
    readInputs: () => ({ environments: input.environments, localApp: input.localApp ?? null }),
    io,
    showResult: (description) => shown.push(description),
    checkAll: input.checkAll ?? (async () => undefined),
  });
  return { runner, io, calls, shown };
}

describe("createUpdateEverythingRunner", () => {
  it("runs the plan, follows its progress, and shows one notice when it finishes", async () => {
    const h = harness({
      environments: [
        environment(SERVER, "Server", { nodeUpdate: nodeUpdateState() }),
        environment(LAPTOP, "Laptop"),
      ],
    });
    const seen: string[] = [];
    h.runner.subscribe(() => {
      const snapshot = h.runner.getSnapshot();
      seen.push(`${snapshot.running ? "running" : "idle"}:${snapshot.run?.phase ?? "none"}`);
    });

    h.runner.start();
    expect(h.runner.getSnapshot().running).toBe(true);
    await flush();

    const snapshot = h.runner.getSnapshot();
    expect(snapshot.running).toBe(false);
    expect(snapshot.run?.phase).toBe("finished");
    expect(snapshot.result).toMatchObject({ updatedNodes: 1, updatedProviders: 2, failures: [] });
    expect(h.calls).toEqual([
      "provider env-laptop codex",
      "provider env-server codex",
      "node env-server 0.1.36",
    ]);
    expect(h.shown).toEqual([{ type: "success", title: "Updated 1 node and 2 providers" }]);
    expect(seen[0]).toBe("running:none");
    expect(seen.at(-1)).toBe("idle:finished");
  });

  it("runs one plan at a time", async () => {
    const answer = deferred<ServerProviderUpdatedPayload>();
    const h = harness({
      environments: [environment(SERVER, "Server")],
      io: {
        updateProvider: vi.fn(() => answer.promise),
      },
    });
    h.runner.start();
    h.runner.start();
    h.runner.start({ environmentIds: [SERVER] });
    await flush();
    expect(h.io.updateProvider).toHaveBeenCalledTimes(1);

    answer.resolve(providerAnswer("codex"));
    await flush();
    expect(h.runner.getSnapshot().running).toBe(false);
    expect(h.shown).toHaveLength(1);

    // Finished: the next start runs again.
    h.runner.start();
    await flush();
    expect(h.io.updateProvider).toHaveBeenCalledTimes(2);
  });

  it("runs only the listed devices when given environment ids", async () => {
    const h = harness({
      environments: [environment(SERVER, "Server"), environment(LAPTOP, "Laptop")],
    });
    h.runner.start({ environmentIds: [LAPTOP] });
    await flush();
    expect(h.calls).toEqual(["provider env-laptop codex"]);
    expect(h.runner.getSnapshot().run?.devices.map((device) => device.environmentId)).toEqual([
      LAPTOP,
    ]);
    expect(h.shown).toEqual([{ type: "success", title: "Updated 1 provider" }]);
  });

  it("does nothing when the plan (or the listed part of it) has no one-click work", async () => {
    const h = harness({
      environments: [
        environment(SERVER, "Server"),
        environment(LAPTOP, "Laptop", { providers: [] }),
      ],
    });
    h.runner.start({ environmentIds: [LAPTOP] });
    h.runner.start({ environmentIds: [] });
    await flush();
    expect(h.runner.getSnapshot()).toMatchObject({ running: false, run: null, result: null });
    expect(h.calls).toEqual([]);
    expect(h.shown).toEqual([]);
  });

  it("installs this desktop app last, after every other node finished", async () => {
    const remoteOutcome = deferred<{ outcome: "succeeded"; message: null }>();
    const h = harness({
      environments: [
        environment(LOCAL, "This Mac", {
          hostedByThisApp: true,
          providers: [],
          nodeUpdate: nodeUpdateState({ installation: { kind: "desktop-app", service: null } }),
        }),
        environment(SERVER, "Server", { providers: [], nodeUpdate: nodeUpdateState() }),
      ],
      localApp: {
        enabled: true,
        status: "downloaded",
        currentVersion: "0.1.35",
        availableVersion: "0.1.36",
        downloadedVersion: "0.1.36",
        downloadPercent: null,
      },
      io: {
        updateNode: vi.fn(async (environmentId, update: NodeUpdateInput) => {
          h.calls.push(`node ${environmentId} ${update.targetVersion}`);
          return nodeUpdateState({ run: { status: "preparing", requestId: update.requestId } });
        }),
        waitForNodeOutcome: vi.fn(() => remoteOutcome.promise),
      },
    });
    h.runner.start();
    await flush();
    expect(h.calls).toEqual(["node env-server 0.1.36"]);
    expect(h.io.installThisApp).not.toHaveBeenCalled();

    remoteOutcome.resolve({ outcome: "succeeded", message: null });
    await flush();
    expect(h.calls).toEqual(["node env-server 0.1.36", "this app"]);
    expect(h.runner.getSnapshot().result).toMatchObject({ updatedNodes: 2 });
  });

  it("reports this app's failed install in the notice", async () => {
    const h = harness({
      environments: [environment(LOCAL, "This Mac", { hostedByThisApp: true, providers: [] })],
      localApp: {
        enabled: true,
        status: "available",
        currentVersion: "0.1.35",
        availableVersion: "0.1.36",
        downloadedVersion: null,
        downloadPercent: null,
      },
      io: { installThisApp: vi.fn(async () => false) },
    });
    h.runner.start();
    await flush();
    expect(h.shown).toEqual([
      {
        type: "error",
        title: "An update failed",
        description: "This Mac · Ryco: Couldn't install the app update.",
      },
    ]);
  });

  it("keeps the finished run until it is dismissed, never while one runs", async () => {
    const answer = deferred<ServerProviderUpdatedPayload>();
    const h = harness({
      environments: [environment(SERVER, "Server")],
      io: { updateProvider: vi.fn(() => answer.promise) },
    });
    h.runner.start();
    h.runner.dismissRun();
    expect(h.runner.getSnapshot().running).toBe(true);
    expect(h.runner.getSnapshot().run).not.toBeNull();

    answer.resolve(providerAnswer("codex"));
    await flush();
    expect(h.runner.getSnapshot().result).not.toBeNull();
    h.runner.dismissRun();
    expect(h.runner.getSnapshot()).toEqual({
      run: null,
      result: null,
      running: false,
      checking: false,
    });
  });

  it("checks once at a time, flagging the check while it runs and swallowing its failure", async () => {
    const check = deferred<void>();
    const checkAll = vi.fn(() => check.promise.then(() => Promise.reject(new Error("offline"))));
    const h = harness({ environments: [], checkAll });

    const first = h.runner.checkAll();
    const second = h.runner.checkAll();
    expect(second).toBe(first);
    expect(h.runner.getSnapshot().checking).toBe(true);
    await flush();
    expect(checkAll).toHaveBeenCalledTimes(1);

    check.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(h.runner.getSnapshot().checking).toBe(false);

    await h.runner.checkAll();
    expect(checkAll).toHaveBeenCalledTimes(2);
  });
});
