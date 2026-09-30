import os from "node:os";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

import { assert, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";

import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { NetService } from "@ryco/shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_HUB_CONNECTOR_CONFIG,
  DEFAULT_NODE_E2EE_POLICY_CONFIG,
  deriveServerPaths,
  resolveHubConnectorConfig,
  resolveNodeE2eePolicyConfig,
} from "./config.ts";
import { buildServiceServeArgs, resolveServerConfig } from "./cli.ts";

it("resolves bounded connector defaults and invalid enabled configuration without reflecting input", () => {
  expect(resolveHubConnectorConfig({})).toEqual(DEFAULT_HUB_CONNECTOR_CONFIG);
  expect(
    resolveHubConnectorConfig({
      enabled: "true",
      origin: "https://relay.example",
      nodeName: "  Build node  ",
      reconnectBaseMs: "250",
      reconnectMaxMs: "300000",
      reconnectStableMs: "5000",
      reconnectJitterRatio: "0.5",
      allowFileSecretStore: "true",
    }),
  ).toEqual({
    enabled: true,
    origin: "https://relay.example",
    nodeName: "Build node",
    reconnectBaseMs: 250,
    reconnectMaxMs: 300_000,
    reconnectStableMs: 5_000,
    reconnectJitterRatio: 0.5,
    allowFileSecretStore: true,
    configurationIssue: undefined,
  });

  const invalid = resolveHubConnectorConfig({
    enabled: "true",
    origin: "https://credential:sensitive@relay.example/path?token=sensitive",
    reconnectBaseMs: "0",
    reconnectMaxMs: "not-a-number",
  });
  expect(invalid).toEqual({
    ...DEFAULT_HUB_CONNECTOR_CONFIG,
    enabled: true,
    configurationIssue: "configuration_invalid",
  });
  expect(JSON.stringify(invalid)).not.toContain("sensitive");

  const invalidName = resolveHubConnectorConfig({
    enabled: "true",
    origin: "https://relay.example",
    nodeName: `private-canary-${"x".repeat(100)}`,
  });
  expect(invalidName).toEqual({
    ...DEFAULT_HUB_CONNECTOR_CONFIG,
    enabled: true,
    origin: "https://relay.example",
    configurationIssue: "configuration_invalid",
  });
  expect(JSON.stringify(invalidName)).not.toContain("private-canary");
});

