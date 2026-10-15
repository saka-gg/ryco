import {
  EnvironmentId,
  type OrchestrationShellStreamItem,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { KnownEnvironment } from "../knownEnvironment.ts";
import type { ShellSubscriptionOptions, WsRpcClient } from "../rpc/index.ts";
import { startServerStateSync } from "../rpc/serverState.ts";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../rpc/wsConnectionState.ts";
import {
  createEnvironmentConnection,
  type ConnectionLifecycleGeneration,
  type EnvironmentConfigUpdate,
} from "./connection.ts";

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

describe("live config", () => {
  const liveEnvironmentId = EnvironmentId.make("env-live-config");

  function liveConfig(label: string, settings: object = {}): ServerConfig {
    return {
      environment: { environmentId: liveEnvironmentId, label, capabilities: {} },
      providers: [],
      issues: [],
      keybindings: [],
      settings,
    } as unknown as ServerConfig;
  }

  /** A socket attempt for the environment that is now open. */
  function openSocketAttempt() {
    recordWsConnectionAttempt("ws://node.test/ws", {
      environmentId: liveEnvironmentId,
      recordGlobal: false,
    });
    recordWsConnectionOpened({ environmentId: liveEnvironmentId, recordGlobal: false });
  }

  function configHarness() {
    const subscriptions: Array<{
      readonly listener: (event: ServerConfigStreamEvent) => void;
      readonly onResubscribe: (() => void) | undefined;
      closed: boolean;
    }> = [];
    const subscribeConfig = vi.fn(
      (
        listener: (event: ServerConfigStreamEvent) => void,
        options?: { readonly onResubscribe?: () => void },
      ) => {
        const subscription = { listener, onResubscribe: options?.onResubscribe, closed: false };
        subscriptions.push(subscription);
        return () => {
          subscription.closed = true;
        };
      },
    );
    const client = {
      server: { subscribeLifecycle: () => () => undefined, subscribeConfig },
      orchestration: { subscribeShell: () => () => undefined },
      terminal: { onEvent: () => () => undefined },
      dispose: async () => undefined,
      reconnect: async () => undefined,
    } as unknown as WsRpcClient;
    const open = () => subscriptions.filter((subscription) => !subscription.closed);
    return {
      client,
      subscribeConfig,
      openStreams: () => open().length,
      emit: (event: ServerConfigStreamEvent) => {
        for (const subscription of open()) subscription.listener(event);
      },
      resubscribe: () => {
        for (const subscription of open()) subscription.onResubscribe?.();
      },
    };
  }

  function liveConnection(
    harness: ReturnType<typeof configHarness>,
    options: {
      readonly kind?: "primary" | "saved";
      readonly lifecycleGeneration?: ConnectionLifecycleGeneration;
      readonly onConfigUpdated?: (config: ServerConfig) => void;
    } = {},
  ) {
    return createEnvironmentConnection({
      kind: options.kind ?? "primary",
      knownEnvironment: {
        environmentId: liveEnvironmentId,
        label: "Hosted node",
      } as unknown as KnownEnvironment,
      client: harness.client,
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
      ...(options.lifecycleGeneration ? { lifecycleGeneration: options.lifecycleGeneration } : {}),
      ...(options.onConfigUpdated ? { onConfigUpdated: options.onConfigUpdated } : {}),
    });
  }

  const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent =>
    ({ version: 1, type: "snapshot", config }) as ServerConfigStreamEvent;
  const settingsEvent = (settings: object): ServerConfigStreamEvent =>
    ({ version: 1, type: "settingsUpdated", payload: { settings } }) as ServerConfigStreamEvent;

  beforeEach(() => {
    resetWsConnectionStateForTests();
    openSocketAttempt();
  });

  afterEach(() => {
    resetWsConnectionStateForTests();
  });

  it("reads nothing before the first snapshot, then the snapshot of the current attempt", () => {
    const harness = configHarness();
    const connection = liveConnection(harness, { kind: "saved" });
    expect(connection.config.read()).toBeNull();

    harness.emit(snapshotEvent(liveConfig("first")));
    expect(connection.config.read()?.environment.label).toBe("first");

    harness.emit(settingsEvent({ marker: "updated" }));
    expect(connection.config.read()?.settings).toEqual({ marker: "updated" });
  });

  it("reads nothing after a resubscribe until the replacement snapshot arrives", () => {
    const harness = configHarness();
    const connection = liveConnection(harness, { kind: "saved" });
    harness.emit(snapshotEvent(liveConfig("first")));

    harness.resubscribe();
    expect(connection.config.read()).toBeNull();
    harness.emit(snapshotEvent(liveConfig("second")));
    expect(connection.config.read()?.environment.label).toBe("second");
  });

  it("reads nothing while disconnected or on a later socket attempt", () => {
    const harness = configHarness();
    const connection = liveConnection(harness, { kind: "saved" });
    harness.emit(snapshotEvent(liveConfig("first")));

    recordWsConnectionClosed(
      { code: 1006 },
      { environmentId: liveEnvironmentId, recordGlobal: false },
    );
    expect(connection.config.read()).toBeNull();
    // The replacement socket is open, but its own snapshot has not arrived.
    openSocketAttempt();
    expect(connection.config.read()).toBeNull();
    harness.emit(snapshotEvent(liveConfig("after reconnect")));
    expect(connection.config.read()?.environment.label).toBe("after reconnect");
  });

  it("reads nothing once a reconnect begins, and nothing after dispose", async () => {
    const harness = configHarness();
    const connection = liveConnection(harness, { kind: "saved" });
    harness.emit(snapshotEvent(liveConfig("first")));

    void connection.reconnect().catch(() => undefined);
    expect(connection.config.read()).toBeNull();
    harness.emit(snapshotEvent(liveConfig("replacement")));
    expect(connection.config.read()?.environment.label).toBe("replacement");

    await connection.dispose();
    expect(connection.config.read()).toBeNull();
    expect(harness.openStreams()).toBe(0);
  });

  it("never applies or publishes an increment without a snapshot of the current attempt", () => {
    const harness = configHarness();
    const onConfigUpdated = vi.fn();
    const connection = liveConnection(harness, { kind: "saved", onConfigUpdated });
    const observed = vi.fn();
    connection.config.subscribe(observed);

    harness.emit(settingsEvent({ marker: "orphan" }));
    expect(observed).not.toHaveBeenCalled();
    expect(onConfigUpdated).not.toHaveBeenCalled();

    harness.emit(snapshotEvent(liveConfig("first")));
    expect(observed).toHaveBeenCalledOnce();
    // A later socket attempt without its own snapshot yet: the old snapshot is
    // no base for increments.
    openSocketAttempt();
    harness.emit(settingsEvent({ marker: "stale base" }));
    expect(observed).toHaveBeenCalledOnce();
    expect(onConfigUpdated).toHaveBeenCalledOnce();
  });

  it("publishes and reads nothing for a stale hosted generation", () => {
    const harness = configHarness();
    let generation = 4;
    const onConfigUpdated = vi.fn();
    const connection = liveConnection(harness, {
      onConfigUpdated,
      lifecycleGeneration: { generation: 4, readCurrent: () => generation },
    });
    const observed = vi.fn();
    connection.config.subscribe(observed);
    harness.emit(snapshotEvent(liveConfig("node A")));
    expect(connection.config.read()?.environment.label).toBe("node A");

    // A node switch, sign-out or deactivation advances the owner's generation
    // before this connection is torn down.
    generation = 5;
    expect(connection.config.read()).toBeNull();
    harness.emit(snapshotEvent(liveConfig("late node A snapshot")));
    harness.emit(settingsEvent({ marker: "late" }));
    expect(observed).toHaveBeenCalledOnce();
    expect(onConfigUpdated).toHaveBeenCalledOnce();
    expect(connection.config.read()).toBeNull();
  });

  it("delivers the config with Hub-relay descriptors normalized and the event as sent", () => {
    const harness = configHarness();
    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        environmentId: liveEnvironmentId,
        label: "Hub label",
        source: "hub-hosted",
      } as unknown as KnownEnvironment,
      client: harness.client,
      pushSequenceMonitor: { recordEvent: () => undefined, recordSnapshot: () => undefined },
      resetShellProjection: () => undefined,
      applyShellEvent: () => undefined,
      syncShellSnapshot: () => undefined,
      applyTerminalEvent: () => undefined,
    });
    const observed = vi.fn();
    connection.config.subscribe(observed);
    const inner = {
      ...liveConfig("Inner label"),
      environment: { environmentId: "node-local-uuid", label: "Inner label", capabilities: {} },
    } as unknown as ServerConfig;
    harness.emit(snapshotEvent(inner));

    const update = observed.mock.calls[0]?.[0] as EnvironmentConfigUpdate;
    expect(update.config.environment).toMatchObject({
      environmentId: liveEnvironmentId,
      label: "Hub label",
    });
    expect(update.event).toEqual(snapshotEvent(inner));
  });

  it("opens one config stream per connection, shared by every observer", () => {
    // A saved connection holds its stream for life; the server-state sync
    // rides on it instead of opening another.
    const saved = configHarness();
    const savedConnection = liveConnection(saved, { kind: "saved" });
    const stopSaved = startServerStateSync(savedConnection);
    expect(saved.subscribeConfig).toHaveBeenCalledOnce();
    stopSaved();
    expect(saved.openStreams()).toBe(1);

    // A primary connection without a config handler opens its stream for the
    // first observer and closes it with the last.
    const primary = configHarness();
    const primaryConnection = liveConnection(primary);
    expect(primary.subscribeConfig).not.toHaveBeenCalled();
    const stopEarly = startServerStateSync(primaryConnection);
    const stopShell = startServerStateSync(primaryConnection);
    const unsubscribeReader = primaryConnection.config.subscribe(() => undefined);
    expect(primary.subscribeConfig).toHaveBeenCalledOnce();
    stopEarly();
    unsubscribeReader();
    expect(primary.openStreams()).toBe(1);
    stopShell();
    expect(primary.openStreams()).toBe(0);
    expect(primaryConnection.config.read()).toBeNull();
  });
});
