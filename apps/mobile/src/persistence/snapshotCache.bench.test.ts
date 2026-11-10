import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

import { useStore } from "../state/threadsRuntime";
import { createSnapshotPersistenceRuntime } from "./environmentSnapshotPersistence";
import { createTestSnapshotDb } from "./snapshotDb.testSupport";

/**
 * Not a regression test: the numbers for the snapshot cache layout (launch read,
 * bytes written while an agent streams). Run with RYCO_SNAPSHOT_BENCH=1.
 */
const MACHINES = 8;
const THREADS = 2_000;
const CONTENT_THREADS = 32;
const CONTENT_TEXT = 60_000;

function shellThread(id: string, updatedAt = "2026-08-20T00:00:00.000Z") {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id} with a title of a typical length`,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/some-branch",
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function shellSnapshot(machine: number): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: "project-1",
        title: `Project ${machine}`,
        workspaceRoot: `/p${machine}`,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        scripts: [],
      },
    ],
    worktrees: [],
    threads: Array.from({ length: THREADS }, (_, index) =>
      shellThread(`t${index}`, new Date(Date.UTC(2026, 7, 1) + index * 60_000).toISOString()),
    ),
    updatedAt: "2026-08-20T00:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

function detail(id: string, text: string, updatedAt: string): OrchestrationThread {
  return {
    ...shellThread(id, updatedAt),
    deletedAt: null,
    messages: [
      {
        id: `${id}-m0`,
        role: "user",
        text: "Please do the thing.",
        turnId: null,
        streaming: false,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      {
        id: `${id}-m1`,
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: "2026-08-20T00:00:01.000Z",
        updatedAt: "2026-08-20T00:00:01.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  } as unknown as OrchestrationThread;
}

const machineId = (machine: number) => `bench-machine-${machine}` as EnvironmentId;

function goLive(machine: number) {
  const environmentId = machineId(machine);
  const store = useStore.getState();
  store.syncServerShellSnapshot(shellSnapshot(machine), environmentId);
  for (let index = 0; index < CONTENT_THREADS; index += 1) {
    const threadId = `t${THREADS - 1 - index}`;
    store.syncServerThreadDetail(
      detail(
        threadId,
        "x".repeat(CONTENT_TEXT),
        new Date(Date.UTC(2026, 7, 1) + (THREADS - 1 - index) * 60_000).toISOString(),
      ),
      environmentId,
    );
  }
}

describe.skipIf(!process.env.RYCO_SNAPSHOT_BENCH)("snapshot cache numbers", () => {
  it("launch read and streaming writes", { timeout: 600_000 }, async () => {
    const { db, counters } = await createTestSnapshotDb();
    const content = { isEnabled: () => true };
    const writer = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => Date.now(),
      hasDirectEnvironment: () => true,
      contentCache: content,
    });
    for (let machine = 0; machine < MACHINES; machine += 1) {
      goLive(machine);
      await writer.capture(machineId(machine));
    }
    writer.dispose();
    const seedWritten = counters.written;
    for (let machine = 0; machine < MACHINES; machine += 1) {
      useStore.getState().removeEnvironmentState(machineId(machine));
    }

    // Launch: a fresh runtime reads the cache back into an empty store.
    counters.read = 0;
    const reader = createSnapshotPersistenceRuntime({
      db,
      store: useStore,
      now: () => Date.now(),
      hasDirectEnvironment: () => true,
      contentCache: content,
      yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve)),
    });
    let firstCommitAt: number | null = null;
    const started = performance.now();
    const stop = useStore.subscribe(() => {
      if (firstCommitAt === null) firstCommitAt = performance.now() - started;
    });
    await reader.hydrate();
    const allHydratedAt = performance.now() - started;
    stop();
    const launchRead = counters.read;
    const hydrated = Object.keys(useStore.getState().environmentStateById).filter((id) =>
      id.startsWith("bench-machine-"),
    ).length;
    reader.dispose();

    // Opening a thread of a machine shown from the cache reads its saved body.
    let openMs = -1;
    {
      const opener = createSnapshotPersistenceRuntime({
        db,
        store: useStore,
        now: () => Date.now(),
        hasDirectEnvironment: () => true,
        contentCache: content,
      });
      for (let machine = 0; machine < MACHINES; machine += 1) {
        useStore.getState().removeEnvironmentState(machineId(machine));
      }
      await opener.hydrate();
      const openedAt = performance.now();
      await opener.loadThreadBody(machineId(3), `t${THREADS - 1}` as never);
      openMs = performance.now() - openedAt;
      opener.dispose();
    }

    // Streaming: one thread of machine 0 is updated 4 times a second for a
    // minute, its text growing by 200 characters a second.
    const stream = async (windows: { busyDebounceMs?: number; busyMaxWaitMs?: number }) => {
      vi.useFakeTimers();
      let captures = 0;
      const streaming = createSnapshotPersistenceRuntime({
        db: {
          ...db,
          writeEnvironmentRows: (input) => {
            captures += 1;
            return db.writeEnvironmentRows(input);
          },
        },
        store: useStore,
        now: () => Date.now(),
        hasDirectEnvironment: () => true,
        contentCache: content,
        ...windows,
      });
      for (let machine = 0; machine < MACHINES; machine += 1) {
        useStore.getState().removeEnvironmentState(machineId(machine));
      }
      goLive(0);
      await streaming.capture(machineId(0));
      await vi.advanceTimersByTimeAsync(120_000);
      counters.written = 0;
      captures = 0;
      const environmentId = machineId(0);
      const threadId = `t${THREADS - 1}`;
      let text = "x".repeat(CONTENT_TEXT);
      let sequence = 10;
      for (let tick = 0; tick < 240; tick += 1) {
        const at = new Date(Date.UTC(2026, 7, 21) + tick * 250).toISOString();
        if (tick % 4 === 0) {
          text += "y".repeat(200);
          useStore.getState().syncServerThreadDetail(detail(threadId, text, at), environmentId);
        } else {
          useStore.getState().applyShellEvents(
            [
              {
                kind: "thread-upserted",
                sequence: sequence++,
                thread: shellThread(threadId, at),
              },
            ] as never,
            environmentId,
          );
        }
        streaming.markDirty(environmentId);
        await vi.advanceTimersByTimeAsync(250);
      }
      const written = counters.written;
      const capturesPerMinute = captures;
      streaming.dispose();
      vi.useRealTimers();

      // The JS time of one capture of the streaming machine, as the timers run it.
      const timing = createSnapshotPersistenceRuntime({
        db,
        store: useStore,
        now: () => Date.now(),
        hasDirectEnvironment: () => true,
        contentCache: content,
      });
      await timing.capture(environmentId);
      const samples: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        text += "z".repeat(200);
        useStore
          .getState()
          .syncServerThreadDetail(detail(threadId, text, new Date().toISOString()), environmentId);
        const at = performance.now();
        await timing.capture(environmentId);
        samples.push(performance.now() - at);
      }
      timing.dispose();
      samples.sort((left, right) => left - right);
      return {
        bytesWrittenPerMinute: written,
        capturesPerMinute,
        medianCaptureMs: Number(samples[5]!.toFixed(2)),
      };
    };
    const busyWindow = await stream({});
    const plainWindow = await stream({ busyDebounceMs: 2_000, busyMaxWaitMs: 10_000 });
    const streamWritten = busyWindow.bytesWrittenPerMinute;

    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.env.RYCO_SNAPSHOT_BENCH_OUT ?? "/dev/stdout",
      JSON.stringify(
        {
          seedWrittenBytes: seedWritten,
          launch: {
            machinesHydrated: hydrated,
            bytesRead: launchRead,
            firstCommitMs: Math.round(firstCommitAt ?? -1),
            allHydratedMs: Math.round(allHydratedAt),
          },
          openThreadMs: Number(openMs.toFixed(2)),
          streamingBytesWrittenPerMinute: streamWritten,
          streamingBusyWindow: busyWindow,
          streamingPlainWindow: plainWindow,
        },
        null,
        2,
      ),
    );
    expect(hydrated).toBe(MACHINES);
  });
});
