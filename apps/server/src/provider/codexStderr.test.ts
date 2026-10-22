import { describe, expect, it } from "vite-plus/test";
import { classifyCodexStderrLine, isFatalCodexStderrMessage } from "./codexStderr.ts";

const ESC = String.fromCharCode(27);

describe("classifyCodexStderrLine", () => {
  it("drops blank lines and non-error log levels", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
    for (const level of ["TRACE", "DEBUG", "INFO", "WARN"]) {
      expect(
        classifyCodexStderrLine(`2026-10-14T10:40:19.340108Z ${level} codex_core::config: loaded`),
      ).toBeNull();
    }
  });

  it("drops known benign errors, colored or not", () => {
    const line = `${ESC}[2m2026-02-08T04:24:20.085687Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m ${ESC}[2mcodex_core::rollout::list${ESC}[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb`;
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("routes OAuth failures of the user's MCP servers to the server log", () => {
    const colored = `${ESC}[2m2026-10-14T10:40:19.340108Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m ${ESC}[2mcodex_rmcp_client::oauth::refresh_transaction${ESC}[0m: error=failed to refresh OAuth tokens for server stripe: OAuth refresh token was rejected: Server returned error response: invalid_grant`;
    expect(classifyCodexStderrLine(colored)).toEqual({
      route: "server-log",
      message:
        "2026-10-14T10:40:19.340108Z ERROR codex_rmcp_client::oauth::refresh_transaction: error=failed to refresh OAuth tokens for server stripe: OAuth refresh token was rejected: Server returned error response: invalid_grant",
      mcpServer: "stripe",
    });
    const unnamed =
      "2026-10-14T10:40:19.340108Z ERROR codex_rmcp_client::oauth: token store unavailable";
    expect(classifyCodexStderrLine(unnamed)).toEqual({
      route: "server-log",
      message: unnamed,
      mcpServer: undefined,
    });
  });

  it("keeps other MCP client errors in the conversation", () => {
    const line =
      "2026-10-14T10:40:19.340108Z ERROR codex_rmcp_client::rmcp_client: failed to start server polar";
    expect(classifyCodexStderrLine(line)).toEqual({ route: "conversation", message: line });
  });

  it("keeps unknown structured errors and plain stderr in the conversation", () => {
    const structured =
      "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(structured)).toEqual({
      route: "conversation",
      message: structured,
    });
    expect(classifyCodexStderrLine("fatal: permission denied\r ")).toEqual({
      route: "conversation",
      message: "fatal: permission denied",
    });
  });
});

describe("isFatalCodexStderrMessage", () => {
  it("flags a lost model websocket and nothing else", () => {
    expect(
      isFatalCodexStderrMessage(
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: Failed to connect to websocket: HTTP error: 503",
      ),
    ).toBe(true);
    expect(isFatalCodexStderrMessage("The filename or extension is too long.")).toBe(false);
  });
});
