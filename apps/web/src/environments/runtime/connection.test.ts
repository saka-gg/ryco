import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";

function createTestClient() {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const terminalListeners = new Set<(event: any) => void>();
  const shellListeners = new Set<(event: any) => void>();
  let shellResubscribe: (() => void) | undefined;
  let shellError: (() => void) | undefined;
  let configResubscribe: (() => void) | undefined;

  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => {
      configResubscribe?.();
      shellResubscribe?.();
    }),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env-1"),
        },
      })),
      subscribeConfig: vi.fn(
        (listener: (event: any) => void, options?: { onResubscribe?: () => void }) => {
          configListeners.add(listener);
          configResubscribe = options?.onResubscribe;
          return () => {
            configListeners.delete(listener);
            if (configResubscribe === options?.onResubscribe) {
              configResubscribe = undefined;
            }
          };
        },
      ),
      subscribeLifecycle: vi.fn((listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      }),
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      getTurnDiff: vi.fn(async () => undefined),
      getFullThreadDiff: vi.fn(async () => undefined),
      subscribeShell: vi.fn(
        (
          listener: (event: any) => void,
          options?: { onResubscribe?: () => void; onError?: () => void },
        ) => {
          shellListeners.add(listener);
          shellResubscribe = options?.onResubscribe;
          shellError = options?.onError;
          queueMicrotask(() => {
            listener({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 1,
                projects: [],
                threads: [],
                updatedAt: "2026-04-12T00:00:00.000Z",
              },
            });
          });
          return () => {
            shellListeners.delete(listener);
            if (shellResubscribe === options?.onResubscribe) {
              shellResubscribe = undefined;
            }
            if (shellError === options?.onError) {
              shellError = undefined;
            }
          };
        },
      ),
      subscribeThread: vi.fn(() => () => undefined),
    },
    terminal: {
      open: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      onEvent: (listener: (event: any) => void) => {
        terminalListeners.add(listener);
        return () => terminalListeners.delete(listener);
      },
    },
    projects: {
      listEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      readFile: vi.fn(async () => ({
        relativePath: "README.md",
        contents: "",
        version: `sha256:${"0".repeat(64)}`,
        encoding: "utf8",
        lineEnding: "lf",
      })),
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => ({
        relativePath: "README.md",
        version: `sha256:${"1".repeat(64)}`,
      })),
      stageFileReference: vi.fn(async () => ({
        relativePath: ".ryco/attachments/file.txt",
        sizeBytes: 0,
      })),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      runStackedAction: vi.fn(async () => ({}) as any),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  } as unknown as WsRpcClient;

  return {
    client,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigEvent: (event: any) => {
      for (const listener of configListeners) {
        listener(event);
      }
    },
    emitShellSnapshot: (snapshotSequence: number) => {
      for (const listener of shellListeners) {
        listener({
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            projects: [],
            threads: [],
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        });
      }
    },
    emitShellError: () => shellError?.(),
  };
}

