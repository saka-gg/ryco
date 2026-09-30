import { EnvironmentId, type OrchestrationShellStreamItem } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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

  it("resets immediately when resume is not offered", async () => {
    const harness = shellHarness();
    const { connection, calls } = connect(harness, null);
    harness.emit(snapshot(40));
    await connection.ensureBootstrapped();

    expect(harness.resubscribe()).toBeNull();
    expect(calls).toEqual(["snapshot:40", "reset"]);
  });
});
