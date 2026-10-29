/**
 * Provider-neutral MCP gateway for the iOS Simulator tools.
 *
 * Adapted from Synara v0.7.2's agent gateway device catalogue. Ryco's
 * providers speak several different native protocols, so the catalogue is
 * served once over a loopback-only, bearer-bound Streamable HTTP endpoint.
 * Each binding belongs to one Ryco thread and is accepted only while that
 * provider reports an active turn.
 *
 * What each tool does lives in `deviceToolActions.ts`, loaded with the first
 * call; inputs return the settled screen as evidence, and the first
 * successful result of a binding carries the driving guide.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { DeviceRpcError } from "@ryco/contracts";
import { Schema } from "effect";

import type { DeviceManager } from "../device/DeviceManager.ts";
import type { DeviceSettleTiming, DeviceToolContent } from "../device/deviceObservation.ts";

export type { DeviceToolContent } from "../device/deviceObservation.ts";

/** One cached `import()`; a failed load is retried on the next call. */
function lazyModule<A>(load: () => Promise<A>): () => Promise<A> {
  let pending: Promise<A> | null = null;
  return () =>
    (pending ??= load().catch((error: unknown) => {
      pending = null;
      throw error;
    }));
}

// What each tool does (with settling and evidence) and the driving guide load
// with the first device tool call, the catalogue with the first `tools/list`.
// The gateway starts with every server, so they stay off its boot graph.
const loadActions = lazyModule(() => import("./deviceToolActions.ts"));
const loadGuidance = lazyModule(() => import("./deviceToolGuidance.ts"));
const loadDefinitions = lazyModule(() => import("./deviceToolDefinitions.ts"));

export const DEVICE_TOOL_NAMES = [
  "device_list",
  "device_boot",
  "device_install",
  "device_launch",
  "device_open_url",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_press_button",
  "device_screenshot",
  "device_describe_ui",
  "device_scroll_to_element",
  "device_wait",
  "device_logs",
  "device_configure",
] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

const APPROVAL_REQUIRED = new Set<DeviceToolName>([
  "device_boot",
  "device_install",
  "device_launch",
  "device_open_url",
  "device_tap",
  "device_swipe",
  "device_type",
  "device_press_button",
  "device_scroll_to_element",
  "device_configure",
]);

const AGENT_CONTROL_SAFE_LEGACY_TOOLS = new Set<DeviceToolName>(["device_list"]);

/** An Agent Control lease holding a thread's gateway tools. */
export interface AgentControlDeviceLock {
  readonly leaseId: string;
  /** The lease grants Agent Control device control, so the session has `ryco_device`. */
  readonly agentControlDevices: boolean;
}

const agentControlLocksByThread = new Map<string, AgentControlDeviceLock>();

/** Agent Control's own device tool (`agentControl/Mcp/deviceRoutineTools.ts`). */
export const AGENT_CONTROL_DEVICE_TOOL = "ryco_device";

/** Added to `device_list` while Agent Control drives this session's devices. */
export const AGENT_CONTROL_DEVICE_POINTER = `Agent Control is on for this session: drive the attached device with ${AGENT_CONTROL_DEVICE_TOOL} and request boot, attach, install, URLs or shutdown with ryco_propose_device_*.`;

const agentControlRefusal = (lock: AgentControlDeviceLock): string =>
  lock.agentControlDevices
    ? `Agent Control drives devices in this session: use ${AGENT_CONTROL_DEVICE_TOOL} for input on the device attached to this thread (it asks the user once per task) and ryco_propose_device_* for boot, attach, install, URLs and shutdown.`
    : // A Computer Use lease (OpenCode) offers no device tools at all.
      "Device tools are unavailable in this session while Agent Control runs Computer Use.";

/**
 * Suppress the legacy direct device catalog while the same thread owns an
 * Agent Control session. `agentControlDevices` says whether that session can
 * drive devices itself, which decides where the refusal points. The returned
 * release is idempotent and lease-scoped.
 */
