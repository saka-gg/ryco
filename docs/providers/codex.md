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
