/**
 * Minimal JSON-RPC 2.0 message handling for the internal Agent Control
 * MCP endpoint. Deliberately hand-rolled and small: the private listener
 * speaks exactly the streamable-HTTP MCP subset it needs (initialize,
 * ping, tools/list, tools/call, client notifications) and nothing else.
 *
 * @module agentControl/Mcp/jsonRpc
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcErrorBody };

export const jsonRpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});

/**
 * A `tools/call` result as MCP requires it: `structuredContent` must be a JSON object, so a
 * tool whose value is an array (thread search results) or a scalar has it wrapped as
 * `{ result }`. Clients validating the result schema rejected the bare array outright.
 */
export const mcpToolCallResult = (result: unknown): unknown => {
  if (typeof result !== "object" || result === null || !("structuredContent" in result)) {
    return result;
  }
  const { structuredContent } = result as { readonly structuredContent: unknown };
  if (
    structuredContent === undefined ||
    (typeof structuredContent === "object" &&
      structuredContent !== null &&
      !Array.isArray(structuredContent))
  ) {
    return result;
  }
  return { ...result, structuredContent: { result: structuredContent } };
};

export const jsonRpcError = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export type ParsedJsonRpcMessage =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | { readonly kind: "notification"; readonly method: string; readonly params?: unknown }
  | { readonly kind: "invalid"; readonly response: JsonRpcResponse };

const isValidId = (id: unknown): id is JsonRpcId =>
  id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

/**
 * Parse one JSON-RPC message from a request body. Batches are refused
 * outright — the internal endpoint bounds batch size at exactly one
 * message, which the 2025-06-18 MCP revision also mandates.
 */
export function parseJsonRpcMessage(body: string): ParsedJsonRpcMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return {
      kind: "invalid",
      response: jsonRpcError(null, JSON_RPC_ERROR_CODES.parseError, "Parse error"),
    };
  }

  if (Array.isArray(decoded)) {
    return {
      kind: "invalid",
      response: jsonRpcError(
        null,
        JSON_RPC_ERROR_CODES.invalidRequest,
        "Batch requests are not supported",
      ),
    };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return {
      kind: "invalid",
      response: jsonRpcError(null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid request"),
    };
  }

  const message = decoded as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return {
      kind: "invalid",
      response: jsonRpcError(
        isValidId(message.id) ? message.id : null,
        JSON_RPC_ERROR_CODES.invalidRequest,
        "Invalid request",
      ),
    };
  }

  if (!("id" in message)) {
    return { kind: "notification", method: message.method, params: message.params };
  }
  if (!isValidId(message.id)) {
    return {
      kind: "invalid",
      response: jsonRpcError(null, JSON_RPC_ERROR_CODES.invalidRequest, "Invalid request id"),
    };
  }

  return {
    kind: "request",
    request: {
      jsonrpc: "2.0",
      id: message.id,
      method: message.method,
      params: message.params,
    },
  };
}
