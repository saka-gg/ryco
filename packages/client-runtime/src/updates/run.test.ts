import {
  EnvironmentId,
  type NodeUpdateInput,
  type NodeUpdateState,
  type ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  nodeUpdateState,
  updatableProvider,
  updateEverythingEnvironment as environment,
} from "../../test/nodeUpdateFixtures.ts";
import type { NodeUpdateOutcomeResult } from "../state/nodeUpdate/store.ts";
import { buildUpdateEverythingPlan, type UpdateEverythingEnvironmentInput } from "./plan.ts";
import {
  runUpdateEverything,
  type UpdateEverythingIo,
  type UpdateEverythingRunState,
} from "./run.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function providerAnswer(
  instanceId: string,
  status: "succeeded" | "unchanged" | "failed",
  message: string | null = null,
): ServerProviderUpdatedPayload {
  return {
    providers: [
      {
        ...updatableProvider(instanceId),
        updateState: { status, startedAt: null, finishedAt: null, message, output: null },
      },
    ],
  };
}

function fakeIo(overrides: Partial<UpdateEverythingIo> = {}) {
  const calls: string[] = [];
  let requests = 0;
  const updateProvider = vi.fn<UpdateEverythingIo["updateProvider"]>(
    async (environmentId, input) => {
      calls.push(`provider ${environmentId} ${input.instanceId}`);
      return providerAnswer(input.instanceId, "succeeded");
    },
  );
  const updateNode = vi.fn<UpdateEverythingIo["updateNode"]>(
    async (environmentId, input: NodeUpdateInput) => {
      calls.push(`node ${environmentId}`);
      return nodeUpdateState({
        run: {
          status: "preparing",
          requestId: input.requestId,
          targetVersion: input.targetVersion,
        },
      });
    },
  );
  const waitForNodeOutcome = vi.fn<UpdateEverythingIo["waitForNodeOutcome"]>(
    async (environmentId): Promise<NodeUpdateOutcomeResult> => {
      calls.push(`wait ${environmentId}`);
      return { outcome: "succeeded", message: null };
    },
  );
  const installThisApp = vi.fn<UpdateEverythingIo["installThisApp"]>(async () => {
    calls.push("this-app");
    return true;
  });
  const io: UpdateEverythingIo = {
    updateProvider,
    updateNode,
    waitForNodeOutcome,
    isStillAllowed: () => true,
    installThisApp,
    newRequestId: () => `req-${++requests}`,
    now: () => 1_000,
    ...overrides,
  };
  return { io, calls, updateProvider, updateNode, waitForNodeOutcome, installThisApp };
}

function plan(environments: ReadonlyArray<UpdateEverythingEnvironmentInput>, withApp = false) {
  return buildUpdateEverythingPlan({
    environments,
    localApp: withApp
      ? {
          enabled: true,
          status: "downloaded",
          currentVersion: "0.1.35",
          availableVersion: "0.1.36",
          downloadedVersion: "0.1.36",
          downloadPercent: null,
        }
      : null,
  });
}

function recorder() {
  const states: UpdateEverythingRunState[] = [];
  return {
    states,
    onProgress: (state: UpdateEverythingRunState) => states.push(state),
    device: (label: string) => states.at(-1)!.devices.find((device) => device.label === label)!,
    statuses: (label: string) =>
      states
        .map((state) => state.devices.find((device) => device.label === label)!.status)
        .filter((status, index, all) => index === 0 || all[index - 1] !== status),
  };
}

const MINE = environment("Mine", {
  hostedByThisApp: true,
  providers: [updatableProvider("codex")],
  nodeUpdate: nodeUpdateState({ installation: { kind: "desktop-app", service: null } }),
});
const SERVER = environment("Server", { providers: [updatableProvider("claudeAgent")] });
const LAPTOP = environment("Laptop", {
  nodeUpdate: nodeUpdateState({ installation: { kind: "desktop-app", service: null } }),
});

