/**
 * Provider-neutral MCP gateway for the iOS Simulator tools.
 *
 * Adapted from Synara v0.7.2's agent gateway device catalogue. Ryco's
 * providers speak several different native protocols, so the catalogue is
 * served once over a loopback-only, bearer-bound Streamable HTTP endpoint.
 * Each binding belongs to one Ryco thread and is accepted only while that
 * provider reports an active turn.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  DEVICE_SCROLL_MAX_SWIPES,
  DEVICE_SCROLL_MIN_SWIPES,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
  type DeviceHardwareButton,
  type DeviceOpenPaneReason,
} from "@ryco/contracts";

import type { DeviceManager } from "../device/DeviceManager.ts";
import { readTapRequest } from "../device/uiTreeTargeting.ts";

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
]);

const AGENT_CONTROL_SAFE_LEGACY_TOOLS = new Set<DeviceToolName>(["device_list"]);
const agentControlLocksByThread = new Map<string, Set<string>>();

/**
 * Suppress the legacy direct device catalog while the same thread owns an
 * Agent Control session. The returned release is idempotent and lease-scoped.
 */
export function blockProcessDeviceToolsForAgentControl(
  threadId: string,
  leaseId: string,
): () => void {
  const locks = agentControlLocksByThread.get(threadId) ?? new Set<string>();
  // A thread has one authoritative provider runtime. Installing its successor
  // supersedes any lock whose registry lease was synchronously revoked.
  locks.clear();
  locks.add(leaseId);
  agentControlLocksByThread.set(threadId, locks);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = agentControlLocksByThread.get(threadId);
    current?.delete(leaseId);
    if (current?.size === 0) agentControlLocksByThread.delete(threadId);
  };
}

const agentControlBlocksLegacyTool = (threadId: string, name: DeviceToolName): boolean =>
  (agentControlLocksByThread.get(threadId)?.size ?? 0) > 0 &&
  !AGENT_CONTROL_SAFE_LEGACY_TOOLS.has(name);

export function deviceToolRequiresApproval(name: string): boolean {
  return APPROVAL_REQUIRED.has(name as DeviceToolName);
}

const RECOVERABLE_AGENT_ERRORS = [
  /appears to be at its end/iu,
  /no element (?:matching|labelled|labeled)/iu,
  /matched more than one element/iu,
  /is not visible on screen/iu,
  /out of reach/iu,
  /scrolling stopped moving/iu,
] as const;

/**
 * Tool-local navigation misses belong in the agent's tool result. Persisting
 * them as pane failures would replace a still-healthy simulator with a red
 * error state just because an accessibility lookup needs another attempt.
 */
export function isViewerFacingDeviceToolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !RECOVERABLE_AGENT_ERRORS.some((pattern) => pattern.test(message));
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const UDID = { type: "string", description: "Device udid from device_list." } as const;
const BUTTONS: readonly DeviceHardwareButton[] = [
  "home",
  "back",
  "recents",
  "lock",
  "volume-up",
  "volume-down",
];

export interface DeviceToolDefinition {
  readonly name: DeviceToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
}

