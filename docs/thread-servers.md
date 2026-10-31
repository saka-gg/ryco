# Thread servers

When an agent or a thread terminal starts a dev server (Vite, Next, `python -m http.server`, ...),
the thread's Crown rail shows a **Servers** icon. It lists the servers that still listen, with
their page title (or process name), `localhost:<port>` and where they run from (Agent, Terminal,
or neither once their launching shell is gone). The icon is hidden while the thread has none.

- **Open** shows the page in the desktop Browser panel when the thread runs on this desktop's own
  backend. Otherwise it opens the system browser. For a remote node, `localhost` is that node's
  machine: the page opens only if its port is reachable or forwarded, and the card says so.
- **Stop** ends the server's process group: SIGTERM, then SIGKILL after 3 seconds if it is still
  running. It is offered to owners and operators, not viewers, and not on Windows.

The node lists servers on macOS and Linux (with `lsof`). Windows nodes and Linux without `lsof`
show none.

## How a server is tied to its thread

Ryco starts every agent session and every thread terminal with `RYCO_THREAD_ID` set to the
thread. Every process they start inherits it, so a server stays attributed after its launching
shell exits, after the agent's turn ends, and when it is put in the background.

While a client shows the crown, the node scans every 3 seconds: it lists loopback and wildcard TCP
listeners (`lsof`), then reads that one variable from each listener's launch environment. Linux
reads `/proc/<pid>/environ`. macOS compares `ps -E` with plain `ps`, so a marker that only appears
in a process's arguments does not count. Nothing else from the environment is kept, logged or sent.
A read that fails (a `ps` timeout under load) is tried again on the next scan, and a failed `lsof`
keeps the last list. With no client following a thread, the node does not scan.

Only attributed servers get a page title probe: one `GET /` over loopback without credentials,
redirects followed only on the same port, at most 128 KiB, given up after 650 ms, cached for 30
seconds (10 after a miss). Only the servers a thread lists (its 32 lowest ports) are probed, and
the page is parsed in linear time from at most 1 KiB of title text. Databases are never probed.

What does not carry the marker:

- **OpenCode** runs one shared `opencode serve` for all threads of an instance, so its jobs are
  not attributed to a thread.
- **Turborepo** in strict env mode passes a task only the variables it lists. Add
  `RYCO_THREAD_ID` to `globalPassThroughEnv` in your `turbo.json` to keep servers started through
  `turbo run dev` attributed.
- **Apple's own binaries** on macOS (`/usr/bin/perl`, `/bin/sleep`, the system `ruby`): `ps -E`
  shows no environment for them, so their servers are not listed. Homebrew, nvm and Xcode
  toolchains (`node`, `python3`) are.
- **tmux** and other long-lived multiplexers keep the variable of the session that started them,
  so servers started there may be listed under an earlier thread.
- Any process of your user can set the variable itself. That only makes its server appear (with
  Stop) under the thread it names. Ryco's own processes stay protected (see below).

## Stopping safely

A stop names the server by pid, start time and port. The node then:

1. scans again, reading the target process's marker afresh, and requires the same process still
   listening on that port, still attributed to the thread (`not-found`, `identity-changed`,
   `not-attributed` otherwise);
2. reads the process table again and fails closed if it cannot (or if the server's own row is
   missing from it);
3. refuses (`shared-group`) a process group that also holds the Ryco server, one of its ancestors
   (the desktop app), a direct child of the server (agent CLIs, terminal shells, helpers) or a
   session leader with a terminal (a terminal or persistent agent shell whose jobs share its
   group);
4. sends SIGTERM to the group, checks every 250 ms, and sends SIGKILL after 3 seconds only while
   one of the group's original processes (same pid and start time) is still in it.

Whether a server has a group of its own depends on how it was started:

| Started by                                                    | Own process group                                   |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Claude Code (Bash tool, also in background)                   | Yes: each command runs in a new session             |
| Codex (shell tool)                                            | Yes: each command runs in a new session (`setsid`)  |
| A thread terminal with job control (zsh, bash)                | Yes: each job                                       |
| Copilot, Cursor, Grok, ACP agents                             | Not verified; a job in the agent's group is refused |
| `exec` in a terminal, a server in a shell without job control | No: refused as `shared-group`                       |

A refused server can still be stopped where it runs (its terminal, or by asking the agent).