it("resolves the E2EE admission policy as a tri-state and reports invalid input", () => {
  // Unconfigured is NOT `false`: it means "leave the durable policy alone", so a
  // restart in a shell without the environment variable cannot silently withdraw
  // a policy the operator enabled (§12.4).
  expect(resolveNodeE2eePolicyConfig({})).toEqual(DEFAULT_NODE_E2EE_POLICY_CONFIG);
  expect(
    resolveNodeE2eePolicyConfig({ requireE2EE: "true", requireApprovedClientE2EE: "false" }),
  ).toEqual({
    requireE2EE: true,
    requireApprovedClientE2EE: false,
    configurationIssue: undefined,
  });

  // As strict as every other boolean here: a guess changes what the node admits.
  const invalid = resolveNodeE2eePolicyConfig({ requireE2EE: "yes" });
  expect(invalid).toEqual({
    requireE2EE: undefined,
    requireApprovedClientE2EE: undefined,
    configurationIssue: "configuration_invalid",
  });
  // And it can only ever leave the durable policy as it was, never widen it.
  expect(invalid.requireE2EE).toBeUndefined();

  expect(
    resolveNodeE2eePolicyConfig({ requireE2EE: "true", requireApprovedClientE2EE: "1" }),
  ).toEqual({
    requireE2EE: true,
    requireApprovedClientE2EE: undefined,
    configurationIssue: "configuration_invalid",
  });
});

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const defaultObservabilityConfig = {
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "ryco-server",
  } as const;
  const defaultConnectorConfig = {
    hubConnector: DEFAULT_HUB_CONNECTOR_CONFIG,
    hubE2eePolicy: DEFAULT_NODE_E2EE_POLICY_CONFIG,
  } as const;

  const openBootstrapFd = Effect.fn(function* (payload: Record<string, unknown>) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "ryco-bootstrap-", suffix: ".ndjson" });
    yield* fs.writeFileString(filePath, `${JSON.stringify(payload)}\n`);
    return yield* Effect.acquireRelease(
      Effect.sync(() => openSync(filePath, "r")),
      (fd) => Effect.sync(() => closeSync(fd)),
    );
  });

  type ResolveServerFlags = Parameters<typeof resolveServerConfig>[0];

  const makeServerFlags = (
    baseDir: string,
    overrides: Partial<ResolveServerFlags> = {},
  ): ResolveServerFlags => ({
    mode: Option.none(),
    port: Option.some(0),
    host: Option.some("127.0.0.1"),
    baseDir: Option.some(baseDir),
    cwd: Option.none(),
    devUrl: Option.none(),
    noBrowser: Option.none(),
    bootstrapFd: Option.none(),
    autoBootstrapProjectFromCwd: Option.none(),
    logWebSocketEvents: Option.none(),
    tailscaleServeEnabled: Option.none(),
    tailscaleServePort: Option.none(),
    ...overrides,
  });

  const resolveHubServerConfig = (
    testName: string,
    overrides: Partial<ResolveServerFlags>,
    env: Record<string, string>,
  ) =>
    resolveServerConfig(
      makeServerFlags(join(os.tmpdir(), `ryco-cli-config-hub-${testName}`), overrides),
      Option.none(),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
      ),
    );

  it.effect("preserves Hub environment configuration when CLI flags are omitted", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveHubServerConfig(
        "environment",
        {},
        {
          RYCO_HUB_CONNECTOR_ENABLED: "true",
          RYCO_HUB_ORIGIN: "https://environment.example",
          RYCO_HUB_NODE_NAME: "Environment node",
          RYCO_HUB_ALLOW_FILE_SECRET_STORE: "true",
        },
      );

      expect(resolved.hubConnector).toEqual({
        ...DEFAULT_HUB_CONNECTOR_CONFIG,
        enabled: true,
        origin: "https://environment.example",
        nodeName: "Environment node",
        allowFileSecretStore: true,
      });
    }),
  );

  it.effect("uses positive Hub CLI flags before environment values", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveHubServerConfig(
        "positive-flags",
        {
          hubConnectorEnabled: Option.some(true),
          hubOrigin: Option.some("https://cli.example"),
          hubNodeName: Option.some("CLI node"),
          hubAllowFileSecretStore: Option.some(true),
        },
        {
          RYCO_HUB_CONNECTOR_ENABLED: "false",
          RYCO_HUB_ORIGIN: "https://environment.example",
          RYCO_HUB_NODE_NAME: "Environment node",
          RYCO_HUB_ALLOW_FILE_SECRET_STORE: "false",
        },
      );

      expect(resolved.hubConnector).toEqual({
        ...DEFAULT_HUB_CONNECTOR_CONFIG,
        enabled: true,
        origin: "https://cli.example",
        nodeName: "CLI node",
        allowFileSecretStore: true,
      });
    }),
  );

  it.effect("uses negative Hub CLI flags before true environment values", () =>
    Effect.gen(function* () {
      const disabled = yield* resolveHubServerConfig(
        "disabled-flag",
        { hubConnectorEnabled: Option.some(false) },
        {
          RYCO_HUB_CONNECTOR_ENABLED: "true",
          RYCO_HUB_ORIGIN: "https://environment.example",
          RYCO_HUB_ALLOW_FILE_SECRET_STORE: "true",
        },
      );
      expect(disabled.hubConnector).toEqual(DEFAULT_HUB_CONNECTOR_CONFIG);

      const fileFallbackDisabled = yield* resolveHubServerConfig(
        "file-fallback-disabled",
        {
          hubConnectorEnabled: Option.some(true),
          hubOrigin: Option.some("https://cli.example"),
          hubAllowFileSecretStore: Option.some(false),
        },
        {
          RYCO_HUB_ALLOW_FILE_SECRET_STORE: "true",
        },
      );
      expect(fileFallbackDisabled.hubConnector).toEqual({
        ...DEFAULT_HUB_CONNECTOR_CONFIG,
        enabled: true,
        origin: "https://cli.example",
      });
    }),
  );

  it.effect("defaults an enabled connector to the hosted Hub origin", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveHubServerConfig(
        "default-origin",
        { hubConnectorEnabled: Option.some(true) },
        {},
      );

      expect(resolved.hubConnector).toEqual({
        ...DEFAULT_HUB_CONNECTOR_CONFIG,
        enabled: true,
        origin: DEFAULT_HOSTED_APP_ORIGIN,
      });
    }),
  );

  it.effect("resolves the E2EE admission mode from the flag before the environment", () =>
    Effect.gen(function* () {
      const fromFlag = yield* resolveHubServerConfig(
        "e2ee-policy-flag",
        { hubE2eePolicy: Option.some("require-native-e2ee") },
        { RYCO_HUB_E2EE_POLICY: "require-e2ee" },
      );
      expect(fromFlag.hubE2eePolicy).toMatchObject({
        mode: "require-native-e2ee",
        configurationIssue: undefined,
      });

      const fromEnv = yield* resolveHubServerConfig(
        "e2ee-policy-env",
        {},
        { RYCO_HUB_E2EE_POLICY: "require-e2ee" },
      );
      expect(fromEnv.hubE2eePolicy?.mode).toBe("require-e2ee");

      // An unknown mode never becomes a policy: it stays unset, which can only
      // leave the committed policy as it was, and is reported.
      const invalid = yield* resolveHubServerConfig(
        "e2ee-policy-invalid",
        {},
        { RYCO_HUB_E2EE_POLICY: "require-everything" },
      );
      expect(invalid.hubE2eePolicy).toMatchObject({
        mode: undefined,
        configurationIssue: "configuration_invalid",
      });
    }),
  );

  it.effect("keeps invalid CLI origins fail-closed and out of resolved configuration", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveHubServerConfig(
        "invalid-origin",
        {
          hubConnectorEnabled: Option.some(true),
          hubOrigin: Option.some("https://private-canary@example.test/path"),
        },
        {},
      );

      expect(resolved.hubConnector).toEqual({
        ...DEFAULT_HUB_CONNECTOR_CONFIG,
        enabled: true,
        configurationIssue: "configuration_invalid",
      });
      expect(JSON.stringify(resolved.hubConnector)).not.toContain("private-canary");
    }),
  );

  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "ryco-cli-config-env-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_LOG_LEVEL: "Warn",
                  RYCO_MODE: "desktop",
                  RYCO_PORT: "4001",
                  RYCO_HOST: "0.0.0.0",
                  RYCO_HOME: baseDir,
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  RYCO_NO_BROWSER: "true",
                  RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  RYCO_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        ...defaultObservabilityConfig,
        ...defaultConnectorConfig,
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "0.0.0.0",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "ryco-cli-config-flags-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
          tailscaleServeEnabled: Option.some(true),
          tailscaleServePort: Option.some(8443),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_LOG_LEVEL: "Warn",
                  RYCO_MODE: "desktop",
                  RYCO_PORT: "4001",
                  RYCO_HOST: "0.0.0.0",
                  RYCO_HOME: join(os.tmpdir(), "ignored-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  RYCO_NO_BROWSER: "false",
                  RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  RYCO_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        ...defaultConnectorConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
        preventSleep: false,
      });
    }),
  );

  it.effect("preserves explicit false CLI boolean flags over env and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "ryco-cli-config-false-flags");
      const fd = yield* openBootstrapFd({
        noBrowser: true,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_BOOTSTRAP_FD: String(fd),
                  RYCO_NO_BROWSER: "true",
                  RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  RYCO_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        ...defaultConnectorConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: false,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
    }),
  );

  it.effect("uses bootstrap envelope values as fallbacks when flags and env are absent", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/ryco-bootstrap-home";
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        rycoHome: baseDir,
        devUrl: "http://127.0.0.1:5173",
        noBrowser: true,
        desktopControlToken: "A".repeat(43),
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
        hubConnectorEnabled: true,
        hubOrigin: "https://bootstrap.example",
        hubNodeName: "Bootstrap node",
        hubAllowFileSecretStore: true,
        hubRequireE2EE: true,
        hubRequireApprovedClientE2EE: false,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_BOOTSTRAP_FD: String(fd),
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        hubConnector: {
          ...DEFAULT_HUB_CONNECTOR_CONFIG,
          enabled: true,
          origin: "https://bootstrap.example",
          nodeName: "Bootstrap node",
          allowFileSecretStore: true,
        },
        // The envelope is the lowest-precedence source and the only one the
        // desktop uses, so an operator policy set there must survive.
        hubE2eePolicy: {
          requireE2EE: true,
          requireApprovedClientE2EE: false,
          configurationIssue: undefined,
        },
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.2",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        desktopControlToken: "A".repeat(43),
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
      assert.equal(join(baseDir, "dev"), resolved.stateDir);
    }),
  );

  it.effect("creates derived runtime directories during config resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-cli-config-dirs-" });
      const customCwd = path.join(baseDir, "nested", "project");

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.some(customCwd),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      for (const directory of [
        customCwd,
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
        path.dirname(resolved.serverLogPath),
        path.dirname(resolved.serverTracePath),
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
      expect(resolved.cwd).toBe(path.resolve(customCwd));
    }),
  );

  it.effect("uses the canonical startup cwd as the restricted workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-cli-config-restricted-" });
      const customCwd = path.join(baseDir, "workspace");

      const resolved = yield* resolveServerConfig(
        makeServerFlags(baseDir, {
          cwd: Option.some(customCwd),
          restrictToCwd: Option.some(true),
        }),
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.cwd).toBe(path.resolve(customCwd));
      expect(resolved.workspaceAccessRoot).toBe(yield* fs.realPath(customCwd));
    }),
  );

  it.effect("keeps workspace access unrestricted when the flag is absent or disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "ryco-cli-config-unrestricted-",
      });

      const absent = yield* resolveServerConfig(makeServerFlags(baseDir), Option.none()).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );
      const disabled = yield* resolveServerConfig(
        makeServerFlags(baseDir, { restrictToCwd: Option.some(false) }),
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(absent.workspaceAccessRoot).toBeUndefined();
      expect(disabled.workspaceAccessRoot).toBeUndefined();
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "ryco-cli-config-env-wins");
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        rycoHome: "/tmp/ryco-bootstrap-home",
        devUrl: "http://127.0.0.1:5173",
        noBrowser: false,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
        hubConnectorEnabled: false,
        hubOrigin: "https://bootstrap.example",
        hubNodeName: "Bootstrap node",
        hubAllowFileSecretStore: true,
        hubRequireE2EE: false,
        hubRequireApprovedClientE2EE: false,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          hubRequireApprovedClientE2EE: Option.some(true),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_MODE: "web",
                  RYCO_BOOTSTRAP_FD: String(fd),
                  RYCO_HOME: baseDir,
                  RYCO_NO_BROWSER: "true",
                  RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  RYCO_LOG_WS_EVENTS: "true",
                  RYCO_HUB_CONNECTOR_ENABLED: "true",
                  RYCO_HUB_ORIGIN: "https://environment.example",
                  RYCO_HUB_NODE_NAME: "Environment node",
                  RYCO_HUB_ALLOW_FILE_SECRET_STORE: "false",
                  RYCO_HUB_REQUIRE_E2EE: "true",
                  RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        hubConnector: {
          ...DEFAULT_HUB_CONNECTOR_CONFIG,
          enabled: true,
          origin: "https://environment.example",
          nodeName: "Environment node",
          allowFileSecretStore: false,
        },
        // Flag beats env beats envelope, independently per option: the flag
        // wins `requireApprovedClientE2EE` and the env wins `requireE2EE`,
        // both over an envelope that said false for each.
        hubE2eePolicy: {
          requireE2EE: true,
          requireApprovedClientE2EE: true,
          configurationIssue: undefined,
        },
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
    }),
  );

  it.effect("falls back to persisted observability settings when env vars are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-cli-config-settings-" });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        ...defaultConnectorConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
    }),
  );

  it.effect("forces noBrowser and disables auto-bootstrap for headless startup presentation", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "ryco-cli-config-headless-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
        {
          startupPresentation: "headless",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  RYCO_NO_BROWSER: "false",
                  RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        ...defaultConnectorConfig,
        mode: "web",
        port: 3773,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: undefined,
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        preventSleep: false,
      });
    }),
  );
});