export const DEVICE_TOOL_DEFINITIONS: readonly DeviceToolDefinition[] = [
  {
    name: "device_list",
    description:
      "List iOS simulators and Android emulators Ryco can drive, including runtime, boot state, and boot ownership. Call this before another device tool to get a udid.",
    inputSchema: {
      type: "object",
      properties: { includeShutdown: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { title: "List devices", ...READ_ONLY },
  },
  {
    name: "device_boot",
    description:
      "Boot an iOS simulator or Android emulator. Ryco caps its own boots; boot-limit-reached is a user decision, not something to retry.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID },
      required: ["udid"],
      additionalProperties: false,
    },
    annotations: { title: "Boot device", ...WRITE },
  },
  {
    name: "device_install",
    description:
      "Install a built iOS .app bundle or Android .apk on a booted device. Build the app first and pass its absolute path.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID, appPath: { type: "string" } },
      required: ["udid", "appPath"],
      additionalProperties: false,
    },
    annotations: { title: "Install app", ...WRITE },
  },
  {
    name: "device_launch",
    description: "Launch an installed app by bundle id on a booted simulator.",
    inputSchema: {
      type: "object",
      properties: {
        udid: UDID,
        bundleId: { type: "string" },
        arguments: { type: "array", items: { type: "string" } },
      },
      required: ["udid", "bundleId"],
      additionalProperties: false,
    },
    annotations: { title: "Launch app", ...WRITE },
  },
  {
    name: "device_open_url",
    description: "Open a URL or deep link on the simulator. This is an open-world action.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID, url: { type: "string" } },
      required: ["udid", "url"],
      additionalProperties: false,
    },
    annotations: { title: "Open URL", ...WRITE, openWorldHint: true },
  },
  {
    name: "device_tap",
    description:
      "Tap by accessibility label or raw device-point coordinates. Prefer label; Ryco resolves the element activation point and scrolls it into view.",
    inputSchema: {
      type: "object",
      properties: {
        udid: UDID,
        label: { type: "string" },
        role: { type: "string" },
        x: { type: "number", minimum: 0, maximum: 20_000 },
        y: { type: "number", minimum: 0, maximum: 20_000 },
      },
      required: ["udid"],
      additionalProperties: false,
    },
    annotations: { title: "Tap", ...WRITE },
  },
  {
    name: "device_swipe",
    description: "Swipe between two points on the simulator screen, measured in device points.",
    inputSchema: {
      type: "object",
      properties: {
        udid: UDID,
        fromX: { type: "number", minimum: 0, maximum: 20_000 },
        fromY: { type: "number", minimum: 0, maximum: 20_000 },
        toX: { type: "number", minimum: 0, maximum: 20_000 },
        toY: { type: "number", minimum: 0, maximum: 20_000 },
        durationMs: {
          type: "integer",
          minimum: DEVICE_SWIPE_DURATION_MIN_MS,
          maximum: DEVICE_SWIPE_DURATION_MAX_MS,
        },
      },
      required: ["udid", "fromX", "fromY", "toX", "toY"],
      additionalProperties: false,
    },
    annotations: { title: "Swipe", ...WRITE },
  },
  {
    name: "device_type",
    description: "Type text into the focused field. Tap the field first.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID, text: { type: "string" } },
      required: ["udid", "text"],
      additionalProperties: false,
    },
    annotations: { title: "Type text", ...WRITE },
  },
  {
    name: "device_press_button",
    description: "Press home, lock, volume-up, volume-down, or Android back/recents.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID, button: { type: "string", enum: [...BUTTONS] } },
      required: ["udid", "button"],
      additionalProperties: false,
    },
    annotations: { title: "Press hardware button", ...WRITE },
  },
  {
    name: "device_screenshot",
    description:
      "Capture the simulator screen as a PNG. Prefer device_describe_ui for locating controls.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID },
      required: ["udid"],
      additionalProperties: false,
    },
    annotations: { title: "Screenshot device", ...READ_ONLY },
  },
  {
    name: "device_describe_ui",
    description:
      "Read the accessibility tree with roles, labels, values, frames, and activation points. This is the canonical way to locate controls before tapping.",
    inputSchema: {
      type: "object",
      properties: { udid: UDID },
      required: ["udid"],
      additionalProperties: false,
    },
    annotations: { title: "Describe device UI", ...READ_ONLY },
  },
  {
    name: "device_scroll_to_element",
    description:
      "Scroll a labelled accessibility element into the tappable region and return its tap point.",
    inputSchema: {
      type: "object",
      properties: {
        udid: UDID,
        label: { type: "string" },
        role: { type: "string" },
        maxSwipes: {
          type: "integer",
          minimum: DEVICE_SCROLL_MIN_SWIPES,
          maximum: DEVICE_SCROLL_MAX_SWIPES,
        },
      },
      required: ["udid", "label"],
      additionalProperties: false,
    },
    annotations: { title: "Scroll to element", ...WRITE },
  },
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return value as JsonRecord;
}

function stringArg(args: JsonRecord, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.trim().length === 0)) {
    throw new Error(
      `Argument ${JSON.stringify(name)} must be a${required ? " non-empty" : ""} string.`,
    );
  }
  return value;
}

function numberArg(args: JsonRecord, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 20_000) {
    throw new Error(`Argument ${JSON.stringify(name)} must be a device point from 0 to 20000.`);
  }
  return value;
}

