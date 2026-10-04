import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  McpServerName,
  ProviderInstanceId,
  type McpSettingsError,
  type ServerSettingsError,
} from "@ryco/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { GuardedJsonDocument } from "../nativeConfig/guardedJsonDocument.ts";
import {
  decodeOpenCodeMcpServer,
  makeOpenCodeMcpAdapter,
  type OpenCodeMcpAdapterIo,
} from "./OpenCodeMcpAdapter.ts";

const success = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

function runAdapter<A>(
  effect: Effect.Effect<
    A,
    McpSettingsError | ServerSettingsError,
    ServerSettingsService | ServerConfig
  >,
) {
  const settingsLayer = ServerSettingsService.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("opencode")]: {
        driver: "opencode",
        displayName: "OpenCode",
        enabled: true,
        environment: [{ name: "HOME", value: "/test/home", sensitive: false }],
        config: { binaryPath: "/test/opencode" },
      },
    },
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

function makeIo(version: string, initial: Record<string, Record<string, unknown>> = {}) {
  const documents = new Map<string, Record<string, unknown>>(Object.entries(initial));
  const io: OpenCodeMcpAdapterIo = {
    run: async () => success(version),
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
      documents.set(snapshot.filePath, structuredClone(value));
      return { ...snapshot, exists: true, value };
    },
    readJsonc: async (filePath) => structuredClone(documents.get(filePath) ?? {}),
  };
  return { io, documents };
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

  it("detects OpenCode 2.x and refuses to manage its configuration", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents } = makeIo("opencode v2.0.18\n", { [globalPath]: { mcp: {} } });
    let writes = 0;
    const countingIo: OpenCodeMcpAdapterIo = {
      ...io,
      writeJson: async (snapshot, value) => {
        writes += 1;
        return io.writeJson(snapshot, value);
      },
    };
    const result = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(countingIo);
        return yield* adapter.listWorkspaces;
      }),
    );

    expect(result.providers[0]?.status).toBe("unsupported");
    expect(result.providers[0]?.message).toContain("OpenCode 2.x detected");
    expect(result.workspaces).toHaveLength(0);
    expect(writes).toBe(0);
    expect(documents.get(globalPath)).toEqual({ mcp: {} });
  });

  it("uses the V2 mcp.servers shape and installs the external bridge", async () => {
    const globalPath = "/test/home/.config/opencode/opencode.json";
    const { io, documents } = makeIo("opencode v2.0.18\n");
    const removed = await runAdapter(
      Effect.gen(function* () {
        const adapter = yield* makeOpenCodeMcpAdapter(io, { managedGenerations: ["v1", "v2"] });
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
