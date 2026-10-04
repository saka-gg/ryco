import { createHash } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  McpListServersResult,
  McpProviderCapabilities,
  McpProviderSupport,
  McpServer,
  McpServerName,
  McpServerWritableConfig,
  McpSettingsError,
  McpWorkspace,
  McpWorkspaceId,
  OpenCodeSettings,
  ProviderDriverKind,
  type McpListWorkspacesResult,
  type McpProviderSupport as McpProviderSupportType,
  type McpServerWritableConfig as McpServerWritableConfigType,
  type ProviderInstanceId,
} from "@ryco/contracts";
import { Effect, Exit, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { runProcess, type ProcessRunResult } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import {
  classifyOpenCodeGeneration,
  type OpenCodeGeneration,
} from "../../provider/openCodeVersion.ts";
import { parseGenericCliVersion } from "../../provider/providerSnapshot.ts";
import type { ProviderMcpAdapter } from "../ProviderMcpAdapter.ts";
import { makeProviderMcpExternalAgentControl } from "../ProviderMcpExternalAgentControl.ts";
import {
  applyProviderMcpSecretMutations,
  providerMcpConfigFingerprint,
  providerMcpSecretPresence,
} from "../ProviderMcpSecrets.ts";
import {
  readGuardedJsonDocument,
  writeGuardedJsonDocument,
  type GuardedJsonDocument,
} from "../nativeConfig/guardedJsonDocument.ts";

const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const VERSION_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 256 * 1024;
/**
 * Ryco does not edit OpenCode 2.x configuration until OpenCode 2 support lands: the 2.x runtime is
 * gated as unsupported, and a 1.x and a 2.x instance sharing one `opencode.json` would write
 * incompatible shapes (a V2 `mcp.servers` key reads to 1.x as a server named `servers`).
 */
const DEFAULT_MANAGED_GENERATIONS: ReadonlyArray<OpenCodeGeneration> = ["v1"];
const UNMANAGED_V2_MESSAGE =
  "OpenCode 2.x detected. Ryco works with OpenCode 1.x and does not edit 2.x configuration yet; 2.x support is coming.";
const UNKNOWN_GENERATION_MESSAGE =
  "This OpenCode version is unknown or unavailable, so Ryco will not mutate its config.";

export interface OpenCodeMcpAdapterOptions {
  /** Generations whose native config Ryco may manage. Production default: ["v1"]. */
  readonly managedGenerations?: ReadonlyArray<OpenCodeGeneration>;
}

const writableCapabilities = Schema.decodeSync(McpProviderCapabilities)({
  readConfiguration: "available",
  upsert: "available",
  remove: "available",
  enableDisable: "available",
  externalAgentControl: "available",
  automaticAgentControl: "unavailable",
  scopes: ["user"],
});
const readOnlyCapabilities = Schema.decodeSync(McpProviderCapabilities)({
  readConfiguration: "available",
  externalAgentControl: "unavailable",
  automaticAgentControl: "unavailable",
  scopes: ["user"],
});

interface OpenCodeMcpRuntime {
  readonly workspace: McpWorkspace;
  readonly configPath: string;
  readonly source: "user" | "project";
  readonly generation: OpenCodeGeneration;
  readonly readOnly: boolean;
}

export interface OpenCodeMcpAdapterIo {
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeoutMs: number;
      readonly maxBufferBytes: number;
      readonly outputMode: "truncate";
    },
  ) => Promise<ProcessRunResult>;
  readonly exists: (filePath: string) => Promise<boolean>;
  readonly readJson: (filePath: string) => Promise<GuardedJsonDocument>;
  readonly writeJson: (
    snapshot: GuardedJsonDocument,
    value: Record<string, unknown>,
  ) => Promise<GuardedJsonDocument>;
  readonly readJsonc: (filePath: string) => Promise<Record<string, unknown>>;
}

function parseLenientJson(text: string, filePath: string): Record<string, unknown> {
  const withoutLineComments = text.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
  );
  const withoutComments = withoutLineComments
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (match, stringLiteral: string | undefined) =>
      stringLiteral ? match : "",
    )
    .replace(/,(\s*[}\]])/g, "$1");
  const parsed = JSON.parse(withoutComments) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenCode configuration at ${filePath} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

const defaultIo: OpenCodeMcpAdapterIo = {
  run: runProcess,
  exists: (filePath) =>
    access(filePath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ),
  readJson: readGuardedJsonDocument,
  writeJson: writeGuardedJsonDocument,
  readJsonc: async (filePath) => {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`OpenCode configuration at ${filePath} is not a safe regular file.`);
    }
    return parseLenientJson(await readFile(filePath, "utf8"), filePath);
  },
};

