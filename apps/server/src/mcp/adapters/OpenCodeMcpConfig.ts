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
  describeUnsupportedOpenCodeVersion,
  OPENCODE_V2_ADVISORY_MESSAGE,
  OPENCODE_V2_RUNTIME_SUPPORTED,
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
import {
  OPENCODE_MCP_CAPABILITIES as writableCapabilities,
  OPENCODE_MCP_DRIVER as OPENCODE_DRIVER,
} from "./OpenCodeMcpAdapter.ts";

const VERSION_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 256 * 1024;
/** Ryco edits OpenCode 2.x configuration while it runs OpenCode 2.x: the kill switch stops both. */
const DEFAULT_MANAGED_GENERATIONS: ReadonlyArray<OpenCodeGeneration> = OPENCODE_V2_RUNTIME_SUPPORTED
  ? ["v1", "v2"]
  : ["v1"];
const UNKNOWN_GENERATION_MESSAGE =
  "This OpenCode version is unknown or unavailable, so Ryco will not mutate its config.";
/**
 * Both generations read the same files, but 1.x rejects the 2.x `mcp.servers` key (it reads it as a
 * server named `servers`), so Ryco edits a file that both a 1.x and a 2.x instance read for neither.
 */
const mixedGenerationsMessage = (configPath: string) =>
  `OpenCode 1.x and 2.x instances share ${configPath}. Ryco edits it for neither, because 1.x cannot read the 2.x MCP format.`;

export interface OpenCodeMcpAdapterOptions {
  /** Generations whose native config Ryco may manage. Default: DEFAULT_MANAGED_GENERATIONS. */
  readonly managedGenerations?: ReadonlyArray<OpenCodeGeneration>;
}

const readOnlyCapabilities = Schema.decodeSync(McpProviderCapabilities)({
  readConfiguration: "available",
  externalAgentControl: "unavailable",
  automaticAgentControl: "unavailable",
  scopes: ["user"],
});
const unsupportedCapabilities = Schema.decodeSync(McpProviderCapabilities)({});

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

function seconds(value: unknown, key: "startupTimeoutSec" | "toolTimeoutSec") {
  return typeof value === "number" && value > 0 ? { [key]: value / 1_000 } : {};
}

function milliseconds(value: number | undefined): number | undefined {
  // Both generations take whole positive milliseconds only.
  return value ? Math.max(1, Math.round(value * 1_000)) : undefined;
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
  // 1.x has one request timeout. 2.x bounds `startup`, `catalog` and `execution` (tool calls) on
  // their own and still reads a bare 1.x number as the bound of every phase.
  const phases =
    generation === "v2"
      ? (record(entry.timeout) ?? { startup: entry.timeout, execution: entry.timeout })
      : { execution: entry.timeout };
  const timeouts = {
    ...seconds(phases.startup, "startupTimeoutSec"),
    ...seconds(phases.execution, "toolTimeoutSec"),
  };
  if (entry.type === "remote" && typeof entry.url === "string") {
    return Schema.decodeSync(McpServerWritableConfig)({
      transport: "http",
      url: entry.url,
      httpHeaders: headers,
      enabled,
      ...timeouts,
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
      ...timeouts,
    });
  }
  return null;
}

/**
 * A 1.x entry as 2.x reads it (its `migrateMcp`): `disabled` instead of `enabled`, snake_case OAuth
 * keys.
 */
function legacyEntryAsV2({ enabled, oauth, ...entry }: Record<string, unknown>) {
  const auth = record(oauth);
  return {
    ...entry,
    ...(enabled === false ? { disabled: true } : {}),
    ...(auth
      ? {
          oauth: Object.fromEntries(
            Object.entries(auth).map(([key, item]) => [
              key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
              item,
            ]),
          ),
        }
      : oauth === undefined
        ? {}
        : { oauth }),
  };
}

/**
 * The servers a generation runs from one document. 2.x also runs the 1.x-shaped entries left
 * directly under `mcp`, read in its own shape, and its `mcp.servers` entry wins a name clash.
 */
function serverMap(document: Record<string, unknown>, generation: OpenCodeGeneration) {
  const mcp = record(document.mcp) ?? {};
  if (generation === "v1") return mcp;
  const legacy = Object.entries(mcp)
    .filter(([name]) => name !== "servers" && name !== "timeout")
    .map(([name, value]) => {
      const entry = record(value);
      return [name, entry ? legacyEntryAsV2(entry) : value] as const;
    });
  return { ...Object.fromEntries(legacy), ...record(mcp.servers) };
}

/**
 * Writes `servers` over `previous` (both from {@link serverMap}). Under 2.x only the entries that
 * changed move into `mcp.servers`, replacing a 1.x-shaped entry of the same name; untouched 1.x
 * entries stay where they are.
 */
function withServerMap(
  document: Record<string, unknown>,
  generation: OpenCodeGeneration,
  previous: Record<string, unknown>,
  servers: Record<string, unknown>,
): Record<string, unknown> {
  if (generation === "v1") return { ...document, mcp: servers };
  const mcp: Record<string, unknown> = { ...record(document.mcp) };
  const native: Record<string, unknown> = { ...record(mcp.servers) };
  for (const name of new Set([...Object.keys(previous), ...Object.keys(servers)])) {
    if (servers[name] === previous[name]) continue;
    if (name !== "servers" && name !== "timeout") delete mcp[name];
    if (Object.hasOwn(servers, name)) native[name] = servers[name];
    else delete native[name];
  }
  return { ...document, mcp: { ...mcp, servers: native } };
}

