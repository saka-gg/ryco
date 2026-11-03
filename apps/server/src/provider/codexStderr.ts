/**
 * Classifies the Codex app-server's stderr, one line at a time. Codex writes `tracing` log
 * lines (`<timestamp> <LEVEL> <target>: <message>`) and, rarely, plain text. Only ERROR lines
 * and plain text concern a conversation: known benign errors are dropped, and OAuth failures
 * of MCP servers in the user's own Codex config go to the server log. They describe the
 * user's Codex setup, not this chat, and repeat in every chat that starts Codex.
 */

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
/**
 * Codex's MCP client refreshing OAuth tokens. Only servers from the user's config use OAuth:
 * Ryco's Agent Control server authenticates with a bearer header.
 */
const CODEX_MCP_OAUTH_TARGET_REGEX = /\scodex_rmcp_client::oauth\S*:\s/;
const CODEX_MCP_OAUTH_SERVER_REGEX = /\bfor server ([A-Za-z0-9_.-]+)/;
const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

export type CodexStderrLine =
  | { readonly route: "conversation"; readonly message: string }
  | {
      readonly route: "server-log";
      readonly message: string;
      /** The MCP server whose OAuth failed, when the line names it. */
      readonly mcpServer: string | undefined;
    };

/** Where a stderr line goes; null for a line nobody needs (non-errors, known benign errors). */
export function classifyCodexStderrLine(rawLine: string): CodexStderrLine | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
    if (CODEX_MCP_OAUTH_TARGET_REGEX.test(line)) {
      return {
        route: "server-log",
        message: line,
        mcpServer: CODEX_MCP_OAUTH_SERVER_REGEX.exec(line)?.[1],
      };
    }
  }

  return { route: "conversation", message: line };
}

/** Whether a stderr message that reaches the conversation is an error rather than a warning. */
export function isFatalCodexStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}
