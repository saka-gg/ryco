/**
 * Private loopback listener for the internal Agent Control MCP endpoint.
 *
 * A dedicated `node:http` server bound to `127.0.0.1` on an ephemeral
 * port. Deliberately NOT constructed through the shared
 * `HttpServer.HttpServer` tag: that tag feeds the advertised-endpoint
 * registry, Tailscale Serve, and `server-runtime.json`, and this endpoint
 * must never appear in any of them. The bound address is published only
 * into the Agent Control session registry, where provider adapters read
 * it through issued leases.
 *
 * Transport shape: stateless streamable-HTTP MCP. Single JSON-RPC
 * messages over POST, `application/json` responses, no SSE streams, no
 * session ids, no CORS headers ever. Supported methods: `initialize`,
 * `ping`, `tools/list`, `tools/call`, plus client notifications (accepted
 * and discarded with 202).
 *
 * @module agentControl/Mcp/listener
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Effect, Option, Redacted, Schema, Scope } from "effect";

import type { AgentControlSessionRegistryShape } from "../Services/AgentControlSessionRegistry.ts";
import {
  JSON_RPC_ERROR_CODES,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcMessage,
  type JsonRpcResponse,
} from "./jsonRpc.ts";
import {
  AGENT_CONTROL_MCP_MAX_BODY_BYTES,
  AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES,
  AGENT_CONTROL_MCP_PATH,
  AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS,
  AGENT_CONTROL_BOOTSTRAP_PATH,
  rejectAgentControlBootstrapTransport,
  rejectAgentControlMcpTransport,
} from "./transportGuard.ts";
import type { AgentControlMcpTools } from "./tools.ts";

/** Newest first; an unknown requested version negotiates to the newest. */
export const AGENT_CONTROL_MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const AGENT_CONTROL_MCP_SERVER_INFO = {
  name: "ryco-agent-control",
  version: "1.0.0",
} as const;

/**
 * The adapter must not inject this server at all when setup fails. Mutation
 * tools are advertised only during an exact active turn. Ryco state mutations create
 * approval proposals; desktop control uses its separate local consent policy.
 */
export const AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS =
  "Ryco Agent Control tools over a private local connection. Read tools inspect Ryco state. " +
  "During this exact active turn, mutation tools may request immutable action plans; every " +
  "such request requires user approval in Ryco and never mutates inline. " +
  "When available, ryco_computer and ryco_browser execute under separate opt-in desktop/app permissions; " +
  "these tools act directly and require an exact active turn. Respect local denials and verify results.";

export class AgentControlMcpListenerError extends Schema.TaggedError<AgentControlMcpListenerError>()(
  "AgentControlMcpListenerError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AgentControlMcpListenerDeps {
  readonly registry: Pick<
    AgentControlSessionRegistryShape,
    "authenticate" | "registerInFlight" | "getTurnAuthority" | "exchangeStdioBootstrap"
  >;
  readonly tools: AgentControlMcpTools;
}

export interface AgentControlMcpListenerHandle {
  readonly url: string;
  readonly port: number;
}

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

const endEmpty = (response: ServerResponse, status: number): void => {
  response.writeHead(status, RESPONSE_HEADERS);
  response.end();
};

const endJson = (response: ServerResponse, status: number, body: JsonRpcResponse): void => {
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES) {
    serialized = JSON.stringify(
      jsonRpcError(
        "id" in body ? body.id : null,
        JSON_RPC_ERROR_CODES.internalError,
        "Response too large",
      ),
    );
  }
  response.writeHead(status, { ...RESPONSE_HEADERS, "content-type": "application/json" });
  response.end(serialized);
};

/** Read the request body, resolving `null` when it exceeds the bound. */
const readBoundedBody = (request: IncomingMessage): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > AGENT_CONTROL_MCP_MAX_BODY_BYTES) {
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => reject(error));
  });

const negotiateProtocolVersion = (requested: unknown): string => {
  const versions: ReadonlyArray<string> = AGENT_CONTROL_MCP_PROTOCOL_VERSIONS;
  return typeof requested === "string" && versions.includes(requested) ? requested : versions[0]!;
};

