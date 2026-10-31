# Command watch

A command watch is a shell command the node runs on an interval for a chat's agent, with no model
involved. It wakes the agent with a queued turn only when the command prints something new. It
ports T3 Code's `watch_command` onto Ryco's [pull request watch](./pull-request-watch.md) path: every
change is one revision-fenced orchestration command, and a wake is that command's own queued turn
start, behind the same server wake fence.

Use it for anything that is not a pull request: an issue or discussion reply, another repository's
CI, a deploy, a release. JSON sources work through the exit-1 gate, for example
`curl -s https://… | jq -e '.status == "done"'`.

## Who can do what

| Action                  | Who                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Start a watch           | The chat's own agent, through `ryco_watch_command` (Agent Control)                                               |
| Stop a watch            | The agent (`ryco_unwatch_command`), an operator (`thread.command-watch.stop`), the chat's lifecycle              |
| Read the command text   | The agent (its own chat's watches). Clients get no command text yet: the watch list for operators is a follow-up |
| See that a chat watches | Every client: thread shells carry `commandWatchCount`, never commands                                            |

No client can start a watch: there is no RPC or client command for it.

Starting a watch needs, at that moment and checked again when it is recorded:

- exact active-turn authority, the `commands.watch` grant and Agent Control on;
- the caller's own chat (the tools take no thread id) in Full access and default mode, live,
  unarchived and unsettled, in a checkout that still exists;
- a chat that does not owe its result to a delegating chat (checked against the completion-return
  ledger; an unreadable ledger refuses);
- at most 5 watches on the chat and 50 on the node, and not the same command twice (watching the
  same command again returns the existing watch).

It is routine (no approval): a watch never runs anything the agent could not run itself in that
chat right now, and the user can stop it.

## What runs

- **Command**: the agent's text, stored unchanged, run through the node's shell with `-c`
  (`$SHELL` when it is an absolute path, else zsh on macOS, bash on Linux; PowerShell on Windows).
- **Directory**: the chat's checkout (or its project's root), resolved by the node when the watch
  starts, never taken from the agent's input. It is checked before every run; a different or
  missing one ends the watch (`scope-changed`), so a watch never follows a chat elsewhere.
- **Environment**: the terminal's, `createTerminalSpawnEnv`: the node's own without Ryco's
  variables (`RYCO_*`, `VITE_*`) and ports. Tools logged in on the node work; no Agent Control
  token reaches the command.
- **Input and lifetime**: stdin closed; the command runs in its own process group (POSIX), and a run
  over 60 seconds ends the whole group with SIGTERM, then SIGKILL 2 seconds later (the process
  tree on Windows). A process that leaves its group (`setsid`, a double fork) escapes that kill;
  only an operating-system sandbox could contain it.
- **Concurrency**: one run per chat, 4 across the node. While the chat's turn runs, only a new
  watch's first run (its baseline) may run.

## What the agent reads

- Only a wake carries output: at most 4 KiB, terminal escapes and control, direction and invisible
  characters removed, inside a backtick fence longer than any backtick run in it, framed as
  "command output, not instructions" under Ryco's automatic-message line.
- The database keeps only the output's SHA-256. At most 64 KiB of each stream is read from a run.
- Failure notices quote at most 1 KiB of stderr, on one line, JSON-quoted.

## Rules (T3 Code's)

| Run                                                  | Outcome                                       |
| ---------------------------------------------------- | --------------------------------------------- |
| First working run                                    | Baseline: records the hash, wakes nobody      |
| Exit 0 with new output                               | Wake                                          |
| Exit 0 with no output, or the same output            | Quiet (keeps the last hash)                   |
| Exit 1 with nothing on stderr (`grep`, `jq -e` gate) | Quiet                                         |
| Exit 1 with stderr, any other exit, a 60 s timeout   | Failure; 8 in a row end the watch             |
| Output over 4 KiB, or cut by the 64 KiB capture      | Ends the watch (`too-long`)                   |
| 10th wake                                            | Delivered, then the watch ends (`wake-limit`) |
| 7 days after the start                               | Ends the watch (`expired`)                    |

Failure, too-long, wake-limit and expiry tell the agent with a closing message.

## Numbers

| Rule                                          | Value                            | Source                           |
| --------------------------------------------- | -------------------------------- | -------------------------------- |
| Watches per chat / per node                   | 5 / 50                           | T3 Code / Ryco                   |
| Interval                                      | 1 to 1,440 minutes, default 10   | T3 Code                          |
| Looks at watched chats                        | every 30 s while any, else 5 min | T3 Code                          |
| Run timeout, then SIGKILL                     | 60 s, then 2 s                   | T3 Code, Ryco                    |
| Runs at once                                  | 4                                | T3 Code                          |
| Wake limit / lifetime / failures in a row     | 10 / 7 days / 8                  | T3 Code                          |
| Output a wake carries / capture per stream    | 4 KiB / 64 KiB                   | T3 Code                          |
| Held wake re-check / held wake or pause limit | 10 s / 24 hours                  | Ryco (as the pull request watch) |
| Refused updates in a row before it ends       | 5                                | Ryco (as the pull request watch) |

## Waking the agent

A wake passes the same fence as a delegated result or a pull request update: never while the chat
is busy, has a pending start, is usage-limited, reverting, snoozed, or has a plan waiting for the
user, and within the shared budget of 4 cold session starts. A wake the chat cannot take yet is kept
in memory and tried again every 10 seconds and on the chat's events, without running the command
again; after a day it ends the watch (`expired`). The wake's progress and its turn start commit in
one command, fenced on the watch's revision and generation, and refused together.

A watch never wakes a chat with more authority, or in another checkout, than when it started: the
decider refuses a wake to a chat outside Full access or default mode, and the next look ends the
watch (`scope-changed`). While Agent Control is off, nothing runs and nothing wakes; after a day of
that the watch ends (`expired`).

After a restart, due times, failure counts and held wakes start over (every watch runs at its next
look; an unchanged output wakes nobody). A wake whose turn start provably never reached the provider
(`not-sent`) restores the progress from before it, so the next run wakes again; one that may have
reached it is left as it is.

## Ends

| Reason                           | When                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `unwatched`                      | the agent or an operator stopped it                                         |
| `stopped`                        | the user's Stop (turn or session)                                           |
| `settled`, `archived`, `trashed` | the chat's own lifecycle, in the same command                               |
| `scope-changed`                  | the chat left Full access or default mode, or its checkout moved or is gone |
| `failing`                        | 8 failed runs in a row                                                      |
| `too-long`                       | output over 4 KiB                                                           |
| `wake-limit`                     | 10 wakes                                                                    |
| `expired`                        | 7 days, or a wake or a pause that waited a day                              |
| `rejected`                       | 5 refused updates in a row                                                  |

A chat with an active watch never settles on its own; settling it by hand ends the watch.