export function blockProcessDeviceToolsForAgentControl(
  threadId: string,
  leaseId: string,
  options: { readonly agentControlDevices: boolean },
): () => void {
  // A thread has one authoritative provider runtime. Installing its successor
  // supersedes any lock whose registry lease was synchronously revoked, and
  // its grant replaces the old one.
  const lock: AgentControlDeviceLock = {
    leaseId,
    agentControlDevices: options.agentControlDevices,
  };
  agentControlLocksByThread.set(threadId, lock);
  return () => {
    if (agentControlLocksByThread.get(threadId) === lock)
      agentControlLocksByThread.delete(threadId);
  };
}

/** The Agent Control lease holding this thread's gateway tools, if any. */
export function agentControlDeviceLockFor(threadId: string): AgentControlDeviceLock | null {
  return agentControlLocksByThread.get(threadId) ?? null;
}

export function deviceToolRequiresApproval(name: string): boolean {
  return APPROVAL_REQUIRED.has(name as DeviceToolName);
}

const isDeviceRpcError = Schema.is(DeviceRpcError);

const RECOVERABLE_AGENT_ERRORS = [
  /appears to be at its end/iu,
  /no element (?:matching|labelled|labeled)/iu,
  /matched more than one element/iu,
  /is not visible on screen/iu,
  /out of reach/iu,
  /scrolling stopped moving/iu,
  // Transport bounds and platform refusals: the device itself is fine.
  /too large/iu,
  /needs the accessibility tree/iu,
  /unavailable on SSH hosts/iu,
  /require an iOS simulator|available for iOS simulators on this node/iu,
  /is not installed on this simulator/iu,
] as const;

/** A malformed tool argument: the agent's to fix, never a device failure. */
export class DeviceToolArgumentError extends Error {
  override readonly name = "DeviceToolArgumentError";
}

/**
 * "require-attached" refused the device: it is not (or no longer) attached to
 * this thread alone. Nothing reached it, and nothing is wrong with it.
 */
export class DeviceAttachmentFenceError extends Error {
  override readonly name = "DeviceAttachmentFenceError";
}

/**
 * Tool-local navigation misses belong in the agent's tool result. Persisting
 * them as pane failures would replace a still-healthy simulator with a red
 * error state just because an accessibility lookup needs another attempt.
 */
export function isViewerFacingDeviceToolError(error: unknown): boolean {
  if (error instanceof DeviceToolArgumentError || error instanceof DeviceAttachmentFenceError)
    return false;
  // A backend refusing malformed input (a simulator setting it cannot plan)
  // says nothing about the device's health either.
  if (isDeviceRpcError(error) && error.code === "invalid-input") return false;
  const message = error instanceof Error ? error.message : String(error);
  return !RECOVERABLE_AGENT_ERRORS.some((pattern) => pattern.test(message));
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceToolArgumentError("Tool arguments must be a JSON object.");
  }
  return value as JsonRecord;
}

export interface DeviceToolCallInput {
  readonly manager: DeviceManager;
  readonly threadId: string;
  readonly name: DeviceToolName;
  readonly args: Record<string, unknown>;
  /**
   * "attach-if-free" (the gateway's default) attaches the thread to the
   * device it drives when the thread has none. "require-attached" (Agent
   * Control) never attaches, and drives a device only while this thread
   * alone has it attached: checked when the call starts and again right
   * before every input, so a detach (or another thread attaching) during
   * the call stops it with a `DeviceAttachmentFenceError`.
   */
  readonly attachment?: "attach-if-free" | "require-attached" | undefined;
  /** Aborts every settle loop when the caller goes away. */
  readonly signal?: AbortSignal | undefined;
  /** Largest base64 image the transport carries; defaults to the gateway's 4 MiB of PNG. */
  readonly maxImageBase64Chars?: number | undefined;
  /** Tests shrink the settle windows. */
  readonly timing?: Partial<DeviceSettleTiming> | undefined;
}

/**
 * Run one device tool and return its MCP content. Inputs wait for the screen
 * to settle and return it as evidence. Errors throw; `callDeviceTool` turns
 * them into tool results.
 */
export async function executeDeviceTool(
  input: DeviceToolCallInput,
): Promise<readonly DeviceToolContent[]> {
  const { runDeviceTool } = await loadActions();
  const udid = input.args.udid;
  // The device the call names is held while it runs and, after it, for the
  // thread's running provider turn; `device_list` names none.
  return input.manager.withAgentActivity(
    input.threadId,
    async () => {
      input.signal?.throwIfAborted();
      return await runDeviceTool(input);
    },
    typeof udid === "string" && udid.trim().length > 0 ? { udid } : undefined,
  );
}