function toMcpError(message: string, cause?: unknown): McpSettingsError {
  return new McpSettingsError({ message, ...(cause === undefined ? {} : { cause }) });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const source = record(value);
  if (!source) return {};
  const result = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      entry.every((part) => typeof part === "string"),
    ),
  );
  return Object.keys(result).length === Object.keys(source).length ? result : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

export function decodeOpenCodeMcpServer(
  value: unknown,
  generation: OpenCodeGeneration,
): McpServerWritableConfigType | null {
  const entry = record(value);
  if (!entry) return null;
  const environment = stringRecord(entry.environment);
  const headers = stringRecord(entry.headers);
  if (!environment || !headers) return null;
  const enabled = generation === "v2" ? entry.disabled !== true : entry.enabled !== false;
  const timeout = typeof entry.timeout === "number" ? entry.timeout / 1_000 : undefined;
  if (entry.type === "remote" && typeof entry.url === "string") {
    return Schema.decodeSync(McpServerWritableConfig)({
      transport: "http",
      url: entry.url,
      httpHeaders: headers,
      enabled,
      ...(timeout ? { toolTimeoutSec: timeout } : {}),
    });
  }
  const command = stringArray(entry.command);
  if (entry.type === "local" && command && command.length > 0) {
    return Schema.decodeSync(McpServerWritableConfig)({
      transport: "stdio",
      command: command[0]!,
      args: command.slice(1),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      env: environment,
      enabled,
      ...(timeout ? { toolTimeoutSec: timeout } : {}),
    });
  }
  return null;
}

function serverMap(document: Record<string, unknown>, generation: OpenCodeGeneration) {
  const mcp = record(document.mcp) ?? {};
  return generation === "v2" ? (record(mcp.servers) ?? {}) : mcp;
}

function withServerMap(
  document: Record<string, unknown>,
  generation: OpenCodeGeneration,
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const mcp = record(document.mcp) ?? {};
  return generation === "v2"
    ? { ...document, mcp: { ...mcp, servers } }
    : { ...document, mcp: servers };
}

function workspaceIdFor(configPath: string, generation: OpenCodeGeneration): McpWorkspaceId {
  return McpWorkspaceId.make(
    `opencode:${createHash("sha256").update(`${generation}\0${configPath}`, "utf8").digest("base64url")}`,
  );
}

async function resolveConfigPath(
  io: OpenCodeMcpAdapterIo,
  basePath: string,
  customPath?: string,
): Promise<{ path: string; readOnly: boolean } | { conflict: string }> {
  if (customPath) return { path: customPath, readOnly: customPath.endsWith(".jsonc") };
  const json = path.join(basePath, "opencode.json");
  const jsonc = path.join(basePath, "opencode.jsonc");
  const [hasJson, hasJsonc] = await Promise.all([io.exists(json), io.exists(jsonc)]);
  if (hasJson && hasJsonc) {
    return { conflict: `Both ${json} and ${jsonc} exist; Ryco cannot choose a write authority.` };
  }
  return hasJsonc ? { path: jsonc, readOnly: true } : { path: json, readOnly: false };
}

function nativeEntry(
  input: Parameters<NonNullable<ProviderMcpAdapter["upsertServer"]>>[0],
  current: unknown,
  generation: OpenCodeGeneration,
): Record<string, unknown> {
  const currentRecord = record(current) ?? {};
  const existing = decodeOpenCodeMcpServer(current, generation);
  const environment = applyProviderMcpSecretMutations(
    existing?.env ?? {},
    input.config.env,
    "env",
    input.secretMutations,
  );
  const headers = applyProviderMcpSecretMutations(
    existing?.httpHeaders ?? {},
    input.config.httpHeaders,
    "header",
    input.secretMutations,
  );
  const enableField =
    generation === "v2" ? { disabled: !input.config.enabled } : { enabled: input.config.enabled };
  const timeout = input.config.toolTimeoutSec ? input.config.toolTimeoutSec * 1_000 : undefined;
  if (input.config.transport === "stdio") {
    const command = input.config.command?.trim();
    if (!command) throw toMcpError("OpenCode local MCP servers require a command.");
    const next: Record<string, unknown> = {
      ...currentRecord,
      type: "local",
      command: [command, ...input.config.args],
      environment,
      ...enableField,
      ...(input.config.cwd ? { cwd: input.config.cwd } : {}),
      ...(timeout ? { timeout } : {}),
    };
    delete next.url;
    delete next.headers;
    return next;
  }
  if (input.config.transport === "http") {
    const url = input.config.url?.trim();
    if (!url) throw toMcpError("OpenCode remote MCP servers require a URL.");
    const next: Record<string, unknown> = {
      ...currentRecord,
      type: "remote",
      url,
      headers,
      ...enableField,
      ...(timeout ? { timeout } : {}),
    };
    delete next.command;
    delete next.environment;
    delete next.cwd;
    return next;
  }
  throw toMcpError("OpenCode does not support this MCP transport.");
}

