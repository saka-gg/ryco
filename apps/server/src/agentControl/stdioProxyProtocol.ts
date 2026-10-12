/**
 * stdioProxyProtocol - The launch contract between a provider-session MCP
 * entry and the Agent Control stdio proxy. Dependency-free so the process
 * entry can dispatch the proxy without loading the server graph.
 *
 * @module stdioProxyProtocol
 */
export const AGENT_CONTROL_STDIO_PROXY_ARG = "__agent-control-stdio-proxy";
export const AGENT_CONTROL_BOOTSTRAP_ENV = "RYCO_AGENT_CONTROL_BOOTSTRAP";
export const AGENT_CONTROL_BOOTSTRAP_URL_ENV = "RYCO_AGENT_CONTROL_BOOTSTRAP_URL";