/**
 * `executeDeviceTool` plus the error mapping every transport shares: failures
 * become tool results, and only real device trouble reaches the pane's error
 * state (never a call the caller abandoned).
 */
export async function callDeviceTool(
  input: DeviceToolCallInput,
): Promise<{ readonly content: readonly DeviceToolContent[]; readonly isError?: true }> {
  try {
    return { content: await executeDeviceTool(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.signal?.aborted !== true && isViewerFacingDeviceToolError(error)) {
      await input.manager.recordThreadError(input.threadId, message).catch(() => undefined);
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

interface BindingRecord {
  readonly threadId: string;
  readonly isTurnActive: () => boolean;
  /** Set once the driving guide went out with a successful result. */
  guided: boolean;
  /** Running `tools/call`s by JSON-RPC id, so `notifications/cancelled` can stop one. */
  readonly inFlight: Map<string, AbortController>;
}

/** A JSON-RPC request id as a map key; ids are strings or numbers, kept apart. */
function requestKey(id: unknown): string | null {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  return null;
}

export interface DeviceToolBinding {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly dispose: () => void;
}

export interface DeviceToolGateway {
  readonly createBinding: (input: {
    readonly threadId: string;
    readonly isTurnActive: () => boolean;
  }) => DeviceToolBinding;
  readonly close: () => Promise<void>;
}

let processGateway: DeviceToolGateway | null = null;

export function installProcessDeviceToolGateway(gateway: DeviceToolGateway | null): void {
  processGateway = gateway;
}

export function createProcessDeviceToolBinding(input: {
  readonly threadId: string;
  readonly isTurnActive: () => boolean;
}): DeviceToolBinding | null {
  return processGateway?.createBinding(input) ?? null;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 1024 * 1024) throw new Error("MCP request body is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

function mcpSuccess(id: unknown, result: unknown): JsonRecord {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id: unknown, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function startDeviceToolGateway(
  manager: DeviceManager,
  options: { readonly timing?: Partial<DeviceSettleTiming> | undefined } = {},
): Promise<DeviceToolGateway> {
  const bindings = new Map<string, BindingRecord>();
  /** Every running `tools/call`, so closing the gateway can stop them all. */
  const running = new Set<AbortController>();
  let baseUrl = "";

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET") return empty(response, 405);
      if (request.method === "DELETE") return empty(response, 405);
      if (request.method !== "POST" || request.url !== "/mcp") return empty(response, 404);

      const binding = bindings.get(bearerToken(request) ?? "");
      if (!binding) return empty(response, 401);

      let payload: unknown;
      try {
        payload = await readJsonBody(request);
      } catch (error) {
        return json(
          response,
          400,
          mcpError(null, -32700, error instanceof Error ? error.message : "Invalid JSON."),
        );
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return json(response, 400, mcpError(null, -32600, "Invalid JSON-RPC request."));
      }
      const message = payload as JsonRecord;
      const id = message.id;
      const method = message.method;
      if (typeof method !== "string")
        return json(response, 400, mcpError(id, -32600, "Missing method."));

      if (method === "notifications/cancelled") {
        // A client that cancels without dropping its connection (Streamable
        // HTTP allows both) must stop the call's settle or wait as well.
        const params = message.params;
        const key =
          params && typeof params === "object" && !Array.isArray(params)
            ? requestKey((params as JsonRecord).requestId)
            : null;
        if (key !== null) binding.inFlight.get(key)?.abort();
        return empty(response, 202);
      }
      if (method === "notifications/initialized") return empty(response, 202);
      if (method === "initialize") {
        const requested = asRecord(message.params ?? {}).protocolVersion;
        return json(
          response,
          200,
          mcpSuccess(id, {
            protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "ryco-device", version: "1.0.0" },
          }),
        );
      }
      if (method === "ping") return json(response, 200, mcpSuccess(id, {}));
      if (method === "tools/list") {
        const { DEVICE_TOOL_DEFINITIONS } = await loadDefinitions();
        const tools =
          agentControlDeviceLockFor(binding.threadId) !== null
            ? DEVICE_TOOL_DEFINITIONS.filter((tool) =>
                AGENT_CONTROL_SAFE_LEGACY_TOOLS.has(tool.name),
              )
            : DEVICE_TOOL_DEFINITIONS;
        return json(response, 200, mcpSuccess(id, { tools }));
      }
      if (method !== "tools/call") {
        return json(
          response,
          200,
          mcpError(id, -32601, `Unsupported method ${JSON.stringify(method)}.`),
        );
      }
      if (!binding.isTurnActive()) {
        return json(
          response,
          200,
          mcpSuccess(id, {
            isError: true,
            content: [
              { type: "text", text: "Device tools are only available during an active Ryco turn." },
            ],
          }),
        );
      }

      const params = asRecord(message.params ?? {});
      const name = params.name;
      if (typeof name !== "string" || !DEVICE_TOOL_NAMES.includes(name as DeviceToolName)) {
        return json(response, 200, mcpError(id, -32602, "Unknown device tool."));
      }
      const lock = agentControlDeviceLockFor(binding.threadId);
      if (lock !== null && !AGENT_CONTROL_SAFE_LEGACY_TOOLS.has(name as DeviceToolName)) {
        return json(
          response,
          200,
          mcpSuccess(id, {
            isError: true,
            content: [{ type: "text", text: agentControlRefusal(lock) }],
          }),
        );
      }
      let args: JsonRecord;
      try {
        args = asRecord(params.arguments ?? {});
      } catch (error) {
        return json(
          response,
          200,
          mcpSuccess(id, {
            isError: true,
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          }),
        );
      }
      // A provider that drops the request (Stop, a crash, its own timeout) or
      // cancels it, or the gateway closing, must not leave a settle loop
      // polling the device after nobody is listening.
      const controller = new AbortController();
      const onClose = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once("close", onClose);
      const key = requestKey(id);
      if (key !== null) binding.inFlight.set(key, controller);
      running.add(controller);
      try {
        const result = await callDeviceTool({
          manager,
          threadId: binding.threadId,
          name: name as DeviceToolName,
          args,
          signal: controller.signal,
          timing: options.timing,
        });
        let content = result.content;
        const lockAfter = agentControlDeviceLockFor(binding.threadId);
        if (lockAfter !== null) {
          // Agent Control holds the thread: its own tools drive the device, so the
          // gateway's guide (which names tools hidden here) stays back.
          if (lockAfter.agentControlDevices && result.isError !== true) {
            content = [...content, { type: "text", text: AGENT_CONTROL_DEVICE_POINTER }];
          }
        } else if (result.isError !== true && !binding.guided) {
          // Claimed before the await, so concurrent first calls send it once.
          binding.guided = true;
          const guidance = await loadGuidance().catch(() => null);
          if (guidance !== null) {
            content = [
              { type: "text", text: guidance.deviceDrivingGuide(guidance.GATEWAY_GUIDE_NAMES) },
              ...content,
            ];
          }
        }
        return json(
          response,
          200,
          mcpSuccess(id, { content, ...(result.isError === true ? { isError: true } : {}) }),
        );
      } finally {
        response.off("close", onClose);
        running.delete(controller);
        if (key !== null && binding.inFlight.get(key) === controller) binding.inFlight.delete(key);
      }
    })().catch((error) => {
      if (!response.headersSent) json(response, 500, mcpError(null, -32603, String(error)));
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Device tool gateway did not receive a TCP address."));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resolve();
    });
  });

  return {
    createBinding: ({ threadId, isTurnActive }) => {
      const token = randomUUID();
      bindings.set(token, { threadId, isTurnActive, guided: false, inFlight: new Map() });
      return {
        url: baseUrl,
        headers: { Authorization: `Bearer ${token}` },
        dispose: () => {
          bindings.delete(token);
        },
      };
    },
    close: async () => {
      bindings.clear();
      // A wait (up to 30 s), a launch settle or a log read in flight would
      // otherwise hold shutdown, and the device manager's disposal of the
      // simulators Ryco booted behind it, past the desktop's kill grace.
      // Settles and waits stop at their next poll; a log read's simctl runs
      // out its own bound in the background, but no longer holds the close.
      for (const controller of running) controller.abort();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