function workspaceIdFor(configPath: string, generation: OpenCodeGeneration): McpWorkspaceId {
  return McpWorkspaceId.make(
    `opencode:${createHash("sha256").update(`${generation}\0${configPath}`, "utf8").digest("base64url")}`,
  );
}

/** The config files both generations read from a directory. */
const configFiles = (directory: string) =>
  [path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc")] as const;

async function resolveConfigPath(
  io: OpenCodeMcpAdapterIo,
  basePath: string,
  customPath?: string,
): Promise<{ path: string; readOnly: boolean } | { conflict: string }> {
  if (customPath) return { path: customPath, readOnly: customPath.endsWith(".jsonc") };
  const [json, jsonc] = configFiles(basePath);
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
  const startup = milliseconds(input.config.startupTimeoutSec);
  const execution = milliseconds(input.config.toolTimeoutSec);
  const bound = currentRecord.timeout;
  // A 2.x phase Ryco has no field for keeps its value, also when a bare 1.x number set it.
  const timeout =
    generation === "v1"
      ? execution
      : startup || execution
        ? {
            ...(typeof bound === "number"
              ? { startup: bound, catalog: bound, execution: bound }
              : record(bound)),
            ...(startup ? { startup } : {}),
            ...(execution ? { execution } : {}),
          }
        : undefined;
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

/** The adapter itself; `makeOpenCodeMcpAdapter` (`OpenCodeMcpAdapter.ts`) loads it on first use. */
export const makeOpenCodeMcpConfigAdapter = (
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
          return parseGenericCliVersion(result.stdout);
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
      /** The generations of the managed instances that read each config file. */
      const readers = new Map<string, Set<OpenCodeGeneration>>();
      for (const [rawInstanceId, instance] of entries) {
        const instanceId = rawInstanceId as ProviderInstanceId;
        const enabled = instance.enabled ?? true;
        const decoded = Schema.decodeUnknownExit(OpenCodeSettings)(instance.config ?? {});
        if (Exit.isFailure(decoded)) {
          issues.push({ instanceId, message: "OpenCode settings could not be decoded." });
          continue;
        }
        const processEnv = mergeProviderInstanceEnvironment(instance.environment);
        const version = enabled
          ? yield* probeVersion(decoded.value.binaryPath, processEnv).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
        const detectedGeneration = classifyOpenCodeGeneration(version);
        // The runtime's 2.x floor: Ryco writes the 2.x format only for the releases it runs.
        const refusal =
          version !== null && detectedGeneration === "v2" && managedGenerations.includes("v2")
            ? describeUnsupportedOpenCodeVersion(version, "binary")
            : null;
        // A detected but unmanaged or refused generation is handled exactly like an unknown one.
        const generation =
          detectedGeneration !== null &&
          refusal === null &&
          managedGenerations.includes(detectedGeneration)
            ? detectedGeneration
            : null;
        const homePath = processEnv.HOME?.trim() || os.homedir();
        const configHome = processEnv.XDG_CONFIG_HOME?.trim() || path.join(homePath, ".config");
        const customPath = processEnv.OPENCODE_CONFIG?.trim();
        const configDirectory = processEnv.OPENCODE_CONFIG_DIR?.trim();
        // OpenCode 2 reads its global profile from OPENCODE_CONFIG_DIR instead of the XDG
        // directory; 1.x reads that directory on top of it.
        const globalDirectory =
          generation === "v2" && configDirectory
            ? configDirectory
            : path.join(configHome, "opencode");
        if (generation) {
          const directories = [globalDirectory, serverConfig.cwd];
          if (generation === "v1" && configDirectory) directories.push(configDirectory);
          for (const file of [
            ...directories.flatMap(configFiles),
            ...(customPath ? [customPath] : []),
          ]) {
            readers.set(file, (readers.get(file) ?? new Set()).add(generation));
          }
        }
        const globalTarget = generation
          ? yield* Effect.tryPromise({
              try: () => resolveConfigPath(io, globalDirectory, customPath),
              catch: (cause) => toMcpError("Failed to resolve OpenCode configuration.", cause),
            })
          : null;
        const usable =
          generation !== null && globalTarget !== null && !("conflict" in globalTarget);
        const capabilities = usable
          ? globalTarget.readOnly
            ? readOnlyCapabilities
            : writableCapabilities
          : unsupportedCapabilities;
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
                ? (refusal ??
                  (detectedGeneration === "v2"
                    ? OPENCODE_V2_ADVISORY_MESSAGE
                    : UNKNOWN_GENERATION_MESSAGE))
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
      // Same-generation instances share a workspace above. A file that instances of both
      // generations read is dropped for every instance that edits it, and an instance whose own
      // profile it was becomes unsupported.
      for (const [id, runtime] of runtimes) {
        if ((readers.get(runtime.configPath)?.size ?? 0) < 2) continue;
        const message = mixedGenerationsMessage(runtime.configPath);
        runtimes.delete(id);
        for (const { instanceId } of runtime.workspace.providerInstances) {
          issues.push({ instanceId, message });
        }
        for (const [index, { workspaceId, ...provider }] of providers.entries()) {
          if (workspaceId !== id) continue;
          providers[index] = {
            ...provider,
            status: "unsupported",
            capabilities: unsupportedCapabilities,
            message,
          };
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
          try: () =>
            io.writeJson(snapshot, withServerMap(value, runtime.generation, servers, nextServers)),
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
