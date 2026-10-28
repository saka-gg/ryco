# Agent process priority

Agents run test suites, compilers and browsers. When several do so at once they can load a node
far beyond its core count, and the Ryco server (its event loop, relay, SQLite writes and Git
helpers) then competes with them on equal terms. The node setting **Lower agent CPU priority**
(Settings → General → Agent processes; `lowerAgentProcessPriority`, on by default) starts agent
CLIs at a lower CPU priority than the server. Everything an agent starts inherits it.

## What runs lowered

- Codex `app-server` (one per session) and `codex exec` text generation.
- Claude Code sessions (through the Agent SDK's `spawnClaudeCodeProcess` hook) and `claude -p`
  text generation.
- ACP agents: Cursor and Grok sessions, ACP Registry agents, Cursor and Grok text generation.
- The managed OpenCode server (shared by OpenCode sessions and OpenCode text generation) and the
  per-session OpenCode server of the computer-use path.
- The Copilot CLI of Copilot sessions and Copilot text generation, and the Codex fallback of
  Copilot text generation.
- Everything those processes start: shell tools, tests, `tsc`, Playwright, MCP servers, Codex
  collab agents and Claude subagents.

## What stays at normal priority

- Git and forge commands, checkpoints and worktree helpers.
- User terminals and project setup scripts.
- Provider status probes, version checks, updates and the ACP Registry authentication runtime.
- Short Codex helpers (stored-thread reads, the isolated app-server, credit resets, MCP checks).
- Everything else the server runs for itself (HTML-render Chrome, device helpers, Tailscale, SSH,
  the sleep inhibitor, node updates).

## Mechanism

- **macOS and Linux:** the agent is started as `<nice> -n 5 <command> <args…>`, with an absolute
  `nice` (`/usr/bin/nice`, `/bin/nice` or `/run/current-system/sw/bin/nice`; PATH is never searched
  for it). `nice` execs the agent in place, so the PID, process group, arguments and teardown are
  unchanged, and `-n` is relative: with the server at nice 3, agents run at 8. A priority is never
  raised.
- The argv only changes when the agent command was verified to resolve (with the child's PATH and
  working directory) and no shell is involved; otherwise a missing CLI would turn its "not found"
  error into "nice exited with code 127".
- **Fallback (lowered after spawn):** Windows (Below Normal), shell launches, a node without an
  absolute `nice`, and macOS launches whose environment sets a `DYLD_*` variable. `/usr/bin/nice` is
  protected by System Integrity Protection, so macOS would strip `DYLD_*` from the agent's
  environment; such launches keep their environment and are lowered with `setpriority` instead,
  which on macOS covers the whole process. Linux `setpriority` covers only the main thread (threads
  and children created afterwards inherit it). This half applies only where Ryco spawns the process
  itself: on Windows, Claude Code and the Copilot CLI stay at normal priority (their SDKs keep the
  child private), and a `cmd.exe` launcher can start the agent before the priority call lands.
- Every failure is fail-open: a priority problem never stops an agent from starting.

## When a change applies

The setting is read at every agent launch. A change applies to agents started after it; running
agents keep their priority (turning the setting off cannot raise a running agent). OpenCode shares
one managed server across its sessions, so a change reaches OpenCode when that server restarts:
after its last session ends and its 30 s idle period passes.

## Verify

Start an agent, then list its process group with its niceness:

```sh
ps -axo pid,ppid,pgid,nice,stat,comm | grep -E 'codex|claude|opencode|agent'
ps -o pid,nice,comm -g <pgid>
```

Lowered processes show `5` (server niceness + 5) in the `nice` column and `N` in `stat`. The
Diagnostics process tree in Settings does not show the niceness in release builds (the native
resource monitor reports no nice value).

## Limitations

- Linux with scheduler autogroups (`/proc/sys/kernel/sched_autogroup_enabled` = 1) and no CPU
  controller on the server's cgroup: Codex, ACP and OpenCode agents start in their own session, so
  each forms its own autogroup, and nice then only orders an agent against its own descendants, not
  against the server. Autogroups do not apply where the server's cgroup has the CPU controller
  enabled (containers usually do; a systemd unit only with CPU accounting or a CPU weight), and
  there nice applies. `cat /sys/fs/cgroup$(cut -d: -f3 /proc/<server-pid>/cgroup)/cgroup.controllers`
  (cgroup v2) shows whether `cpu` is listed.
- A binary that exists but cannot be executed (a missing shebang interpreter, a musl/glibc loader
  mismatch) or that disappears between the check and the spawn now fails as "nice exited with code
  127" with nice's message on stderr, instead of a spawn error. For Claude this also replaces the
  SDK's libc-mismatch hint.
- With the hook active, Ryco spawns Claude Code itself. It drains Claude Code's stderr and restores
  the SDK's `. stderr: …` suffix on exit errors, so error texts stay the same; the SDK's default
  `--debug-file` (only used when SDK debugging is enabled) is not added.

## Measure

`apps/server/scripts/measure-agent-priority.ts` saturates the machine with agent-like process
groups started through the production launch plan, and measures a busy synthetic server (or, with
`--url`, any server such as an isolated Ryco node) at nice 0 versus nice 5:

```sh
node apps/server/scripts/measure-agent-priority.ts --phase-seconds 30 --agents 36 --rounds 3 --server-duty 0.3
node apps/server/scripts/measure-agent-priority.ts --phase-seconds 30 --agents 36 --rounds 3 --server-duty 0.3 --increment 10
```

It prints HTTP p50/p95/p99, event-loop delay and machine load per phase (baseline, then ABBA
rounds), the niceness seen across one agent group, and the median per mode. For a Linux row, run it
on a host (not in Docker, where the container's cgroup hides the autogroup case) and record
`uname -r`, `/proc/sys/kernel/sched_autogroup_enabled` and `/proc/self/cgroup`.
