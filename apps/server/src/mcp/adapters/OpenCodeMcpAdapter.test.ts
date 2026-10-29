import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpServerName,
  McpServerWritableConfig,
  ProviderInstanceId,
  type McpSettingsError,
  type ServerSettingsError,
} from "@ryco/contracts";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { ProcessRunResult } from "../../processRunner.ts";
import { OPENCODE_V2_ADVISORY_MESSAGE } from "../../provider/openCodeVersion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { GuardedJsonDocument } from "../nativeConfig/guardedJsonDocument.ts";
// Through the lazy adapter the registry uses, so every test also covers loading the implementation.
import { makeOpenCodeMcpAdapter } from "./OpenCodeMcpAdapter.ts";
import { decodeOpenCodeMcpServer, type OpenCodeMcpAdapterIo } from "./OpenCodeMcpConfig.ts";

const success = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

const openCodeInstance = (
  home: string,
  binaryPath: string,
  displayName?: string,
  environment: Readonly<Record<string, string>> = {},
) => ({
  driver: "opencode",
  ...(displayName ? { displayName } : {}),
  enabled: true,
  environment: Object.entries({ HOME: home, ...environment }).map(([name, value]) => ({
    name,
    value,
    sensitive: false,
  })),
  config: { binaryPath },
});

function runAdapter<A>(
  effect: Effect.Effect<
    A,
    McpSettingsError | ServerSettingsError,
    ServerSettingsService | ServerConfig
  >,
  providerInstances: Record<string, ReturnType<typeof openCodeInstance>> = {
    opencode: openCodeInstance("/test/home", "/test/opencode", "OpenCode"),
  },
) {
  const settingsLayer = ServerSettingsService.layerTest({
    providerInstances: Object.fromEntries(
      Object.entries(providerInstances).map(([id, instance]) => [
        ProviderInstanceId.make(id),
        instance,
      ]),
    ),
  });
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          settingsLayer,
          ServerConfig.layerTest("/test/project", "opencode-mcp-test"),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );
}

function makeIo(
  version: string | ((binaryPath: string) => string),
  initial: Record<string, Record<string, unknown>> = {},
) {
  const documents = new Map<string, Record<string, unknown>>(Object.entries(initial));
  let writes = 0;
  const io: OpenCodeMcpAdapterIo = {
    run: async (command) => success(typeof version === "string" ? version : version(command)),
    exists: async (filePath) => documents.has(filePath),
    readJson: async (filePath): Promise<GuardedJsonDocument> => ({
      filePath,
      exists: documents.has(filePath),
      fingerprint: null,
      mode: null,
      value: structuredClone(documents.get(filePath) ?? {}),
      indent: "  ",
      newline: "\n",
      finalNewline: true,
    }),
    writeJson: async (snapshot, value) => {
      writes += 1;
      documents.set(snapshot.filePath, structuredClone(value));
      return { ...snapshot, exists: true, value };
    },
    readJsonc: async (filePath) => structuredClone(documents.get(filePath) ?? {}),
  };
  return { io, documents, writes: () => writes };
}

describe("OpenCode MCP config decoding", () => {
  it("normalizes both recognized format generations", () => {
    expect(
      decodeOpenCodeMcpServer(
        {
          type: "local",
          command: ["node", "server.js"],
          environment: { TOKEN: "canary" },
          enabled: false,
        },
        "v1",
      ),
    ).toMatchObject({ transport: "stdio", command: "node", enabled: false });
    expect(
      decodeOpenCodeMcpServer(
        { type: "remote", url: "https://example.test/mcp", disabled: true },
        "v2",
      ),
    ).toMatchObject({ transport: "http", enabled: false });
  });

  it("reads 2.x per-phase timeouts and a bare 1.x number as the bound of every phase", () => {
    const local = { type: "local", command: ["node"] };
    expect(
      decodeOpenCodeMcpServer(
        { ...local, timeout: { startup: 4_000, catalog: 7_000, execution: 30_000 } },
        "v2",
      ),
    ).toMatchObject({ startupTimeoutSec: 4, toolTimeoutSec: 30 });
    expect(decodeOpenCodeMcpServer({ ...local, timeout: 5_000 }, "v2")).toMatchObject({
      startupTimeoutSec: 5,
      toolTimeoutSec: 5,
    });
    const v1 = decodeOpenCodeMcpServer({ ...local, timeout: 5_000 }, "v1");
    expect(v1).toMatchObject({ toolTimeoutSec: 5 });
    expect(v1).not.toHaveProperty("startupTimeoutSec");
    // A 1.x reader ignores an object timeout instead of misreading it.
    expect(
      decodeOpenCodeMcpServer({ ...local, timeout: { execution: 30_000 } }, "v1"),
    ).not.toHaveProperty("toolTimeoutSec");
  });
});