describe("runUpdateEverything", () => {
  it("updates providers first, then remote nodes in parallel, then this app last", async () => {
    const fake = fakeIo();
    const progress = recorder();
    fake.installThisApp.mockImplementation(async () => {
      fake.calls.push("this-app");
      // The relaunch may end the run: progress already said so.
      expect(progress.states.at(-1)?.phase).toBe("this-app");
      expect(progress.device("Mine").status).toBe("updating");
      return true;
    });
    const result = await runUpdateEverything(plan([SERVER, LAPTOP, MINE], true), fake.io, {
      onProgress: progress.onProgress,
    });

    expect(fake.calls).toEqual([
      "provider env-mine codex",
      "provider env-server claudeAgent",
      "node env-laptop",
      "node env-server",
      "wait env-laptop",
      "wait env-server",
      "this-app",
    ]);
    expect(fake.updateNode.mock.calls.map(([, input]) => input)).toEqual([
      { targetVersion: "0.1.36", requestId: "req-1" },
      { targetVersion: "0.1.36", requestId: "req-2" },
    ]);
    expect(fake.waitForNodeOutcome.mock.calls.map(([, input]) => input.requestId)).toEqual([
      "req-1",
      "req-2",
    ]);
    expect(result).toEqual({
      updatedNodes: 3,
      updatedProviders: 2,
      failures: [],
      postponed: [],
      unknown: [],
      skipped: [],
    });
    expect([...new Set(progress.states.map((state) => state.phase))]).toEqual([
      "providers",
      "nodes",
      "this-app",
      "finished",
    ]);
    expect(progress.states.every((state) => state.startedAt === 1_000)).toBe(true);
    expect(progress.statuses("Server")).toEqual([
      "queued",
      "providers",
      "queued",
      "updating",
      "done",
    ]);
    expect(progress.statuses("Mine")).toEqual([
      "queued",
      "providers",
      "queued",
      "updating",
      "done",
    ]);
    expect(progress.device("Laptop").message).toBe("Updated Ryco to 0.1.36.");
    expect(Object.isFrozen(progress.states.at(-1)!.devices)).toBe(true);
  });

  it("bounds provider concurrency across devices", async () => {
    const environments = ["A", "B", "C"].map((label) =>
      environment(label, {
        nodeUpdate: nodeUpdateState({ availability: "current" }),
        providers: [updatableProvider("codex"), updatableProvider("claudeAgent")],
      }),
    );
    const pending: Array<ReturnType<typeof deferred<ServerProviderUpdatedPayload>>> = [];
    let inFlight = 0;
    let peak = 0;
    const fake = fakeIo({
      updateProvider: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const answer = deferred<ServerProviderUpdatedPayload>();
        pending.push(answer);
        try {
          return await answer.promise;
        } finally {
          inFlight -= 1;
        }
      },
    });
    const run = runUpdateEverything(plan(environments), fake.io, {
      onProgress: () => undefined,
      providerConcurrency: 2,
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    for (let index = 0; index < 6; index += 1) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
      pending[index]!.resolve(
        providerAnswer(index % 2 === 0 ? "codex" : "claudeAgent", "succeeded"),
      );
    }
    const result = await run;
    expect(peak).toBe(2);
    expect(result.updatedProviders).toBe(6);
    expect(result.updatedNodes).toBe(0);
  });

  it("re-checks isStillAllowed before every dispatch and skips devices that lost it", async () => {
    let serverAllowed = true;
    const fake = fakeIo({
      isStillAllowed: (environmentId) =>
        environmentId !== EnvironmentId.make("env-server") || serverAllowed,
    });
    fake.updateProvider.mockImplementation(async (environmentId, input) => {
      fake.calls.push(`provider ${environmentId} ${input.instanceId}`);
      // The server's connection drops after the first plan step anywhere.
      serverAllowed = false;
      return providerAnswer(input.instanceId, "succeeded");
    });
    const progress = recorder();
    const server = environment("Server", {
      providers: [updatableProvider("claudeAgent"), updatableProvider("codex")],
    });
    const result = await runUpdateEverything(plan([server, LAPTOP]), fake.io, {
      onProgress: progress.onProgress,
      providerConcurrency: 1,
    });
    expect(fake.calls).toEqual([
      "provider env-server claudeAgent",
      "node env-laptop",
      "wait env-laptop",
    ]);
    expect(result.updatedProviders).toBe(1);
    expect(result.updatedNodes).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(progress.device("Server").status).toBe("skipped");
  });

  it("stops dispatching on abort without cancelling what is in flight", async () => {
    const abort = new AbortController();
    const answer = deferred<ServerProviderUpdatedPayload>();
    const fake = fakeIo();
    fake.updateProvider.mockImplementationOnce(async (environmentId, input) => {
      fake.calls.push(`provider ${environmentId} ${input.instanceId}`);
      return answer.promise;
    });
    const progress = recorder();
    const run = runUpdateEverything(plan([SERVER, LAPTOP, MINE], true), fake.io, {
      onProgress: progress.onProgress,
      signal: abort.signal,
      providerConcurrency: 1,
    });
    await vi.waitFor(() => expect(fake.updateProvider).toHaveBeenCalledOnce());
    abort.abort();
    answer.resolve(providerAnswer("codex", "succeeded"));
    const result = await run;

    expect(fake.calls).toEqual(["provider env-mine codex"]);
    expect(fake.updateNode).not.toHaveBeenCalled();
    expect(fake.installThisApp).not.toHaveBeenCalled();
    expect(result.updatedProviders).toBe(1);
    expect(result.skipped).toHaveLength(4);
    expect(progress.device("Laptop").status).toBe("skipped");
    expect(progress.device("Mine").status).toBe("skipped");
    expect(progress.states.at(-1)?.phase).toBe("finished");
  });

  it("reports a lost provider answer as unknown and never retries it", async () => {
    const fake = fakeIo();
    fake.updateProvider.mockRejectedValue(new Error("SocketCloseError: connection lost"));
    const progress = recorder();
    const result = await runUpdateEverything(
      plan([
        environment("Server", {
          nodeUpdate: nodeUpdateState({ availability: "current" }),
          providers: [updatableProvider("claudeAgent")],
        }),
      ]),
      fake.io,
      { onProgress: progress.onProgress },
    );
    expect(fake.updateProvider).toHaveBeenCalledOnce();
    expect(result.unknown).toEqual([
      "Server · Claude: The update's answer was lost. Check the provider before retrying.",
    ]);
    expect(progress.device("Server").status).toBe("unknown");
  });

  it("combines provider failures with the node outcome", async () => {
    const fake = fakeIo();
    fake.updateProvider.mockResolvedValue(providerAnswer("claudeAgent", "failed", "npm exited 1"));
    const progress = recorder();
    const result = await runUpdateEverything(plan([SERVER]), fake.io, {
      onProgress: progress.onProgress,
    });
    expect(result.failures).toEqual(["Server · Claude: npm exited 1"]);
    expect(result.updatedNodes).toBe(1);
    expect(progress.device("Server")).toMatchObject({
      status: "failed",
      message: "Updated Ryco to 0.1.36. 1 provider update failed.",
      providerFailures: ["Claude: npm exited 1"],
    });
  });

  it("keeps a postponed restart apart from failures", async () => {
    const fake = fakeIo();
    fake.waitForNodeOutcome.mockResolvedValue({
      outcome: "postponed",
      message: "Postponed by someone at Laptop.",
    });
    const progress = recorder();
    const result = await runUpdateEverything(plan([LAPTOP]), fake.io, {
      onProgress: progress.onProgress,
    });
    expect(result).toMatchObject({ updatedNodes: 0, failures: [], postponed: ["Laptop"] });
    expect(progress.device("Laptop")).toMatchObject({
      status: "postponed",
      message: "Postponed by someone at Laptop.",
    });
  });

  it("waits for the node's report after a lost answer, but not after a refusal", async () => {
    const fake = fakeIo();
    fake.updateNode
      .mockRejectedValueOnce(new Error("SocketCloseError: the node went away"))
      .mockRejectedValueOnce({ _tag: "NodeUpdateError", reason: "0.1.37 is the latest now." });
    fake.waitForNodeOutcome.mockResolvedValueOnce({
      outcome: "unknown",
      message: "The node did not report back in time.",
    });
    const result = await runUpdateEverything(plan([LAPTOP, SERVER]), fake.io, {
      onProgress: () => undefined,
    });
    expect(fake.waitForNodeOutcome).toHaveBeenCalledOnce();
    expect(fake.waitForNodeOutcome.mock.calls[0]?.[0]).toBe("env-laptop");
    expect(result.unknown).toEqual(["Laptop · Ryco: The node did not report back in time."]);
    expect(result.failures).toEqual(["Server · Ryco: 0.1.37 is the latest now."]);
  });

  it("takes a failure the node reports in its answer without waiting", async () => {
    const fake = fakeIo();
    fake.updateNode.mockImplementation(async (_environmentId, input) =>
      nodeUpdateState({
        run: { status: "failed", requestId: input.requestId, message: "Disk full." },
      }),
    );
    const result = await runUpdateEverything(plan([LAPTOP]), fake.io, {
      onProgress: () => undefined,
    });
    expect(fake.waitForNodeOutcome).not.toHaveBeenCalled();
    expect(result.failures).toEqual(["Laptop · Ryco: Disk full."]);
  });

  it("follows the node's run while waiting (countdown, restart)", async () => {
    let state: NodeUpdateState | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: NodeUpdateState) => {
      state = next;
      for (const listener of listeners) listener();
    };
    const outcome = deferred<NodeUpdateOutcomeResult>();
    const fake = fakeIo({
      nodeUpdates: {
        read: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    fake.waitForNodeOutcome.mockReturnValue(outcome.promise);
    const progress = recorder();
    const run = runUpdateEverything(plan([LAPTOP]), fake.io, { onProgress: progress.onProgress });
    await vi.waitFor(() => expect(fake.waitForNodeOutcome).toHaveBeenCalledOnce());
    publish(
      nodeUpdateState({ run: { status: "preparing", requestId: "req-1", progressPercent: 42.4 } }),
    );
    expect(progress.device("Laptop").message).toBe("Downloading Ryco 0.1.36… 42%");
    publish(nodeUpdateState({ run: { status: "waiting", requestId: "req-1" } }));
    // Another request's run says nothing about this one.
    publish(nodeUpdateState({ run: { status: "restarting", requestId: "someone-else" } }));
    expect(progress.device("Laptop").status).toBe("waiting");
    publish(nodeUpdateState({ run: { status: "restarting", requestId: "req-1" } }));
    outcome.resolve({ outcome: "succeeded", message: null });
    await run;
    expect(progress.statuses("Laptop")).toEqual([
      "queued",
      "updating",
      "waiting",
      "restarting",
      "done",
    ]);
    expect(listeners.size).toBe(0);
  });

  it("reports a failed install of this app", async () => {
    for (const install of [async () => false, async () => Promise.reject(new Error("IPC gone"))]) {
      const fake = fakeIo({ installThisApp: install });
      const progress = recorder();
      const result = await runUpdateEverything(
        plan([environment("Mine", { ...MINE, providers: [] })], true),
        fake.io,
        { onProgress: progress.onProgress },
      );
      expect(result.failures).toEqual(["Mine · Ryco: Couldn't install the app update."]);
      expect(progress.device("Mine").status).toBe("failed");
    }
  });

  it("marks devices without one-click work as skipped from the start", async () => {
    const fake = fakeIo();
    const progress = recorder();
    const result = await runUpdateEverything(
      plan([
        environment("Current", { nodeUpdate: nodeUpdateState({ availability: "current" }) }),
        environment("Offline", { connected: false }),
        environment("Manual", { nodeUpdate: nodeUpdateState({ canUpdate: false }) }),
      ]),
      fake.io,
      { onProgress: progress.onProgress },
    );
    expect(
      progress.states[0]!.devices.map((device) => [device.label, device.status, device.message]),
    ).toEqual([
      ["Current", "skipped", "Up to date."],
      ["Manual", "skipped", "Needs a manual update."],
      ["Offline", "skipped", "Not connected right now."],
    ]);
    expect(result).toMatchObject({ updatedNodes: 0, updatedProviders: 0, skipped: [] });
  });

  it("rejects an out-of-range concurrency", async () => {
    await expect(
      runUpdateEverything(plan([]), fakeIo().io, {
        onProgress: () => undefined,
        providerConcurrency: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});