describe("createEnvironmentConnection", () => {
  it("bootstraps from the shell subscription snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    expect(syncShellSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("reports shell subscription failures without exposing the underlying error", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellError } = createTestClient();
    const onShellError = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      onShellError,
    });

    emitShellError();

    await expect(connection.ensureBootstrapped()).rejects.toThrow(
      "Shell snapshot synchronization failed.",
    );
    expect(onShellError).toHaveBeenCalledWith(environmentId);
    expect(onShellError.mock.calls[0]).toHaveLength(1);

    await connection.dispose();
  });

  it("keeps an early shell failure observable without an unhandled rejection", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellError } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    emitShellError();
    // React Native reports a rejected promise as an uncaught development
    // overlay at the end of this turn when no waiter has observed it yet.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(connection.ensureBootstrapped()).rejects.toThrow(
      "Shell snapshot synchronization failed.",
    );

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitWelcome, emitConfigEvent } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.make("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );
    expect(() =>
      emitConfigEvent({
        type: "snapshot",
        config: { environment: { environmentId: EnvironmentId.make("env-2") } },
      }),
    ).toThrow("Environment connection env-1 changed identity to env-2 via server config snapshot.");

    await connection.dispose();
  });

  it("normalizes Hub-relayed inner descriptors to the authenticated outer environment", async () => {
    const environmentId = EnvironmentId.make("env-hub");
    const innerEnvironmentId = EnvironmentId.make("legacy-local-uuid");
    const { client, emitWelcome, emitConfigEvent } = createTestClient();
    const onWelcome = vi.fn();
    const onConfigUpdated = vi.fn();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-hub",
        label: "Hub QA node",
        source: "hub-hosted",
        target: {
          httpBaseUrl: "http://relay.invalid",
          wsBaseUrl: "ws://relay.invalid",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      onWelcome,
      onConfigUpdated,
    });

    emitWelcome(innerEnvironmentId);
    emitConfigEvent({
      type: "snapshot",
      config: {
        environment: { environmentId: innerEnvironmentId, label: "Inner machine name" },
        settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
        providers: [],
        keybindings: {},
        issues: [],
      },
    });

    expect(onWelcome).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ environmentId, label: "Hub QA node" }),
      }),
    );
    expect(onConfigUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ environmentId, label: "Hub QA node" }),
        settings: expect.objectContaining({ enableProviderUpdateChecks: false }),
      }),
      "snapshot",
    );

    await connection.dispose();
  });

  it("projects incremental config events onto the selected environment snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitConfigEvent } = createTestClient();
    const onConfigUpdated = vi.fn();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      onConfigUpdated,
    });

    emitConfigEvent({
      type: "settingsUpdated",
      payload: { settings: DEFAULT_SERVER_SETTINGS },
    });
    expect(onConfigUpdated).not.toHaveBeenCalled();

    emitConfigEvent({
      type: "snapshot",
      config: {
        environment: { environmentId },
        settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: true },
        providers: [],
        keybindings: {},
        issues: [],
      },
    });
    emitConfigEvent({
      type: "settingsUpdated",
      payload: {
        settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
      },
    });

    expect(onConfigUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ enableProviderUpdateChecks: false }),
      }),
      "settingsUpdated",
    );

    await connection.dispose();
  });

  it("requires a fresh config snapshot after reconnect before applying increments", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitConfigEvent, emitShellSnapshot } = createTestClient();
    const onConfigUpdated = vi.fn();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      onConfigUpdated,
    });
    await connection.ensureBootstrapped();
    emitConfigEvent({
      type: "snapshot",
      config: {
        environment: { environmentId },
        settings: DEFAULT_SERVER_SETTINGS,
        providers: [],
        keybindings: {},
        issues: [],
      },
    });
    expect(onConfigUpdated).toHaveBeenCalledOnce();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    emitConfigEvent({
      type: "settingsUpdated",
      payload: {
        settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
      },
    });
    expect(onConfigUpdated).toHaveBeenCalledOnce();

    emitConfigEvent({
      type: "snapshot",
      config: {
        environment: { environmentId },
        settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
        providers: [],
        keybindings: {},
        issues: [],
      },
    });
    emitShellSnapshot(2);
    await reconnectPromise;

    expect(onConfigUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ enableProviderUpdateChecks: false }),
      }),
      "snapshot",
    );

    await connection.dispose();
  });

  it("waits for a fresh shell snapshot after reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const syncShellSnapshot = vi.fn();
    const resetShellProjection = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
      applyTerminalEvent: vi.fn(),
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);
    expect(resetShellProjection).toHaveBeenCalledWith(environmentId);

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("skips primary lifecycle/config subscriptions when no handlers are registered", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        id: "env-1",
        label: "Local env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
    });

    expect(client.server.subscribeLifecycle).not.toHaveBeenCalled();
    expect(client.server.subscribeConfig).not.toHaveBeenCalled();
    expect(client.orchestration.subscribeShell).toHaveBeenCalledOnce();

    // Its config stream opens for the first observer (the server-state sync).
    const stop = connection.config.subscribe(() => undefined);
    expect(client.server.subscribeConfig).toHaveBeenCalledOnce();
    stop();

    await connection.dispose();
  });

  it("keeps one config stream on a saved environment, however many observe it", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      resetShellProjection: vi.fn(),
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      applyTerminalEvent: vi.fn(),
      onConfigUpdated: vi.fn(),
    });
    const stopFirst = connection.config.subscribe(() => undefined);
    const stopSecond = connection.config.subscribe(() => undefined);
    stopFirst();
    stopSecond();

    expect(client.server.subscribeConfig).toHaveBeenCalledOnce();

    await connection.dispose();
  });
});