describe("OpenCodeMcpAdapter", () => {
  it("manages recognized V1 JSON while redacting and preserving secrets", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents } = makeIo("1.18.18\n", {
      [globalPath]: {
        unknownRoot: true,
        mcp: {
          tools: {
            type: "local",
            command: ["node", "old.js"],
            environment: { TOKEN: "opencode-secret-canary" },
            enabled: true,
            unknownEntry: "keep",
          },
        },
      },
    });

    const result = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(io);
        const discovery = yield* adapter.listWorkspaces;
        const global = discovery.workspaces.find((workspace) => workspace.nativeScope === "user")!;
        const listed = yield* adapter.listServers!({ workspaceId: global.id, detail: "full" });
        const tools = listed.servers[0]!;
        const updated = yield* adapter.upsertServer!({
          workspaceId: global.id,
          name: tools.name,
          config: { ...tools.config, args: ["new.js"] },
          secretMutations: { "env.TOKEN": { action: "retain" } },
        });
        return { discovery, global, listed, updated };
      }),
    );

    expect(result.discovery.workspaces).toHaveLength(2);
    expect(result.global.formatGeneration).toBe("opencode-v1-json");
    expect(result.global.capabilities.externalAgentControl).toBe("available");
    expect(result.global.capabilities.automaticAgentControl).toBe("unavailable");
    expect(result.listed.servers[0]?.config.secretFields).toEqual({ "env.TOKEN": "present" });
    expect(JSON.stringify(result)).not.toContain("opencode-secret-canary");
    const written = documents.get(globalPath)!;
    const mcp = written.mcp as Record<string, unknown>;
    const tools = mcp.tools as Record<string, unknown>;
    const environment = tools.environment as Record<string, unknown>;
    expect(written.unknownRoot).toBe(true);
    expect(tools.unknownEntry).toBe("keep");
    expect(environment.TOKEN).toBe("opencode-secret-canary");
    expect(tools.command).toEqual(["node", "new.js"]);
  });

  it("manages real `opencode v1.x` output like a bare version", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const prefixed = makeIo("opencode v1.18.18\n", { [globalPath]: { mcp: {} } });
    const bare = makeIo("1.18.18\n", { [globalPath]: { mcp: {} } });
    const discover = (io: OpenCodeMcpAdapterIo) =>
      runAdapter(
        Effect.gen(function* () {
          const adapter = yield* makeOpenCodeMcpAdapter(io);
          return yield* adapter.listWorkspaces;
        }),
      );

    const [prefixedResult, bareResult] = await Promise.all([
      discover(prefixed.io),
      discover(bare.io),
    ]);
    expect(prefixedResult).toEqual(bareResult);
    expect(prefixedResult.providers[0]?.status).toBe("managed");
    expect(
      prefixedResult.workspaces.find((workspace) => workspace.nativeScope === "user")
        ?.formatGeneration,
    ).toBe("opencode-v1-json");
  });

  it("manages OpenCode 2.x by default and refuses it when 2.x is not managed", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents, writes } = makeIo("opencode v2.2.0\n", {
      [globalPath]: { mcp: {} },
    });
    const discover = (options?: Parameters<typeof makeOpenCodeMcpAdapter>[1]) =>
      runAdapter(
        Effect.gen(function* () {
          const adapter = yield* makeOpenCodeMcpAdapter(io, options);
          return yield* adapter.listWorkspaces;
        }),
      );

    const managed = await discover();
    expect(managed.providers[0]?.status).toBe("managed");
    expect(
      managed.workspaces.find((workspace) => workspace.nativeScope === "user")?.formatGeneration,
    ).toBe("opencode-v2-json");

    const unmanaged = await discover({ managedGenerations: ["v1"] });
    expect(unmanaged.providers[0]?.status).toBe("unsupported");
    expect(unmanaged.providers[0]?.message).toBe(OPENCODE_V2_ADVISORY_MESSAGE);
    expect(unmanaged.workspaces).toHaveLength(0);
    expect(writes()).toBe(0);
    expect(documents.get(globalPath)).toEqual({ mcp: {} });
  });

  it("round-trips 2.x entries, enablement and per-phase timeouts in mcp.servers", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents } = makeIo("opencode v2.2.0\n", {
      [globalPath]: {
        unknownRoot: true,
        mcp: {
          timeout: { catalog: 9_000 },
          servers: {
            tools: {
              type: "local",
              command: ["node", "old.js"],
              environment: { TOKEN: "opencode-v2-secret-canary" },
              disabled: false,
              timeout: { startup: 4_000, catalog: 7_000, execution: 30_000 },
              protocol: "auto",
            },
          },
        },
      },
    });
    const snapshot = () => structuredClone(documents.get(globalPath)!) as { mcp: unknown };

    const result = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(io);
        const discovery = yield* adapter.listWorkspaces;
        const workspaceId = discovery.workspaces.find(
          (workspace) => workspace.nativeScope === "user",
        )!.id;
        const listed = yield* adapter.listServers!({ workspaceId, detail: "full" });
        const tools = listed.servers[0]!;
        const updated = yield* adapter.upsertServer!({
          workspaceId,
          name: tools.name,
          config: { ...tools.config, args: ["new.js"], toolTimeoutSec: 45 },
          secretMutations: { "env.TOKEN": { action: "retain" } },
        });
        const afterUpsert = snapshot();
        const disabled = yield* adapter.setServerEnabled!({
          workspaceId,
          name: tools.name,
          enabled: false,
        });
        const afterDisable = snapshot();
        yield* adapter.upsertServer!({
          workspaceId,
          name: McpServerName.make("docs"),
          config: Schema.decodeSync(McpServerWritableConfig)({
            transport: "http",
            url: "https://example.test/mcp",
            startupTimeoutSec: 2.5,
          }),
        });
        const removed = yield* adapter.removeServer!({ workspaceId, name: tools.name });
        return { listed, updated, afterUpsert, disabled, afterDisable, removed };
      }),
    );

    expect(result.listed.servers[0]?.config).toMatchObject({
      command: "node",
      args: ["old.js"],
      enabled: true,
      startupTimeoutSec: 4,
      toolTimeoutSec: 30,
      secretFields: { "env.TOKEN": "present" },
    });
    expect(result.updated.servers[0]?.config).toMatchObject({
      args: ["new.js"],
      toolTimeoutSec: 45,
    });
    expect(
      JSON.stringify([result.listed, result.updated, result.disabled, result.removed]),
    ).not.toContain("opencode-v2-secret-canary");
    // The phase Ryco has no field for, the server's unknown keys and the secret survive.
    expect(result.afterUpsert).toEqual({
      unknownRoot: true,
      mcp: {
        timeout: { catalog: 9_000 },
        servers: {
          tools: {
            type: "local",
            command: ["node", "new.js"],
            environment: { TOKEN: "opencode-v2-secret-canary" },
            disabled: false,
            timeout: { startup: 4_000, catalog: 7_000, execution: 45_000 },
            protocol: "auto",
          },
        },
      },
    });
    expect(result.disabled.servers[0]).toMatchObject({
      startupStatus: "disabled",
      config: { enabled: false },
    });
    expect(result.afterDisable.mcp).toMatchObject({ servers: { tools: { disabled: true } } });
    expect(result.afterDisable.mcp).not.toHaveProperty("servers.tools.enabled");
    expect(result.removed.servers.map((server) => server.name)).toEqual(["docs"]);
    expect(documents.get(globalPath)).toEqual({
      unknownRoot: true,
      mcp: {
        timeout: { catalog: 9_000 },
        servers: {
          docs: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: {},
            disabled: false,
            timeout: { startup: 2_500 },
          },
        },
      },
    });
  });

  it("shows the 1.x entries a 2.x config still runs and moves only edited ones", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const bridge = { command: "/runtime/node", args: ["/runtime/ryco", "mcp", "serve"] };
    const { io, documents } = makeIo("2.2.0\n", {
      [globalPath]: {
        mcp: {
          legacy: {
            type: "remote",
            url: "https://legacy.test/mcp",
            enabled: false,
            timeout: 5_000,
            oauth: { clientId: "client", callbackPort: 19_876 },
          },
          shadowed: { type: "local", command: ["old"], enabled: true },
          // Agent Control installed while the instance still ran 1.x.
          ryco: {
            type: "local",
            command: [bridge.command, ...bridge.args],
            environment: {},
            enabled: true,
          },
          servers: { shadowed: { type: "local", command: ["new"], disabled: true } },
        },
      },
    });
    const name = McpServerName.make;

    const result = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(io);
        const discovery = yield* adapter.listWorkspaces;
        const workspaceId = discovery.workspaces.find(
          (workspace) => workspace.nativeScope === "user",
        )!.id;
        const listed = yield* adapter.listServers!({ workspaceId, detail: "full" });
        yield* adapter.setServerEnabled!({ workspaceId, name: name("legacy"), enabled: true });
        const afterEnable = structuredClone(documents.get(globalPath));
        const external = adapter.externalAgentControl!;
        const installed = yield* external.inspect({ workspaceId, name: name("ryco"), ...bridge });
        const disconnected = yield* external.remove({
          workspaceId,
          name: name("ryco"),
          expectedFingerprint: installed.fingerprint ?? "absent",
        });
        yield* adapter.removeServer!({ workspaceId, name: name("shadowed") });
        return { listed, afterEnable, installed, disconnected };
      }),
    );

    const listed = Object.fromEntries(
      result.listed.servers.map((server) => [server.name, server.config]),
    );
    expect(Object.keys(listed).toSorted()).toEqual(["legacy", "ryco", "shadowed"]);
    expect(listed.legacy).toMatchObject({
      transport: "http",
      enabled: false,
      startupTimeoutSec: 5,
      toolTimeoutSec: 5,
    });
    // OpenCode 2 runs its own `mcp.servers` entry over a 1.x entry of the same name.
    expect(listed.shadowed).toMatchObject({ command: "new", enabled: false });
    // The edited entry moves in the shape OpenCode 2 reads it as; the untouched ones stay put.
    const moved = {
      type: "remote",
      url: "https://legacy.test/mcp",
      disabled: false,
      timeout: 5_000,
      oauth: { client_id: "client", callback_port: 19_876 },
    };
    expect(result.afterEnable).toEqual({
      mcp: {
        shadowed: { type: "local", command: ["old"], enabled: true },
        ryco: {
          type: "local",
          command: [bridge.command, ...bridge.args],
          environment: {},
          enabled: true,
        },
        servers: {
          shadowed: { type: "local", command: ["new"], disabled: true },
          legacy: moved,
        },
      },
    });
    expect(result.installed.state).toBe("matching");
    expect(result.disconnected).toEqual({ removed: true, preservedUserChanges: false });
    // Disconnecting and removing reach the 1.x entries too, so OpenCode 2 stops running them.
    expect(documents.get(globalPath)).toEqual({ mcp: { servers: { legacy: moved } } });
  });

  it("edits a file that a 1.x and a 2.x instance share for neither", async () => {
    const versions = (binaryPath: string) =>
      binaryPath === "/test/opencode2" ? "opencode v2.2.0\n" : "opencode v1.18.18\n";
    const discover = (homes: readonly [string, string]) => {
      const { io, writes } = makeIo(versions);
      return runAdapter(
        Effect.gen(function* () {
          const adapter = yield* makeOpenCodeMcpAdapter(io);
          return { ...(yield* adapter.listWorkspaces), writes: writes() };
        }),
        {
          // The default slot is set explicitly so that no legacy-mirror instance joins in.
          opencode: openCodeInstance(homes[0], "/test/opencode"),
          "opencode-two": openCodeInstance(homes[1], "/test/opencode2"),
        },
      );
    };
    const conflict = (configPath: string) =>
      `OpenCode 1.x and 2.x instances share ${configPath}. Ryco edits it for neither, because 1.x cannot read the 2.x MCP format.`;
    const sharedHome = "/test/home/.config/opencode/opencode.json";
    const project = "/test/project/opencode.json";

    const shared = await discover(["/test/home", "/test/home"]);
    expect(shared.workspaces).toHaveLength(0);
    expect(shared.providers).toHaveLength(2);
    for (const provider of shared.providers) {
      expect(provider).toMatchObject({ status: "unsupported", message: conflict(sharedHome) });
      expect(provider).not.toHaveProperty("workspaceId");
      expect(provider.capabilities.upsert).toBe("unavailable");
    }
    expect(shared.issues).toEqual([
      { instanceId: "opencode", message: conflict(sharedHome) },
      { instanceId: "opencode", message: conflict(project) },
      { instanceId: "opencode-two", message: conflict(sharedHome) },
      { instanceId: "opencode-two", message: conflict(project) },
    ]);
    expect(shared.writes).toBe(0);

    // Separate homes keep each user profile; only the project file both read is dropped.
    const separate = await discover(["/test/home", "/test/other"]);
    expect(separate.providers.map((provider) => provider.status)).toEqual(["managed", "managed"]);
    expect(
      separate.workspaces.map((workspace) => [workspace.nativeScope, workspace.formatGeneration]),
    ).toEqual([
      ["user", "opencode-v1-json"],
      ["user", "opencode-v2-json"],
    ]);
    expect(separate.issues).toEqual([
      { instanceId: "opencode", message: conflict(project) },
      { instanceId: "opencode-two", message: conflict(project) },
    ]);
  });

  it("finds the 2.x profile in OPENCODE_CONFIG_DIR and checks every file each generation reads", async () => {
    const versions = (binaryPath: string) =>
      binaryPath === "/test/opencode2" ? "opencode v2.2.0\n" : "opencode v1.18.18\n";
    const discover = async (instances: Parameters<typeof runAdapter>[1]) => {
      const { io, writes } = makeIo(versions);
      const result = await runAdapter(
        Effect.gen(function* () {
          const adapter = yield* makeOpenCodeMcpAdapter(io);
          return yield* adapter.listWorkspaces;
        }),
        instances,
      );
      expect(writes()).toBe(0);
      return {
        ...result,
        profiles: result.workspaces
          .filter((workspace) => workspace.nativeScope === "user")
          .map((workspace) => [workspace.formatGeneration, workspace.displayPath]),
      };
    };
    const conflict = (configPath: string) =>
      `OpenCode 1.x and 2.x instances share ${configPath}. Ryco edits it for neither, because 1.x cannot read the 2.x MCP format.`;
    const dotfiles = { OPENCODE_CONFIG_DIR: "/test/dotfiles/opencode" };
    const dotfilesPath = "/test/dotfiles/opencode/opencode.json";
    const xdgPath = "/test/home/.config/opencode/opencode.json";
    const project = "/test/project/opencode.json";

    // OpenCode 2 replaces its global directory with OPENCODE_CONFIG_DIR; 1.x keeps its own.
    const v2 = await discover({
      opencode: openCodeInstance("/test/home", "/test/opencode2", undefined, dotfiles),
    });
    expect(v2.profiles).toEqual([["opencode-v2-json", dotfilesPath]]);
    expect(v2.providers[0]?.status).toBe("managed");
    const v1 = await discover({
      opencode: openCodeInstance("/test/home", "/test/opencode", undefined, dotfiles),
    });
    expect(v1.profiles).toEqual([["opencode-v1-json", xdgPath]]);

    // 1.x reads OPENCODE_CONFIG_DIR on top of its own profile, so 2.x may not edit it there;
    // 2.x no longer reads the XDG profile, which stays 1.x's.
    const shared = await discover({
      opencode: openCodeInstance("/test/home", "/test/opencode", undefined, dotfiles),
      "opencode-two": openCodeInstance("/test/home", "/test/opencode2", undefined, dotfiles),
    });
    expect(shared.profiles).toEqual([["opencode-v1-json", xdgPath]]);
    expect(shared.providers.map(({ status, message }) => [status, message])).toEqual([
      ["managed", "Ryco manages recognized OpenCode V1 JSON configuration."],
      ["unsupported", conflict(dotfilesPath)],
    ]);
    expect(shared.issues).toEqual([
      { instanceId: "opencode", message: conflict(project) },
      { instanceId: "opencode-two", message: conflict(dotfilesPath) },
      { instanceId: "opencode-two", message: conflict(project) },
    ]);

    // 1.x reads its XDG profile and the project file also with OPENCODE_CONFIG set, so 2.x may
    // edit neither, although Ryco edits only the OPENCODE_CONFIG file for 1.x.
    const custom = await discover({
      opencode: openCodeInstance("/test/home", "/test/opencode", undefined, {
        OPENCODE_CONFIG: "/test/custom.json",
      }),
      "opencode-two": openCodeInstance("/test/home", "/test/opencode2"),
    });
    expect(custom.profiles).toEqual([["opencode-v1-json", "/test/custom.json"]]);
    expect(custom.issues).toEqual([
      { instanceId: "opencode-two", message: conflict(xdgPath) },
      { instanceId: "opencode-two", message: conflict(project) },
    ]);
  });

  it("leaves the config of a 2.x release the runtime refuses alone", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    for (const version of ["2.1.4", "2.0.18"]) {
      const { io, documents, writes } = makeIo(`opencode v${version}\n`, {
        [globalPath]: { mcp: {} },
      });
      const result = await runAdapter(
        Effect.gen(function* () {
          const adapter = yield* makeOpenCodeMcpAdapter(io);
          return yield* adapter.listWorkspaces;
        }),
      );
      expect(result.workspaces).toHaveLength(0);
      expect(result.providers[0]).toMatchObject({
        status: "unsupported",
        message: `OpenCode v${version} is too old. Upgrade OpenCode 2 to v2.2.0 or newer.`,
      });
      expect(result.providers[0]?.capabilities.upsert).toBe("unavailable");
      expect(result.providers[0]?.capabilities.externalAgentControl).toBe("unavailable");
      expect(writes()).toBe(0);
      expect(documents.get(globalPath)).toEqual({ mcp: {} });
    }
  });

  it("uses the V2 mcp.servers shape and installs the external bridge", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents } = makeIo("opencode v2.2.0\n");
    const removed = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(io);
        const discovery = yield* adapter.listWorkspaces;
        const workspaceId = discovery.workspaces.find(
          (workspace) => workspace.nativeScope === "user",
        )!.id;
        const external = adapter.externalAgentControl!;
        const desired = {
          workspaceId,
          name: McpServerName.make("ryco"),
          command: "/runtime/node",
          args: ["/runtime/ryco", "mcp", "serve"],
        };
        const installed = yield* external.install({ ...desired, expectedFingerprint: null });
        return yield* external.remove({
          workspaceId,
          name: desired.name,
          expectedFingerprint: installed.fingerprint,
        });
      }),
    );

    expect(removed).toEqual({ removed: true, preservedUserChanges: false });
    expect(documents.get(globalPath)).toMatchObject({ mcp: { servers: {} } });
  });

  it("fails closed for unknown versions and exposes JSONC as read-only", async () => {
    const unknown = makeIo("3.0.0\n");
    const unknownResult = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(unknown.io);
        return yield* adapter.listWorkspaces;
      }),
    );
    expect(unknownResult.workspaces).toHaveLength(0);
    expect(unknownResult.providers[0]?.status).toBe("unsupported");

    const jsoncPath = "/test/home/.config/opencode/opencode.jsonc";
    const jsonc = makeIo("1.18.18\n", { [jsoncPath]: { mcp: {} } });
    const jsoncResult = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(jsonc.io);
        return yield* adapter.listWorkspaces;
      }),
    );
    const global = jsoncResult.workspaces.find((workspace) => workspace.nativeScope === "user")!;
    expect(global.formatGeneration).toBe("opencode-v1-jsonc-readonly");
    expect(global.capabilities.upsert).toBe("unavailable");
    expect(global.capabilities.externalAgentControl).toBe("unavailable");
  });
});