export const makeOpenCodeMcpAdapter = (
  io: OpenCodeMcpAdapterIo = defaultIo,
  options: OpenCodeMcpAdapterOptions = {},
) =>
  Effect.gen(function* () {
    const managedGenerations = options.managedGenerations ?? DEFAULT_MANAGED_GENERATIONS;
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;

    const probeVersion = (binaryPath: string, processEnv: NodeJS.ProcessEnv) =>
      Effect.tryPromise({
        try: async () => {
          const result = await io.run(binaryPath, ["--version"], {
            cwd: serverConfig.cwd,
            env: processEnv,
            timeoutMs: VERSION_TIMEOUT_MS,
            maxBufferBytes: OUTPUT_LIMIT,
            outputMode: "truncate",
          });
          if (result.timedOut || result.code !== 0) return null;
          return classifyOpenCodeGeneration(parseGenericCliVersion(result.stdout));
        },
        catch: () => toMcpError("Failed to probe the OpenCode version."),
      });

    const discover = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const entries = Object.entries(deriveProviderInstanceConfigMap(settings)).filter(
        ([, instance]) => instance.driver === OPENCODE_DRIVER,
      );
      const runtimes = new Map<string, OpenCodeMcpRuntime>();
      const providers: McpProviderSupportType[] = [];
      const issues: McpListWorkspacesResult["issues"][number][] = [];
      for (const [rawInstanceId, instance] of entries) {
        const instanceId = rawInstanceId as ProviderInstanceId;
        const enabled = instance.enabled ?? true;
        const decoded = Schema.decodeUnknownExit(OpenCodeSettings)(instance.config ?? {});
        if (Exit.isFailure(decoded)) {
          issues.push({ instanceId, message: "OpenCode settings could not be decoded." });
          continue;
        }
        const processEnv = mergeProviderInstanceEnvironment(instance.environment);
        const detectedGeneration = enabled
          ? yield* probeVersion(decoded.value.binaryPath, processEnv).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
        // A detected but unmanaged generation is handled exactly like an unknown one.
        const generation =
          detectedGeneration !== null && managedGenerations.includes(detectedGeneration)
            ? detectedGeneration
            : null;
        const homePath = processEnv.HOME?.trim() || os.homedir();
        const configHome = processEnv.XDG_CONFIG_HOME?.trim() || path.join(homePath, ".config");
        const customPath = processEnv.OPENCODE_CONFIG?.trim();
        const globalTarget = generation
          ? yield* Effect.tryPromise({
              try: () => resolveConfigPath(io, path.join(configHome, "opencode"), customPath),
              catch: (cause) => toMcpError("Failed to resolve OpenCode configuration.", cause),
            })
          : null;
        const usable =
          generation !== null && globalTarget !== null && !("conflict" in globalTarget);
        const capabilities = usable
          ? globalTarget.readOnly
            ? readOnlyCapabilities
            : writableCapabilities
          : Schema.decodeSync(McpProviderCapabilities)({});
        const workspaceId = usable ? workspaceIdFor(globalTarget.path, generation) : undefined;
        providers.push(
          Schema.decodeSync(McpProviderSupport)({
            instanceId,
            driver: OPENCODE_DRIVER,
            ...(instance.displayName ? { displayName: instance.displayName } : {}),
            ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
            enabled,
            status: usable ? (globalTarget.readOnly ? "external" : "managed") : "unsupported",
            capabilities,
            ...(workspaceId ? { workspaceId } : {}),
            message: !enabled
              ? "This OpenCode provider instance is disabled."
              : !generation
                ? detectedGeneration === "v2"
                  ? UNMANAGED_V2_MESSAGE
                  : UNKNOWN_GENERATION_MESSAGE
                : globalTarget && "conflict" in globalTarget
                  ? globalTarget.conflict
                  : globalTarget?.readOnly
                    ? "OpenCode JSONC is visible but read-only because lossless comment editing is unavailable."
                    : `Ryco manages recognized OpenCode ${generation.toUpperCase()} JSON configuration.`,
          }),
        );
        if (!usable || !workspaceId) {
          if (enabled && globalTarget && "conflict" in globalTarget) {
            issues.push({ instanceId, message: globalTarget.conflict });
          }
          continue;
        }
        const usage = {
          instanceId,
          ...(instance.displayName ? { displayName: instance.displayName } : {}),
          ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
        };
        const targets: Array<{
          id: McpWorkspaceId;
          configPath: string;
          source: "user" | "project";
          readOnly: boolean;
          capabilities: typeof McpProviderCapabilities.Type;
        }> = [
          {
            id: workspaceId,
            configPath: globalTarget.path,
            source: "user" as const,
            readOnly: globalTarget.readOnly,
            capabilities,
          },
        ];
        if (!customPath) {
          const projectTarget = yield* Effect.tryPromise({
            try: () => resolveConfigPath(io, serverConfig.cwd),
            catch: (cause) => toMcpError("Failed to resolve OpenCode project config.", cause),
          });
          if (!("conflict" in projectTarget)) {
            const projectCaps = projectTarget.readOnly
              ? readOnlyCapabilities
              : Schema.decodeSync(McpProviderCapabilities)({
                  ...writableCapabilities,
                  externalAgentControl: "unavailable",
                  scopes: ["project"],
                });
            targets.push({
              id: workspaceIdFor(projectTarget.path, generation),
              configPath: projectTarget.path,
              source: "project",
              readOnly: projectTarget.readOnly,
              capabilities: projectCaps,
            });
          } else {
            issues.push({ instanceId, message: projectTarget.conflict });
          }
        }
        for (const target of targets) {
          const existing = runtimes.get(target.id);
          if (existing) {
            runtimes.set(target.id, {
              ...existing,
              workspace: {
                ...existing.workspace,
                providerInstances: [...existing.workspace.providerInstances, usage],
              },
            });
            continue;
          }
          runtimes.set(target.id, {
            configPath: target.configPath,
            source: target.source,
            generation,
            readOnly: target.readOnly,
            workspace: Schema.decodeSync(McpWorkspace)({
              id: target.id,
              driver: OPENCODE_DRIVER,
              providerDisplayName: "OpenCode",
              displayPath: target.configPath,
              nativeScope: target.source,
              formatGeneration: `opencode-${generation}-${target.readOnly ? "jsonc-readonly" : "json"}`,
              capabilities: target.capabilities,
              providerMetadata: { configPath: target.configPath, generation },
              sharedHomePath: homePath,
              mode: "direct",
              selectedInstanceId: instanceId,
              providerInstances: [usage],
            }),
          });
        }
      }
      return { runtimes: [...runtimes.values()], providers, issues };
    }).pipe(
      Effect.mapError((cause) => toMcpError("Failed to discover OpenCode MCP profiles.", cause)),
    );

    const findRuntime = (workspaceId: McpWorkspaceId) =>
      discover.pipe(
        Effect.flatMap(({ runtimes }) => {
          const runtime = runtimes.find((entry) => entry.workspace.id === workspaceId);
          return runtime
            ? Effect.succeed(runtime)
            : Effect.fail(toMcpError("OpenCode MCP workspace not found."));
        }),
      );

    const readDocument = (runtime: OpenCodeMcpRuntime) =>
      Effect.tryPromise({
        try: async () =>
          runtime.readOnly
            ? { value: await io.readJsonc(runtime.configPath), snapshot: null }
            : (() =>
                io
                  .readJson(runtime.configPath)
                  .then((snapshot) => ({ value: snapshot.value, snapshot })))(),
        catch: (cause) => toMcpError("Failed to read OpenCode MCP configuration.", cause),
      });

    const listServers: NonNullable<ProviderMcpAdapter["listServers"]> = (input) =>
      Effect.gen(function* () {
        const runtime = yield* findRuntime(input.workspaceId);
        const { value } = yield* readDocument(runtime);
        const native = serverMap(value, runtime.generation);
        const servers: Array<typeof McpServer.Type> = [];
        const warnings: string[] = [];
        for (const [name, entry] of Object.entries(native)) {
          if (!Schema.is(McpServerName)(name)) continue;
          const config = decodeOpenCodeMcpServer(entry, runtime.generation);
          if (!config) {
            warnings.push(`OpenCode MCP server ${name} uses an unsupported or malformed format.`);
            continue;
          }
          servers.push(
            Schema.decodeSync(McpServer)({
              name,
              config: {
                ...config,
                env: {},
                httpHeaders: {},
                secretFields: providerMcpSecretPresence([
                  { prefix: "env", values: config.env },
                  { prefix: "header", values: config.httpHeaders },
                ]),
              },
              source: runtime.source,
              startupStatus: config.enabled ? "unknown" : "disabled",
              authStatus: "unknown",
              tools: [],
              resources: [],
              resourceTemplates: [],
            }),
          );
        }
        return Schema.decodeSync(McpListServersResult)({
          workspace: runtime.workspace,
          servers,
          configPath: runtime.configPath,
          warnings,
        });
      });

    const mutate = (
      input: { readonly workspaceId: McpWorkspaceId },
      change: (
        runtime: OpenCodeMcpRuntime,
        document: Record<string, unknown>,
        servers: Record<string, unknown>,
      ) => Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const runtime = yield* findRuntime(input.workspaceId);
        if (runtime.readOnly) {
          return yield* Effect.fail(
            toMcpError(
              "OpenCode JSONC profiles are read-only to preserve comments and formatting.",
            ),
          );
        }
        const { value, snapshot } = yield* readDocument(runtime);
        if (!snapshot) return yield* Effect.fail(toMcpError("OpenCode writable snapshot missing."));
        const servers = serverMap(value, runtime.generation);
        const nextServers = yield* Effect.try({
          try: () => change(runtime, value, servers),
          catch: (cause) =>
            Schema.is(McpSettingsError)(cause)
              ? cause
              : toMcpError("Failed to translate OpenCode MCP configuration.", cause),
        });
        yield* Effect.tryPromise({
          try: () => io.writeJson(snapshot, withServerMap(value, runtime.generation, nextServers)),
          catch: (cause) => toMcpError("Failed to update OpenCode MCP configuration.", cause),
        });
        return { runtime, nextServers };
      });

    const upsertServer: NonNullable<ProviderMcpAdapter["upsertServer"]> = (input) =>
      Effect.gen(function* () {
        const { runtime, nextServers } = yield* mutate(input, (target, _document, servers) => {
          const entry = nativeEntry(input, servers[input.name], target.generation);
          return { ...servers, [input.name]: entry };
        });
        const native = serverMap((yield* readDocument(runtime)).value, runtime.generation)[
          input.name
        ];
        const written = decodeOpenCodeMcpServer(native, runtime.generation);
        const desired = decodeOpenCodeMcpServer(nextServers[input.name], runtime.generation);
        if (
          !written ||
          !desired ||
          providerMcpConfigFingerprint(written) !== providerMcpConfigFingerprint(desired)
        ) {
          return yield* Effect.fail(toMcpError("OpenCode MCP update could not be verified."));
        }
        return yield* listServers({ workspaceId: input.workspaceId, detail: "full" });
      });

    const setServerEnabled: NonNullable<ProviderMcpAdapter["setServerEnabled"]> = (input) =>
      mutate(input, (runtime, _document, servers) => {
        const current = record(servers[input.name]);
        if (!current) throw toMcpError("OpenCode MCP server not found.");
        return {
          ...servers,
          [input.name]: {
            ...current,
            ...(runtime.generation === "v2"
              ? { disabled: !input.enabled }
              : { enabled: input.enabled }),
          },
        };
      }).pipe(
        Effect.flatMap(() => listServers({ workspaceId: input.workspaceId, detail: "full" })),
      );

    const removeServer: NonNullable<ProviderMcpAdapter["removeServer"]> = (input) =>
      mutate(input, (_runtime, _document, servers) => {
        const next = { ...servers };
        delete next[input.name];
        return next;
      }).pipe(
        Effect.flatMap(() => listServers({ workspaceId: input.workspaceId, detail: "full" })),
      );

    return {
      driver: OPENCODE_DRIVER,
      capabilities: writableCapabilities,
      listWorkspaces: discover.pipe(
        Effect.map(({ runtimes, providers, issues }) => ({
          workspaces: runtimes.map((runtime) => runtime.workspace),
          providers,
          issues,
        })),
      ),
      listServers,
      upsertServer,
      setServerEnabled,
      removeServer,
      externalAgentControl: makeProviderMcpExternalAgentControl({
        listServers,
        upsertServer,
        removeServer,
      }),
    } satisfies ProviderMcpAdapter;
  });
