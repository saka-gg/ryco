# Codex MCP elicitation (Computer Use phase 4)

Status: implemented on `computer-use/4-codex-elicitation` (stacked on phase 3).

## Problem

Codex sessions Ryco starts load the user's `~/.codex/config.toml`. With the ChatGPT/Codex desktop
app installed, that config brings OpenAI's own Computer Use (`unified-computer-use@openai-bundled`,
MCP server `cua_repl`, tool `js`). Before it acts in an app it asks the client with the app-server
request `mcpServer/elicitation/request`. Ryco answered `-32601 Method not found`, so the plugin
reported "Computer Use was not approved to use TextEdit" and the task failed. Codex also uses this
request for its own MCP tool-call approvals and for any MCP server that elicits.

## User decision

Keep OpenAI's Computer Use available in Codex chats and show its approval requests in Ryco. Other
providers keep using Ryco's own Computer Use. Ryco does not hide or disable OpenAI's plugin.

## Wire shapes (from the generated schema and OpenAI's own clients)

- Params: `{ threadId, turnId?, serverName, mode, message, _meta? }` plus
  `requestedSchema` (`form`: typed object schema; `openai/form`: unknown) or
  `{ url, elicitationId }` (`url`).
- Response: `{ action: "accept" | "decline" | "cancel", content?, _meta? }`.
- Approval-style requests have an empty or null schema. `_meta.codex_approval_kind` says what kind
  (`mcp_tool_call`, `browser_auth`, `tool_suggestion`), `_meta.persist` lists the remember options
  (`"session"`, `"always"`), `_meta.tool_params_display` lists `{ name, display_name, value }`
  lines. An accept that should be remembered answers `_meta: { persist: "session" | "always" }`
  (same as the Codex TUI, `codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs`).
- OpenAI's Computer Use asks `Allow Computer Use to use "TextEdit"?` with
  `connector_id: "computer-use"`, `codex_approval_kind: "mcp_tool_call"` and
  `persist: ["session", "always"]` (or `["session"]`).

## Design

One pipe for every elicitation: Ryco's existing **pending question** flow
(`user-input.requested` → question card → `thread.user-input.respond`). Reasons:

- It already carries option lists, free-text answers, multi-select and a cancelled state, so all
  three modes fit without a new decision value or request kind.
- Every client that renders questions today (web, desktop, mobile, hosted) shows it with no
  change, including older ones; a new approval kind would be invisible to them and the turn would
  wait for the timeout.
- Authority stays the same: answering is `thread.user-input.respond`, gated by the same
  `dispatchCommand` capability as approvals and questions. Read-only clients still cannot answer.

The server keeps the decoded request; the client only ever sends option labels or typed text, and
the server turns them into the MCP response. A pure module,
`apps/server/src/provider/codexMcpElicitation.ts`, plans the prompt and maps answers.

### Prompts

- **Approval** (empty/null schema): one question. Header: `Codex Computer Use` for
  `connector_id: "computer-use"`, else the connector name, else the MCP server name. Text: the
  message, the warning subtitle when present, and up to three display params that the message does
  not already name. Options: `Allow once`, then `Allow for this chat` / `Always allow` when
  `persist` offers them, then `Deny`. Typed text counts as Deny. Computer Use gets no
  `Allow once` (user decision): after a one-time allow it asks again on its very next action. It
  keeps `Allow once` only when it offers nothing to remember.
- **Form** (fields): one question per field. Boolean → Yes/No, enums → options (multi-select for
  arrays), strings and numbers → typed answer. Optional fields add `Skip`; every question has
  `Decline`, which declines the whole request. The server validates numbers, integer, min/max and
  length; a bad answer fails the respond command and the question stays open.
- **URL**: one question with the message and the link, which also rides on the question as
  `link` (new optional `UserInputQuestion` field; older clients ignore it). Clients show
  **Open link**, which opens it only when pressed: desktop through the existing `openExternal`
  path (default browser, http(s) only), the web in a new tab. `Continue` accepts, `Deny` declines.
  Only http(s) links are offered; any other URL is answered `cancel` (user decision).
- Anything Ryco cannot render (an `openai/form` schema that is not a typed object schema) is
  answered `cancel` at once and logged.

### Ending without an answer

- Timeout: 15 minutes (`CODEX_ELICITATION_TIMEOUT_MS`), then `cancel`.
- Session close / thread stop: every open elicitation answers `cancel`.
- Codex resolves it first (`serverRequest/resolved`, e.g. turn interrupted or the MCP server gave
  up): Ryco cancels its waiter and closes the question.
- The turn it belongs to completes: Ryco cancels it, in case Codex sent no `serverRequest/resolved`.
- Each of these emits `user-input.resolved` with `cancelled: true`, so the card goes away.

### Runtime mode

Ryco does not answer Codex approvals itself; Codex's approval policy decides whether it asks. In
full access Codex runs with `approvalPolicy: "never"` and never asks for its own tool calls, and
Ryco's own Computer Use skips its per-app approval. To match, **full access auto-accepts only
approval-style elicitations with `codex_approval_kind: "mcp_tool_call"`**, unless
`_meta.codex_requires_user_input` is set (user decision):

- Computer Use app approvals (`tool_params.app`): accepted like **Allow for this chat**
  (`persist: "session"`), never a lasting `always` grant.
- Other Computer Use requests (recording computer audio): always ask, like Ryco's own clipboard
  consent, which asks even in full access.
- Other tool-call approvals: accepted once, nothing remembered.

Forms that ask for data, URL requests, plugin install suggestions, browser sign-in and approvals of
unknown kind always ask, in every mode.

## Tests

- `codexMcpElicitation.test.ts`: planning (Computer Use, persist options, forms of every field
  type, URL, unsupported), answer mapping, full-access policy.
- `CodexElicitation.integration.test.ts` (runtime against the mock Codex peer): request →
  question event, answer → response, invalid form answer, timeout, `serverRequest/resolved`, turn
  end, unsupported schema, full-access auto-accept. Close shares the same cancel path.
- `CodexAdapter` mapping: request/answered → `user-input.requested` / `user-input.resolved`;
  ingestion: the question and its cancellation become `user-input.*` activities.
- Web: the question card renders the Computer Use prompt and sends the chosen label.
