import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Effect, Option, Redacted, Schema, Scope } from "effect";

import { AgentControlIntegrationId } from "@ryco/contracts";

import type { AgentControlExternalIntegrationServiceShape } from "../Services/AgentControlExternalIntegration.ts";
import {
  AGENT_CONTROL_MCP_MAX_BODY_BYTES,
  AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES,
  AGENT_CONTROL_MCP_PATH,
  AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS,
  rejectAgentControlMcpTransport,
} from "../Mcp/transportGuard.ts";
import {
  JSON_RPC_ERROR_CODES,
  jsonRpcError,
  jsonRpcResult,
  mcpToolCallResult,
  parseJsonRpcMessage,
  type JsonRpcResponse,
} from "../Mcp/jsonRpc.ts";
import {
  AGENT_CONTROL_MCP_PROTOCOL_VERSIONS,
  AGENT_CONTROL_MCP_SERVER_INFO,
} from "../Mcp/listener.ts";
import type { ExternalMcpTools } from "./tools.ts";

export const AGENT_CONTROL_EXTERNAL_PAIR_PATH = "/_ryco/external-pair";
export const AGENT_CONTROL_EXTERNAL_INSTRUCTIONS =
  "This is a paired local Ryco integration. It can request one scoped task at a time. " +
  "Every task remains pending until a Ryco user approves the exact proposal.";

export class AgentControlExternalListenerError extends Schema.TaggedError<AgentControlExternalListenerError>()(
  "AgentControlExternalListenerError",
  { detail: Schema.String },
) {}

