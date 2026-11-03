# Codex

This guide is for people who want to use more than one Codex account in Ryco.

For persistent MCP servers and one-click standalone Agent Control setup, see
[Provider MCP management](./mcp.md) and [Agent Control](../agent-control.md). Ryco-managed Codex
sessions receive Agent Control automatically when the feature is enabled; that path does not modify
your persistent Codex MCP configuration.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## Persistent goals

In the web or desktop composer, use `/goal <objective>` to start a durable goal, including
in a new thread. Use `/goal` to inspect it, `/goal pause` to pause pursuit, `/goal resume` to
continue, and `/goal clear` to remove it. These controls also appear above the composer.
Pausing or clearing a goal changes goal pursuit; the normal Stop control interrupts the current turn.

Expand the goal header to set, increase, or remove its token budget. Budgets are optional.
After reaching a budget, increase or remove it and then resume. Usage is reported by Codex;
changing a status or budget preserves its accounting, while replacing the objective starts a new goal.

Ryco enables Codex's goals feature for its managed sessions and uses the native app-server
set/get/clear APIs. Codex owns continuation, completion, blocking, and usage limits. Pending
changes remain marked as updating until confirmed; failures show an error and a Retry control.
Ryco reads native state before subsequent turns and checks structural notifications against
current native state so delayed notifications cannot undo newer changes.

A Codex version supporting the goal APIs is required for native pursuit. Providers without
native goal integration show a **Goal reminder**: the objective accompanies subsequent
messages, with no goal usage tracking.

On those providers Ryco continues the goal itself when Agent Control is on and the provider gets
its tools (Claude, Copilot, Cursor). About five seconds after a turn ends cleanly and the chat is
idle, Ryco starts the next turn toward the goal. A message you queued goes first, and pending
approvals, questions, plans and usage limits hold it, like delegated results. The agent ends the
loop by calling `ryco_update_thread` with `goalStatus` `complete` or `blocked`. A Stop, a failed
turn, or 25 automatic turns in a row pause the goal; resume it from the goal header. After a Ryco
restart, the goal waits for your next message. Delegated tasks, Plan mode and chats on OpenCode or
Grok never continue on their own.

