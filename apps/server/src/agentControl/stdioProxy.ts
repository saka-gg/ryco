import { createInterface } from "node:readline";

import { JSON_RPC_ERROR_CODES, jsonRpcError, type JsonRpcId } from "./Mcp/jsonRpc.ts";
import { AGENT_CONTROL_PRIVATE_MCP_MAX_BODY_BYTES } from "./Mcp/transportGuard.ts";
import {
  AGENT_CONTROL_BOOTSTRAP_ENV,
  AGENT_CONTROL_BOOTSTRAP_URL_ENV,
} from "./ProviderInjection.ts";

interface BootstrapExchange {
  readonly endpointUrl: string;
  readonly authorization: string;
}

export interface AgentControlStdioProxyDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly errorOutput: NodeJS.WritableStream;
  readonly fetch: typeof globalThis.fetch;
}

export const exchangeAgentControlBootstrap = async (
  fetchImpl: typeof globalThis.fetch,
  url: string,
  token: string,
): Promise<BootstrapExchange> => {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Agent Control bootstrap exchange refused");
  const value = (await response.json()) as Partial<BootstrapExchange>;
  if (
    typeof value.endpointUrl !== "string" ||
    typeof value.authorization !== "string" ||
    !value.authorization.startsWith("Bearer rycoac_")
  ) {
    throw new Error("Agent Control bootstrap exchange returned an invalid response");
  }
  return { endpointUrl: value.endpointUrl, authorization: value.authorization };
};

export const runAgentControlStdioProxy = async (
  deps: AgentControlStdioProxyDeps,
): Promise<void> => {
  const token = deps.env[AGENT_CONTROL_BOOTSTRAP_ENV];
  const bootstrapUrl = deps.env[AGENT_CONTROL_BOOTSTRAP_URL_ENV];
  // Remove bootstrap material before any provider request is handled. This
  // process never spawns shell children, so neither secret can be inherited.
  delete deps.env[AGENT_CONTROL_BOOTSTRAP_ENV];
  delete deps.env[AGENT_CONTROL_BOOTSTRAP_URL_ENV];
  if (!token || !bootstrapUrl) throw new Error("Agent Control bootstrap is unavailable");

  const connection = await exchangeAgentControlBootstrap(deps.fetch, bootstrapUrl, token);
  const lines = createInterface({ input: deps.input });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await deps.fetch(connection.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: connection.authorization,
      },
      body: line,
    });
    if (response.status === 202) continue;
    // One oversized or malformed call must not cut the session's whole Ryco
    // connection: answer it like the listener answers a bad message.
    const answer = response.ok
      ? await response.text()
      : response.status === 413
        ? oversizedRequestAnswer(line)
        : response.status === 400 && isJsonResponse(response)
          ? await response.text()
          : undefined;
    if (answer === undefined) throw new Error("Agent Control MCP request failed");
    if (answer !== null) deps.output.write(`${answer}\n`);
  }
};

const isJsonResponse = (response: Response) =>
  response.headers.get("content-type")?.startsWith("application/json") === true;

/** The JSON-RPC error for a request over the body bound; `null` for a notification. */
const oversizedRequestAnswer = (line: string): string | null => {
  let id: JsonRpcId = null;
  try {
    const message = JSON.parse(line) as { id?: unknown };
    if (typeof message !== "object" || message === null || !("id" in message)) return null;
    if (typeof message.id === "string" || typeof message.id === "number") id = message.id;
  } catch {
    // Unparseable: answered with a null id, as for a parse error.
  }
  return JSON.stringify(
    jsonRpcError(
      id,
      JSON_RPC_ERROR_CODES.invalidRequest,
      `Request too large: Ryco accepts at most ${AGENT_CONTROL_PRIVATE_MCP_MAX_BODY_BYTES / (1024 * 1024)} MiB per call.`,
    ),
  );
};

export const runAgentControlStdioProxyFromProcess = (): void => {
  void runAgentControlStdioProxy({
    env: process.env,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    fetch: globalThis.fetch,
  }).catch(() => {
    // Never print the caught error: fetch errors can embed request material.
    process.stderr.write("Agent Control stdio proxy stopped.\n");
    process.exitCode = 1;
  });
};