function boundedInteger(
  args: JsonRecord,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `Argument ${JSON.stringify(name)} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

async function executeDeviceTool(input: {
  readonly manager: DeviceManager;
  readonly threadId: string;
  readonly name: DeviceToolName;
  readonly args: JsonRecord;
}): Promise<unknown> {
  const { manager, threadId, name, args } = input;
  const udid = () => stringArg(args, "udid")!;
  const surface = async (reason: DeviceOpenPaneReason = "agent-tool") =>
    manager.surfaceDeviceForAgent(threadId, udid(), reason);
  const interaction = async <A>(run: () => Promise<A>): Promise<A> => {
    const result = await run();
    await surface();
    return result;
  };

  return manager.withAgentActivity(threadId, async () => {
    switch (name) {
      case "device_list":
        return manager.list({ includeShutdown: args.includeShutdown === true });
      case "device_boot": {
        const result = await manager.boot(udid());
        if (result.kind === "booted") {
          await manager.ensureThreadAttached(threadId, udid()).catch(() => undefined);
        }
        return result;
      }
      case "device_install": {
        const result = await manager.install(udid(), stringArg(args, "appPath")!);
        await surface("agent-install");
        return result;
      }
      case "device_launch": {
        const launchArguments = args.arguments;
        if (
          launchArguments !== undefined &&
          (!Array.isArray(launchArguments) ||
            launchArguments.some((value) => typeof value !== "string"))
        ) {
          throw new Error('Argument "arguments" must be an array of strings.');
        }
        const result = await manager.launch(
          udid(),
          stringArg(args, "bundleId")!,
          launchArguments as string[] | undefined,
        );
        await surface("agent-launch");
        return result;
      }
      case "device_open_url":
        return interaction(async () => {
          await manager.openUrl(udid(), stringArg(args, "url")!);
          return { udid: udid(), opened: true };
        });
      case "device_tap":
        return interaction(async () => {
          const request = readTapRequest({
            ...(args.x !== undefined ? { x: numberArg(args, "x") } : {}),
            ...(args.y !== undefined ? { y: numberArg(args, "y") } : {}),
            ...(args.label !== undefined ? { label: stringArg(args, "label") } : {}),
            ...(args.role !== undefined ? { role: stringArg(args, "role") } : {}),
          });
          if (request.kind === "point") {
            await manager.tap(udid(), request.x, request.y);
            return { udid: udid(), x: request.x, y: request.y };
          }
          const match = await manager.tapElement(udid(), request.target);
          return {
            udid: udid(),
            x: match.point.x,
            y: match.point.y,
            element: {
              role: match.node.role,
              subrole: match.node.subrole,
              label: match.node.label,
              valueBeforeTap: match.node.value,
            },
          };
        });
      case "device_swipe":
        return interaction(async () => {
          const gesture = {
            fromX: numberArg(args, "fromX"),
            fromY: numberArg(args, "fromY"),
            toX: numberArg(args, "toX"),
            toY: numberArg(args, "toY"),
            durationMs:
              boundedInteger(
                args,
                "durationMs",
                DEVICE_SWIPE_DURATION_MIN_MS,
                DEVICE_SWIPE_DURATION_MAX_MS,
              ) ?? 300,
          };
          await manager.swipe(udid(), gesture);
          return { udid: udid(), ...gesture };
        });
      case "device_type":
        return interaction(async () => {
          const text = stringArg(args, "text", false) ?? "";
          await manager.typeText(udid(), text);
          return { udid: udid(), length: text.length };
        });
      case "device_press_button":
        return interaction(async () => {
          const button = stringArg(args, "button")!;
          if (!BUTTONS.includes(button as DeviceHardwareButton)) {
            throw new Error(`Argument "button" must be one of: ${BUTTONS.join(", ")}.`);
          }
          await manager.pressButton(udid(), button as DeviceHardwareButton);
          return { udid: udid(), button };
        });
      case "device_screenshot": {
        const shot = await manager.screenshot(udid());
        await surface();
        const { bytesBase64, ...metadata } = shot;
        return {
          _mcpContent: [
            { type: "text", text: JSON.stringify(metadata, null, 2) },
            { type: "image", data: bytesBase64, mimeType: shot.mimeType },
          ],
        };
      }
      case "device_describe_ui":
        return interaction(() => manager.describeUi(udid()));
      case "device_scroll_to_element":
        return interaction(async () => {
          const match = await manager.scrollToElement(
            udid(),
            {
              label: stringArg(args, "label")!,
              ...(args.role !== undefined ? { role: stringArg(args, "role") } : {}),
            },
            {
              maxScrolls: boundedInteger(
                args,
                "maxSwipes",
                DEVICE_SCROLL_MIN_SWIPES,
                DEVICE_SCROLL_MAX_SWIPES,
              ),
            },
          );
          return {
            udid: udid(),
            element: {
              role: match.node.role,
              subrole: match.node.subrole,
              label: match.node.label,
              value: match.node.value,
              frame: match.node.frame,
            },
            tapPoint: match.point,
          };
        });
    }
  });
}

interface BindingRecord {
  readonly threadId: string;
  readonly isTurnActive: () => boolean;
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

export async function startDeviceToolGateway(manager: DeviceManager): Promise<DeviceToolGateway> {
  const bindings = new Map<string, BindingRecord>();
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

      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return empty(response, 202);
      }
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
        const tools =
          (agentControlLocksByThread.get(binding.threadId)?.size ?? 0) > 0
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
      if (agentControlBlocksLegacyTool(binding.threadId, name as DeviceToolName)) {
        return json(
          response,
          200,
          mcpSuccess(id, {
            isError: true,
            content: [
              {
                type: "text",
                text: "Use the Ryco Agent Control device tools for this provider session.",
              },
            ],
          }),
        );
      }
      try {
        const value = await executeDeviceTool({
          manager,
          threadId: binding.threadId,
          name: name as DeviceToolName,
          args: asRecord(params.arguments ?? {}),
        });
        const content =
          value && typeof value === "object" && "_mcpContent" in value
            ? (value as { _mcpContent: unknown })._mcpContent
            : [{ type: "text", text: JSON.stringify(value, null, 2) }];
        return json(response, 200, mcpSuccess(id, { content }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isViewerFacingDeviceToolError(error)) {
          await manager.recordThreadError(binding.threadId, message).catch(() => undefined);
        }
        return json(
          response,
          200,
          mcpSuccess(id, { isError: true, content: [{ type: "text", text: message }] }),
        );
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
      bindings.set(token, { threadId, isTurnActive });
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
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