const makeRequestHandler = (deps: AgentControlMcpListenerDeps) => {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = request.url === undefined ? undefined : new URL(request.url, "http://localhost");
    if (url?.pathname === AGENT_CONTROL_BOOTSTRAP_PATH) {
      const rejection = rejectAgentControlBootstrapTransport({
        method: request.method,
        pathname: url.pathname,
        remoteAddress: request.socket.remoteAddress,
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        contentType: request.headers["content-type"],
        hasCookieHeader: request.headers.cookie !== undefined,
        hasDpopHeader: request.headers.dpop !== undefined,
        hasDesktopControlHeader: request.headers["x-ryco-desktop-control"] !== undefined,
      });
      if (rejection !== null) {
        endEmpty(response, rejection.status);
        return;
      }
      const body = await readBoundedBody(request);
      if (body === null) {
        endEmpty(response, 413);
        return;
      }
      let token: unknown;
      try {
        token = (JSON.parse(body) as { token?: unknown }).token;
      } catch {
        endEmpty(response, 400);
        return;
      }
      if (typeof token !== "string") {
        endEmpty(response, 400);
        return;
      }
      const exchange = await Effect.runPromise(
        Effect.option(deps.registry.exchangeStdioBootstrap(token)),
      );
      if (Option.isNone(exchange)) {
        endEmpty(response, 401);
        return;
      }
      response.writeHead(200, { ...RESPONSE_HEADERS, "content-type": "application/json" });
      response.end(
        JSON.stringify({
          endpointUrl: exchange.value.endpointUrl,
          authorization: `Bearer ${Redacted.value(exchange.value.credential)}`,
        }),
      );
      return;
    }
    const rejection = rejectAgentControlMcpTransport({
      method: request.method,
      pathname: url?.pathname,
      remoteAddress: request.socket.remoteAddress,
      origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      contentType: request.headers["content-type"],
      hasCookieHeader: request.headers.cookie !== undefined,
      hasDpopHeader: request.headers.dpop !== undefined,
      hasDesktopControlHeader: request.headers["x-ryco-desktop-control"] !== undefined,
    });
    if (rejection !== null) {
      endEmpty(response, rejection.status);
      return;
    }

    // Authenticate before touching the body: every request needs a valid
    // internal provider-session credential, initialize included.
    const session = await Effect.runPromise(
      Effect.option(deps.registry.authenticate(request.headers.authorization)),
    );
    if (session._tag === "None") {
      response.writeHead(401, { ...RESPONSE_HEADERS, "www-authenticate": "Bearer" });
      response.end();
      return;
    }

    const body = await readBoundedBody(request);
    if (body === null) {
      endEmpty(response, 413);
      return;
    }

    const parsed = parseJsonRpcMessage(body);
    if (parsed.kind === "invalid") {
      endJson(response, 400, parsed.response);
      return;
    }
    if (parsed.kind === "notification") {
      // Client notifications (`notifications/initialized`, cancellations…)
      // are accepted and discarded; there is no server-side session state.
      endEmpty(response, 202);
      return;
    }

    const { id, method, params } = parsed.request;
    switch (method) {
      case "initialize": {
        const requestedVersion =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>).protocolVersion
            : undefined;
        endJson(
          response,
          200,
          jsonRpcResult(id ?? null, {
            protocolVersion: negotiateProtocolVersion(requestedVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: AGENT_CONTROL_MCP_SERVER_INFO,
            instructions: AGENT_CONTROL_MCP_INITIALIZE_INSTRUCTIONS,
          }),
        );
        return;
      }
      case "ping": {
        endJson(response, 200, jsonRpcResult(id ?? null, {}));
        return;
      }
      case "tools/list": {
        const descriptors = await Effect.runPromise(deps.tools.descriptorsFor(session.value));
        endJson(response, 200, jsonRpcResult(id ?? null, { tools: descriptors }));
        return;
      }
      case "tools/call": {
        const call =
          typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
        const toolName = call.name;
        if (typeof toolName !== "string" || !deps.tools.hasTool(toolName)) {
          endJson(
            response,
            200,
            jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.invalidParams, "Unknown tool"),
          );
          return;
        }

        // Bound request duration and register for synchronous revocation:
        // revoking the session (or retiring a bound turn) aborts the
        // controller, which interrupts the running tool effect.
        const controller = new AbortController();
        const onDisconnect = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", onDisconnect);
        const timeout = setTimeout(() => controller.abort(), AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS);
        const authority = deps.tools.isWriteTool(toolName)
          ? await Effect.runPromise(deps.registry.getTurnAuthority(session.value.sessionId))
          : undefined;
        const registration = await Effect.runPromise(
          Effect.option(
            deps.registry.registerInFlight(session.value.sessionId, {
              abort: () => controller.abort(),
              ...(authority && authority._tag === "Some" ? { turnId: authority.value.turnId } : {}),
            }),
          ),
        );
        if (registration._tag === "None") {
          clearTimeout(timeout);
          response.off("close", onDisconnect);
          endJson(
            response,
            200,
            jsonRpcResult(id ?? null, {
              content: [
                { type: "text", text: "Exact active-turn write authority is unavailable." },
              ],
              isError: true,
            }),
          );
          return;
        }
        const unregister = registration.value;
        try {
          const result = await Effect.runPromise(
            deps.tools.callTool(session.value, toolName, call.arguments),
            { signal: controller.signal },
          );
          endJson(response, 200, jsonRpcResult(id ?? null, result));
        } catch {
          endJson(
            response,
            200,
            jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.internalError, "Request cancelled"),
          );
        } finally {
          clearTimeout(timeout);
          response.off("close", onDisconnect);
          unregister();
        }
        return;
      }
      default: {
        endJson(
          response,
          200,
          jsonRpcError(id ?? null, JSON_RPC_ERROR_CODES.methodNotFound, "Method not found"),
        );
        return;
      }
    }
  };

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) endEmpty(response, 500);
      else response.destroy();
    });
  };
};

/**
 * Start the private listener on `127.0.0.1:0`. The returned handle is for
 * the session registry's endpoint slot only — it must never reach client
 * state, advertised endpoints, persisted runtime state, or logs beyond
 * the port number. Closing the scope closes every connection.
 */
export const makeAgentControlMcpListener = (
  deps: AgentControlMcpListenerDeps,
): Effect.Effect<AgentControlMcpListenerHandle, AgentControlMcpListenerError, Scope.Scope> =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.callback<Server, AgentControlMcpListenerError>((resume) => {
        const httpServer = createServer(makeRequestHandler(deps));
        httpServer.requestTimeout = AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS + 5_000;
        httpServer.once("error", (error) => {
          resume(
            Effect.fail(
              new AgentControlMcpListenerError({
                detail: `Agent Control MCP listener failed to start: ${error.message}`,
              }),
            ),
          );
        });
        httpServer.listen({ host: "127.0.0.1", port: 0 }, () => {
          resume(Effect.succeed(httpServer));
        });
      }),
      (httpServer) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              httpServer.closeAllConnections();
              httpServer.close(() => resolve());
            }),
        ),
    );

    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* new AgentControlMcpListenerError({
        detail: "Agent Control MCP listener has no TCP address.",
      });
    }
    return {
      url: `http://127.0.0.1:${address.port}${AGENT_CONTROL_MCP_PATH}`,
      port: address.port,
    };
  });