it("builds the serve arguments a background service runs with", () => {
  const none = Option.none();
  expect(
    buildServiceServeArgs({
      baseDir: "/Users/me/.ryco",
      cwd: "/Users/me/code",
      host: Option.some("127.0.0.1"),
      port: none,
      hubConnectorEnabled: Option.some(true),
      hubOrigin: none,
      hubNodeName: Option.some("Mac mini"),
      hubAllowFileSecretStore: none,
      hubE2eePolicy: none,
      tailscaleServeEnabled: Option.some(true),
      tailscaleServePort: none,
      restrictToCwd: none,
      preventSleep: none,
    }),
  ).toEqual([
    "serve",
    "--base-dir",
    "/Users/me/.ryco",
    "--host",
    "127.0.0.1",
    "--hub-connector-enabled",
    "--hub-node-name",
    "Mac mini",
    "--tailscale-serve",
    "--prevent-sleep",
    "/Users/me/code",
  ]);
  expect(
    buildServiceServeArgs({
      baseDir: "/b",
      cwd: "/c",
      host: none,
      port: Option.some(4000),
      hubConnectorEnabled: none,
      hubOrigin: none,
      hubNodeName: none,
      hubAllowFileSecretStore: none,
      hubE2eePolicy: none,
      tailscaleServeEnabled: none,
      tailscaleServePort: none,
      restrictToCwd: none,
      preventSleep: Option.some(false),
    }),
  ).toEqual(["serve", "--base-dir", "/b", "--port", "4000", "--no-prevent-sleep", "/c"]);
});
