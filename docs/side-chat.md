# Side chat

Side chat answers a separate question from completed primary turns while the primary
agent continues working. It does not append questions or answers to the primary
transcript, resume the primary provider session, or grant tool or mutation authority.
Follow-ups include earlier successful side exchanges and a fresh snapshot of completed
thread context. Model and reasoning selections
belong to the side conversation independently of the main composer.

## Provider isolation

Supported providers create a new request with an empty temporary working directory.
Ryco control environment variables and primary session identifiers are removed.
Temporary directories are removed after success, failure, or cancellation.

- **Codex:** a separate ephemeral `codex exec` process, read-only sandbox, no user
  config or exec rules, no project instructions, and disabled shell, images, search,
  MCP configuration, apps, plugins, hooks, memory, JavaScript execution, subagents, goals,
  and sleep.
  CLI options were last checked against Codex CLI **0.163.0**. Older CLIs missing
  `--ignore-user-config` or `--ignore-rules` fail the side request; Ryco never retries
  without the isolation flags. User-configured custom model providers are not loaded
  for side questions; use a model available through the CLI's default authentication.
- **Claude:** a separate non-persistent CLI request with an empty tool list, strict
  empty MCP configuration, no user/project/local settings sources, no hooks or auto
  memory, and exclusions for automatically discovered instruction files. Managed
  organization instructions remain subject to Claude's own policy. Authentication
  remains available, including subscription authentication. CLI options were checked
  against Claude Code **2.1.269**. Unsupported flags fail the request without an
  unsafe fallback.
- **GitHub Copilot:** a separate SDK client and session, an empty tool allowlist,
  rejected permission requests, replaced system prompt, and disabled configuration,
  instruction, hook, skill, git, embedding, and cross-session discovery. The repository
  pins SDK **1.0.13**. Cancellation aborts that session and stops its client only.

**Cursor, Grok, and OpenCode fail closed for side questions.** Their current provider
integrations cannot establish the required tool-free, completed-context boundary.
Cursor and Grok's ACP ask modes do not establish a complete tool-disabling contract.
OpenCode's session permission denial runs after server configuration and plugins may
already load, including remote configuration associated with provider authentication.
Sharing or merely launching another server does not remove that authority. Selecting
one of these providers returns an explicit error without starting a side runtime.

CLI subprocess lifetimes belong to the side request's Effect scope, so interruption
closes the side process without cancelling the primary provider session. Copilot uses
its own session abort and client cleanup. There is no provider fallback that silently
changes the selected model or relaxes these restrictions.

Provider validation uses fake CLI processes and a Copilot SDK test double to inspect
isolation settings, environment handling, cleanup, cancellation, and fail-closed
behavior. Live authenticated provider billing calls are not part of local tests.

## Interface and limits

Web and desktop expose Side chat from the workspace launcher, `/btw question`
from the composer, and `mod+alt+s` (⌘⌥S on macOS, Ctrl+Alt+S elsewhere; see
[keybindings](../KEYBINDINGS.md#side-chat)), which opens the side chat or minimizes it
again. `/btw` alone reopens it. Native mobile has the same command and
a dedicated composer button. Minimize preserves the side conversation in memory;
New chat clears it. Reloading or leaving a native thread discards the conversation.
Only successful side exchanges enter follow-up history. Stop restores the pending
question as a draft, while a late response cannot replace current state. If a newer draft
exists, the unsent question is retained separately until explicitly restored or discarded;
another ask is blocked until that recovery decision. Web and native expose the same
controls. See [selection to chat](selection-to-chat.md) for quotation transfer.

## Continue as thread

When a side exchange is worth keeping, **Continue as thread** in the side chat's header
(web and desktop) turns it into a real thread through [forking](thread-forks.md). It
opens the fork dialog at the thread's newest reply that **Fork from here** is offered
on, so the fork inherits the conversation the side chat read. Once the fork is created
and opens, its composer holds the side chat as a draft: each answered question and its
answer as plain `Q:` and `A:` lines, ready to edit. Nothing is sent until you send it,
and the side chat itself stays as it was. A question still waiting for its answer, or
one that failed, is left out.

It is offered once the side chat has at least one answer, where the thread offers
**Fork from here** (a node that supports forks and operator access), and not while an
answer is pending. If no reply can be forked yet, it says so and opens nothing. The
frozen web phone layout has no side chat panel; native mobile does not offer it yet.

## Requests and context

Requests use the existing authenticated RPC transport and shared role/lifecycle
policy. Side questions are not queued for later execution after reconnecting.
Cancellation belongs to the originating connection and request; another client's
request and the primary turn remain independent. Each connection can have at most
four active side requests.

Context is read transactionally from successful completed turns, with up to 200
messages and 200 activity summaries, and at most 64,000 characters. Oversized context
is rejected before starting a provider. Requests accept text only (16,000 characters)
and up to 20 successful side exchanges (64,000 history characters total).

Design reference: [t3code PR #8296](https://github.com/pingdotgg/t3code/pull/8296).
