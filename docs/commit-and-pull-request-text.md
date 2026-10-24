# Commit messages and pull request text

Ryco writes commit messages and pull request titles and descriptions with the model chosen
under **Settings → Providers → Text generation**. The prompt carries the staged diff, the
branch, the commit list and your commit or pull request instructions. Ryco uses the answer
directly: it commits with the generated message, and opens the pull request with the
generated title and description.

The diff and other repository text can contain instructions aimed at the model, so these
requests run without tools: the model can only answer. It cannot run commands, read files,
browse the web or call MCP servers, with one Codex exception described below.

## What each provider keeps

- **Claude:** no built-in tools and no MCP servers (a strict, empty MCP configuration). Your
  Claude settings and `CLAUDE.md` files still load, so project instructions can still shape
  the wording. Checked against Claude Code 2.1.307.
- **Codex:** a read-only sandbox with shell and command execution, image viewing, web search,
  tool search, apps, plugins, the memory tool, JavaScript, subagents, goals and sleep turned
  off. Two Codex tools stay but can do nothing here: applying a patch (the sandbox is
  read-only) and asking you a question (nobody can answer in a background run). Your
  `config.toml`, login, custom model providers, rules and `AGENTS.md` still load. Checked
  against Codex CLI 0.163.0.
- **GitHub Copilot:** commit messages and pull request text run through Codex, as above.
- **OpenCode:** a session that denies every permission. Plugins from your OpenCode
  configuration still load.
- **Cursor and Grok:** their agent protocols offer no way to turn every tool off. Choose
  another provider for text generation if that matters to you.

## Limit: MCP servers in your Codex config

Codex has no single setting that drops the MCP servers listed in your `config.toml`: it
merges Ryco's empty `mcp_servers` override into your list instead of replacing it. MCP
servers you configured for Codex therefore stay reachable from commit and pull request text.

If you do not want that, choose a Claude model for text generation, or add a second Codex
provider instance whose `CODEX_HOME` has no MCP servers and choose its model for text
generation (see [Codex](providers/codex.md)).

## Other text generation

With Claude and Codex, inbox ranking also runs without tools, because it reads linked pull
request and issue titles. Their thread titles, branch names and change summaries first try a
run without your config, then retry once with it, still without tools. Side questions never
load your config; see [Side chat](side-chat.md). Issue drafting still gives the model the
provider's tools.
