/**
 * Pure transport admission policy for the private Agent Control MCP
 * listener. Mirrors the desktop local-control precedent
 * (`desktopLocalControlIsAuthorized`): loopback-only, browser-hostile,
 * and hostile to every hub/browser-style authorization surface.
 *
 * The checks here are transport-level; credential authentication is the
 * session registry's job and happens after this guard admits a request.
 *
 * @module agentControl/Mcp/transportGuard
 */

export const AGENT_CONTROL_MCP_PATH = "/mcp";
export const AGENT_CONTROL_BOOTSTRAP_PATH = "/_agent-control/bootstrap";
/** Bound on a single request body; a bearer plus one tool call is tiny. */
export const AGENT_CONTROL_MCP_MAX_BODY_BYTES = 128 * 1024;
/**
 * Bound on an authenticated request body on the private provider-session
 * listener only. An HTML render carries up to `HTML_RENDER_MAX_HTML_CHARS`
 * (512,000) UTF-16 units, which JSON can escape to six bytes each; 3 MiB
 * holds the worst case plus the envelope. External integrations and the
 * unauthenticated bootstrap exchange keep the small bound.
 */
export const AGENT_CONTROL_PRIVATE_MCP_MAX_BODY_BYTES = 3 * 1024 * 1024;
/** Bound on one request's total processing time. */
export const AGENT_CONTROL_MCP_REQUEST_TIMEOUT_MS = 60_000;
/** Bound on one serialized JSON-RPC response. */
export const AGENT_CONTROL_MCP_MAX_RESPONSE_BYTES = 512 * 1024;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress.trim());
}

export interface AgentControlMcpTransportInput {
  readonly method: string | undefined;
  readonly pathname: string | undefined;
  readonly remoteAddress: string | undefined;
  /** Raw `Origin` header. MCP clients never send one; browsers always do. */
  readonly origin: string | undefined;
  readonly contentType: string | undefined;
  /** Presence of hub/browser-style auth material, all refused here. */
  readonly hasCookieHeader: boolean;
  readonly hasDpopHeader: boolean;
  readonly hasDesktopControlHeader: boolean;
}

export interface AgentControlMcpTransportRejection {
  readonly status: number;
  readonly reason: string;
}

/**
 * `null` admits the request to authentication; otherwise the HTTP status
 * to answer with. Reasons are for logs/tests only — response bodies stay
 * empty so the endpoint reveals nothing to a probing caller.
 */
export function rejectAgentControlMcpTransport(
  input: AgentControlMcpTransportInput,
): AgentControlMcpTransportRejection | null {
  if (!isLoopbackRemoteAddress(input.remoteAddress)) {
    return { status: 403, reason: "non-loopback remote address" };
  }
  // No CORS ever: a browser-originated request identifies itself with an
  // Origin header and is refused before it can learn anything.
  if (input.origin !== undefined) {
    return { status: 403, reason: "browser origin refused" };
  }
  // Hub, browser-session, and desktop-control authorization surfaces are
  // structurally rejected — this endpoint accepts exactly one credential
  // kind, the internal provider-session bearer.
  if (input.hasCookieHeader) {
    return { status: 403, reason: "cookie authorization refused" };
  }
  if (input.hasDpopHeader) {
    return { status: 403, reason: "dpop authorization refused" };
  }
  if (input.hasDesktopControlHeader) {
    return { status: 403, reason: "desktop-control authorization refused" };
  }
  if (input.pathname !== AGENT_CONTROL_MCP_PATH) {
    return { status: 404, reason: "unknown path" };
  }
  if (input.method !== "POST") {
    // The streamable-HTTP transport is used stateless-and-POST-only here:
    // no SSE streams, no session channel, nothing to GET or DELETE.
    return { status: 405, reason: "method not allowed" };
  }
  if (input.contentType === undefined || !input.contentType.startsWith("application/json")) {
    return { status: 415, reason: "unsupported content type" };
  }
  return null;
}

/** The one-shot proxy exchange has the same browser-hostile local boundary as MCP. */
export function rejectAgentControlBootstrapTransport(
  input: AgentControlMcpTransportInput,
): AgentControlMcpTransportRejection | null {
  const shared = rejectAgentControlMcpTransport({
    ...input,
    pathname: AGENT_CONTROL_MCP_PATH,
  });
  if (shared !== null) return shared;
  return input.pathname === AGENT_CONTROL_BOOTSTRAP_PATH
    ? null
    : { status: 404, reason: "unknown path" };
}