export interface AgentControlExternalListenerHandle {
  readonly url: string;
  readonly pairingUrl: string;
  readonly port: number;
}

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const endEmpty = (response: ServerResponse, status: number) => {
  response.writeHead(status, headers);
  response.end();
};
const endJson = (response: ServerResponse, status: number, body: JsonRpcResponse) => {
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES) {
    serialized = JSON.stringify(
      jsonRpcError(null, JSON_RPC_ERROR_CODES.internalError, "Response too large"),
    );
  }
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(serialized);
};
const readBody = (request: IncomingMessage): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > AGENT_CONTROL_MCP_MAX_BODY_BYTES) {
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const protocolVersion = (requested: unknown): string => {
  const versions: ReadonlyArray<string> = AGENT_CONTROL_MCP_PROTOCOL_VERSIONS;
  return typeof requested === "string" && versions.includes(requested) ? requested : versions[0]!;
};

const transportInput = (request: IncomingMessage, pathname: string | undefined) => ({
  method: request.method,
  pathname,
  remoteAddress: request.socket.remoteAddress,
  origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
  contentType: request.headers["content-type"],
  hasCookieHeader: request.headers.cookie !== undefined,
  hasDpopHeader: request.headers.dpop !== undefined,
  hasDesktopControlHeader: request.headers["x-ryco-desktop-control"] !== undefined,
});

export const makeExternalMcpRequestHandler = (deps: {
  readonly integrations: AgentControlExternalIntegrationServiceShape;
  readonly tools: ExternalMcpTools;
}) => {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url === undefined ? undefined : new URL(request.url, "http://localhost");
    if (url?.pathname === AGENT_CONTROL_EXTERNAL_PAIR_PATH) {
      const rejection = rejectAgentControlMcpTransport({
        ...transportInput(request, AGENT_CONTROL_MCP_PATH),
        pathname: AGENT_CONTROL_MCP_PATH,
      });
      if (rejection !== null) return endEmpty(response, rejection.status);
      const body = await readBody(request);
      if (body === null) return endEmpty(response, 413);
      let value: { integrationId?: unknown; pairingCode?: unknown };
      try {
        value = JSON.parse(body) as typeof value;
      } catch {
        return endEmpty(response, 400);
      }
      if (typeof value.integrationId !== "string" || typeof value.pairingCode !== "string") {
        return endEmpty(response, 400);
      }
      if (!Schema.is(AgentControlIntegrationId)(value.integrationId))
        return endEmpty(response, 400);
      const exchanged = await Effect.runPromise(
        Effect.option(
          deps.integrations.exchangePairing({
            integrationId: value.integrationId,
            pairingCode: value.pairingCode,
          }),
        ),
      );
      if (Option.isNone(exchanged)) return endEmpty(response, 401);
      response.writeHead(200, { ...headers, "content-type": "application/json" });
      response.end(
        JSON.stringify({
          integrationId: exchanged.value.integrationId,
          audience: "external-mcp",
          credential: Redacted.value(exchanged.value.credential),
        }),
      );
      return;
    }

    const rejection = rejectAgentControlMcpTransport(transportInput(request, url?.pathname));
    if (rejection !== null) return endEmpty(response, rejection.status);
    const identity = await Effect.runPromise(
      Effect.option(deps.integrations.authenticate(request.headers.authorization)),
    );
    if (Option.isNone(identity)) {
      response.writeHead(401, { ...headers, "www-authenticate": "Bearer" });
      response.end();
      return;
    }
    const body = await readBody(request);
    if (body === null) return endEmpty(response, 413);
    const parsed = parseJsonRpcMessage(body);
    if (parsed.kind === "invalid") return endJson(response, 400, parsed.response);
    if (parsed.kind === "notification") return endEmpty(response, 202);
    const { id, method, params } = parsed.request;
    const integration = identity.value.integration;

    if (method === "initialize" || method === "ping" || method === "tools/list") {
      const admitted = await Effect.runPromise(
        Effect.option(
          deps.integrations.authorizeTool({
            integrationId: integration.integrationId,
            tool: method,
          }),
        ),
      );
      if (Option.isNone(admitted)) return endEmpty(response, 429);
    }

    switch (method) {
      case "initialize": {
        const requested =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>).protocolVersion
            : undefined;
        return endJson(
          response,
          200,
          jsonRpcResult(id ?? null, {
            protocolVersion: protocolVersion(requested),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { ...AGENT_CONTROL_MCP_SERVER_INFO, name: "ryco-external-agent-control" },
            instructions: AGENT_CONTROL_EXTERNAL_INSTRUCTIONS,
          }),
        );
      }
      case "ping":
        return endJson(response, 200, jsonRpcResult(id ?? null, {}));
      case "tools/list":
        return endJson(
          response,
          200,
          jsonRpcResult(id ?? null, { tools: deps.tools.descriptorsFor(integration) }),
        );
      case "tools/call": {
        const call =
          typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
        if (typeof call.name !== "string" || !deps.tools.hasTool(call.name)) {
          const admitted = await Effect.runPromise(
            Effect.option(
              deps.integrations.authorizeTool({
                integrationId: integration.integrationId,
                tool: "tools/call:unknown",
              }),
            ),
          );
          if (Option.isNone(admitted)) return endEmpty(response, 429);
          return endJson(
            response,
            200,
            jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.invalidParams, "Unknown tool"),
          );
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS);
        try {
          const result = await Effect.runPromise(
            deps.tools.callTool(integration.integrationId, call.name, call.arguments),
            { signal: controller.signal },
          );
          return endJson(response, 200, jsonRpcResult(id ?? null, mcpToolCallResult(result)));
        } catch {
          return endJson(
            response,
            200,
            jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.internalError, "Request cancelled"),
          );
        } finally {
          clearTimeout(timeout);
        }
      }
      default:
        return endJson(
          response,
          200,
          jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
        );
    }
  };

  return (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) endEmpty(response, 500);
      else response.destroy();
    });
  };
};

export const makeAgentControlExternalListener = (deps: {
  readonly integrations: AgentControlExternalIntegrationServiceShape;
  readonly tools: ExternalMcpTools;
}): Effect.Effect<
  AgentControlExternalListenerHandle,
  AgentControlExternalListenerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<Server, AgentControlExternalListenerError>((resume) => {
        const value = createServer(makeExternalMcpRequestHandler(deps));
        value.requestTimeout = AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS + 5_000;
        value.once("error", (error) =>
          resume(Effect.fail(new AgentControlExternalListenerError({ detail: error.message }))),
        );
        value.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.succeed(value)));
      }),
      (value) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              value.closeAllConnections();
              value.close(() => resolve());
            }),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* new AgentControlExternalListenerError({ detail: "Missing listener address" });
    }
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      url: `${origin}${AGENT_CONTROL_MCP_PATH}`,
      pairingUrl: `${origin}${AGENT_CONTROL_EXTERNAL_PAIR_PATH}`,
      port: address.port,
    };
  });
