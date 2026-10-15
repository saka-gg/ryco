import { EnvironmentId, type OrchestrationShellStreamItem } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { KnownEnvironment } from "../knownEnvironment.ts";
import type { ShellSubscriptionOptions, WsRpcClient } from "../rpc/index.ts";
import { createEnvironmentConnection } from "./connection.ts";

const environmentId = EnvironmentId.make("env-resume");

function shellHarness() {
  let listener: ((item: OrchestrationShellStreamItem) => void) | undefined;
  let options: ShellSubscriptionOptions | undefined;
  const client = {
    orchestration: {
      subscribeShell: (
        next: (item: OrchestrationShellStreamItem) => void,
        nextOptions?: ShellSubscriptionOptions,
      ) => {
        listener = next;
        options = nextOptions;
        return () => undefined;
      },
    },
    terminal: { onEvent: () => () => undefined },
    dispose: async () => undefined,
    reconnect: async () => undefined,
  } as unknown as WsRpcClient;
  return {
    client,
    emit: (item: OrchestrationShellStreamItem) => listener?.(item),
    options: () => options,
    resubscribe: () => {
      const resumeFrom = options?.resumeFromSequence?.() ?? null;
      options?.onResubscribe?.();
      return resumeFrom;
    },
  };
}

const snapshot = (snapshotSequence: number): OrchestrationShellStreamItem => ({
  kind: "snapshot",
  snapshot: { snapshotSequence, projects: [], threads: [], updatedAt: "2026-09-30T00:00:00.000Z" },
});

function connect(
  harness: ReturnType<typeof shellHarness>,
  resume: { readonly sequence: () => number | null } | null,
) {
  const calls: string[] = [];
  const connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: { environmentId, label: "Remote Mac" } as unknown as KnownEnvironment,
    client: harness.client,
    pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
    resetShellProjection: () => calls.push("reset"),
    applyShellEvent: (event) => calls.push(`event:${event.sequence}`),
    syncShellSnapshot: (next) => calls.push(`snapshot:${next.snapshotSequence}`),
    applyTerminalEvent: () => undefined,
    ...(resume === null
      ? {}
      : {
          readShellResumeSequence: () => resume.sequence(),
          onShellResumed: () => calls.push("resumed"),
        }),
  });
  return { connection, calls };
}

describe("shell resume", () => {
  it("keeps the shell it holds when the server resumes after a reconnect", async () => {
    const harness = shellHarness();
    const { connection, calls } = connect(harness, { sequence: () => 42 });
    harness.emit(snapshot(40));
    await connection.ensureBootstrapped();

    expect(harness.resubscribe()).toBe(42);
    harness.emit({ kind: "resumed", fromSequence: 42 });
    harness.emit({ kind: "thread-removed", sequence: 43, threadId: "thread-1" as never });
    await connection.ensureBootstrapped();

    expect(calls).toEqual(["snapshot:40", "resumed", "event:43"]);
  });

  it("resets before a snapshot the server sent instead of resuming", async () => {
    const harness = shellHarness();
    const { connection, calls } = connect(harness, { sequence: () => 42 });
    harness.emit(snapshot(40));
    await connection.ensureBootstrapped();

    harness.resubscribe();
    harness.emit(snapshot(7));

    expect(calls).toEqual(["snapshot:40", "reset", "snapshot:7"]);
  });

  it("never resumes before this connection has its own baseline", () => {
    const harness = shellHarness();
    connect(harness, { sequence: () => 42 });
    expect(harness.resubscribe()).toBeNull();
  });

  it("asks for archived stubs and hands the store the stubs a snapshot carries", async () => {
    const harness = shellHarness();
    const synced: unknown[] = [];
    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: { environmentId, label: "Remote Mac" } as unknown as KnownEnvironment,
      client: harness.client,
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: (next) => synced.push(next),
      applyTerminalEvent: () => undefined,
    });
    expect(harness.options()?.archivedThreads).toBe("stub");
    const stubs = [{ id: "archived-1" }] as never;
    harness.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 5,
        projects: [],
        threads: [],
        archivedThreadStubs: stubs,
        updatedAt: "2026-09-30T00:00:00.000Z",
      },
    } as unknown as OrchestrationShellStreamItem);
    await connection.ensureBootstrapped();
    expect(synced).toEqual([expect.objectContaining({ archivedThreadStubs: stubs })]);
  });

  it("resets immediately when resume is not offered", async () => {
    const harness = shellHarness();
    const { connection, calls } = connect(harness, null);
    harness.emit(snapshot(40));
    await connection.ensureBootstrapped();

    expect(harness.resubscribe()).toBeNull();
    expect(calls).toEqual(["snapshot:40", "reset"]);
  });
});

describe("reconnect metadata refresh", () => {
  it("hands refreshMetadata the replacement subscription's config snapshot", async () => {
    let configListener:
      | ((event: { readonly type: "snapshot"; readonly config: unknown }) => void)
      | undefined;
    let shellListener: ((item: OrchestrationShellStreamItem) => void) | undefined;
    const config = (label: string) => ({
      environment: { environmentId, label },
      providers: [],
    });
    const client = {
      server: {
        subscribeLifecycle: () => () => undefined,
        subscribeConfig: (next: typeof configListener) => {
          configListener = next;
          return () => undefined;
        },
      },
      orchestration: {
        subscribeShell: (next: (item: OrchestrationShellStreamItem) => void) => {
          shellListener = next;
          return () => undefined;
        },
      },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => {
        // The replacement subscriptions answer once the new socket is up.
        queueMicrotask(() => {
          configListener?.({ type: "snapshot", config: config("after reconnect") });
          shellListener?.(snapshot(2));
        });
      },
    } as unknown as WsRpcClient;
    const refreshed: string[] = [];
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: { environmentId, label: "Remote Mac" } as unknown as KnownEnvironment,
      client,
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
      refreshMetadata: async ({ configSnapshot }) => {
        const next = (await configSnapshot) as unknown as ReturnType<typeof config>;
        refreshed.push(next.environment.label);
      },
    });
    configListener?.({ type: "snapshot", config: config("initial") });
    shellListener?.(snapshot(1));
    await connection.ensureBootstrapped();

    await connection.reconnect();

    // The snapshot from before the reconnect is not reused.
    expect(refreshed).toEqual(["after reconnect"]);
  });
});

describe("thread priority rankings", () => {
  it("asks for priority deltas only when it can apply them, and routes them past the sequence monitor", () => {
    const withHandler = shellHarness();
    const recorded: number[] = [];
    const priorities: unknown[] = [];
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: { environmentId, label: "Remote Mac" } as unknown as KnownEnvironment,
      client: withHandler.client,
      pushSequenceMonitor: {
        recordEvent: (_environmentId, sequence) => recorded.push(sequence),
        recordSnapshot: () => undefined,
      },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
      applyThreadPriorities: (item) => priorities.push(item),
    });
    expect(withHandler.options()?.threadPriorities).toBe("delta");
    const item = { kind: "thread-priorities", priorities: [] } as const;
    withHandler.emit(item);
    expect(priorities).toEqual([item]);
    expect(recorded).toEqual([]);

    const withoutHandler = shellHarness();
    connect(withoutHandler, null);
    expect(withoutHandler.options()?.threadPriorities).toBeUndefined();
  });
});
