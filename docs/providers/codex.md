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
messages, with no automatic continuation or goal usage tracking.

See the [Codex goal workflow](https://learn.chatgpt.com/use-cases/follow-goals) and
[app-server goal API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal).

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

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
choose an option or write an answer, then explicitly submit. Closing the web card preserves
its draft; suggested options are never submitted automatically. **Dismiss** closes the card
without sending an answer or granting permission.

Cards are available only while their originating turn is live. Completion, interruption,
superseding turns, or replacement of the provider process invalidate unanswered cards.
Late answers never start a new turn. A disconnected client cannot submit; reconnect restores
the persisted question and delivery state. Draft text is local to the mounted form.

Ryco admits one answer per question generation. Validation failures before dispatch permit
correction; an unconfirmed delivery remains claimed and is never automatically retried.
The card explains this state. Starting a new turn does not resend the old answer.

### Protocol and capability boundary

Native `request_user_input_async` emits an `agentMessage` item with `delivery: "async"` and
structured `questions`, then returns immediately. It does not create a pending JSON-RPC
answer request. Ryco replies as ordinary user input through `turn/steer`, supplying the
original provider thread and `expectedTurnId`; the reply text identifies the question item.
The runtime validates these identities again at dispatch. The existing durable question
ledger owns client claims and settlement; process-local authority is never restored after
restart. Only `turn/completed` settles the provider turn.

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