See the [Codex goal workflow](https://learn.chatgpt.com/use-cases/follow-goals) and
[app-server goal API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal).

## Sign In From Settings

A Codex instance that is not signed in shows **Account sign-in** in its provider settings. Click
**Sign in** and Ryco runs Codex's device-code login on the machine the instance runs on, which can
be this computer or a remote node:

1. Ryco shows a short code and the address of the sign-in page.
2. Click **Open sign-in page** (or open the address on any device), sign in to ChatGPT, and enter
   the code. **Copy** puts the code on the clipboard.
3. The node notices the login finished, checks the instance again, and every connected app shows
   it as signed in.

The code is valid for 15 minutes. The sign-in runs on the node, so closing Settings, switching to
the browser on your phone, or losing the connection for a while does not stop it; come back to
Settings to see how it went. **Cancel** stops it. A sign-in that was running when the node
restarted has to be started again.

The mobile app has the same sign-in under **Settings › Provider accounts**, which lists each
connected node's provider instances with their accounts. Tap an instance that is not signed in to
open its sign-in: **Open sign-in page** opens the page in the phone's browser, and the sheet shows
the outcome when you come back. Closing the sheet does not stop the sign-in either.

Things to know:

- Only owners of a node can sign its providers in. Shared and read-only connections show why the
  button is unavailable.
- The sign-in writes the login of the instance's own Codex home: its shadow home when it has one,
  otherwise its `CODEX_HOME path`. Two instances that write the same login cannot sign in at the
  same time.
- A node on an older Ryco shows "Update Ryco on <node> to sign in from here."
- An instance that uses a custom model provider instead of a ChatGPT login works without this
  sign-in, so its settings do not offer it.
- If the node's Codex is too old for device-code login, or device code is turned off for your
  account, run `codex login --device-auth` on the node instead.

## Compacting the conversation

Send `/compact` on its own (no other text, no attachments) in a Codex thread, or use **Compact now**
in the context meter popover, to have Codex summarize older context and free room in its window.
The mobile app offers it as **Compact conversation** in the thread's Task details sheet, and in a
project the composer's `/` menu lists `/compact`. Ryco runs it through Codex's own compaction request
(`thread/compact/start`) instead of sending the text to the model. It runs as a turn: the
transcript shows it with **Context compacted**, and the meter updates from Codex's next usage
report. Codex still compacts on its own when the window fills up.

It needs a ready, idle session. While a turn runs or waits on an approval or answer, or while the
session is stopped, **Compact now** is disabled and says why. The node checks this too: a
compaction that reaches it while a turn runs or is starting fails with "a turn is running", and a
message sent while a compaction is starting waits until the compaction's turn has started. If
Codex refuses the request (an older Codex, for example) or does not start the compaction turn
within 30 seconds, the turn fails with "Codex did not start compaction" and Ryco does not send it
again, since Codex may still have taken it: check the thread before compacting again. The summary
request itself uses tokens.

**Compact now** appears once the thread has reported context usage from a node that runs Codex's
compaction: an older node sends `/compact` to the model as a prompt, so the action stays hidden on
Codex threads it serves.

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Sign in from Settings, or log in with Codex normally:

```bash
codex login
```

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same Ryco/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In Ryco Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In Ryco Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

Ryco shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, Ryco treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.

## Optional questions while Codex works

When Codex emits a native asynchronous question, Ryco displays an **Optional question** card
on desktop, web, and the native mobile app. The composer remains available. Open the card,
choose an option or write an answer, then explicitly submit. Suggested options are never
submitted automatically. **Dismiss** closes the card without sending an answer or granting
permission, during the turn or after it.

While the question's turn runs, your answer reaches that turn. After the turn ends, the card
stays: your answer is sent as a new message and starts the next turn, resuming the session if
it stopped. Once answered, the card leaves every client, and a second answer (from another
device, or a second press) is refused. While a later turn runs, the card waits: you can answer
once that turn ends, or dismiss it. Open questions stay available after a reconnect or a node
restart, however much the agent did since.

An answer sent after the turn can carry files and images, on web and desktop. They use the same
upload as files attached to a message, and the agent gets them as attached files with their
saved paths. Send stays disabled while a file is uploading or failed to upload. An answer that
reaches a running turn cannot carry files, so the card offers files only once the turn ended.

Drafts belong to the question, not to the card: switching threads, collapsing the card or a
reconnect keeps what you wrote, on web and in the native app. They are kept in memory, so
reloading the page or quitting the app clears them.

Ryco admits one answer per question generation. Validation failures before dispatch permit
correction; an unconfirmed delivery remains claimed and is never automatically retried.
The card explains this state, and such a question is cleared once a later turn starts. An
answer that could not reach the turn because it had just ended can be sent again; it then
starts a new turn.

### Protocol and capability boundary

Native `request_user_input_async` emits an `agentMessage` item with `delivery: "async"` and
structured `questions`, then returns immediately. It does not create a pending JSON-RPC
answer request. While the turn runs, Ryco replies as ordinary user input through
`turn/steer`, supplying the original provider thread and `expectedTurnId`; the reply text
identifies the question item. The runtime validates these identities again at dispatch. The
existing durable question ledger owns client claims and settlement; process-local authority
is never restored after restart. Only `turn/completed` settles the provider turn.

After the turn, a client sends the same reply text as the message of an ordinary
`thread.turn.start`, through the shared send engine, with an `optionalAnswer` that names the
question. The node claims the question in that command's transaction and records it answered
in the same commit, so the message and the settlement land together or not at all. Turn ends,
superseding turns, session exits and restarts leave an optional question open unless an answer
to it may already have reached the agent. A dismissal is settled by the node itself and never
reaches the provider. Thread windows and the activity cap keep open optional questions however
much activity follows them.

Support is gated by the explicit native payload, not a model name, version guess, feature
flag, timeout, or question text. Older versions and other providers retain their blocking
question behavior. Malformed native metadata falls back to ordinary assistant text.
Subagent question routing is outside this slice. The generated baseline remains compatible
with older Codex versions; a narrow protocol extension preserves the newer message fields
for validation without changing generated schemas.

`item/tool/requestUserInput`, command/file approvals, and permission requests retain their
existing response semantics. Neither `autoResolutionMs` nor `isBlocking: false` on that
request is treated as evidence of the separate native async message protocol.

References: [OpenAI app-server documentation](https://developers.openai.com/codex/app-server),
[Codex native async handler](https://github.com/openai/codex/blob/814de47b69dd63a2660fd14f9af66690888d183e/codex-rs/core/src/tools/handlers/request_user_input_async.rs),
[Synara v0.9.2 protocol notes](https://github.com/Emanuele-web04/synara/blob/v0.9.2/docs/providers.md#codex-asynchronous-questions).
Synara was inspected as a protocol reference; this implementation does not copy its code.
