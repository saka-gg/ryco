# Agent Control

Agent Control lets coding agents inspect Ryco and operate threads. Private Ryco sessions execute
routine actions through the durable operation queue. Archiving, runtime permission changes,
project linking/unlinking or workspace changes, executable project scripts, system prompts, and
device lifecycle changes still require user approval. Routine input on the device attached to a
thread needs one approval per task (see `ryco_device` below). Standalone integrations remain
approval-only.

Agent Control also gives agents visual replies: with it on, they can answer with inline HTML pages
such as charts, tables, diagrams and mockups, shown in the thread above their written reply (see
[HTML renders](./user/html-renders.md)).

Private tools are advertised when the provider initializes, including before its first turn. Discovery
is scoped to the session's capabilities; mutations still require exact active-turn authority when
called. This matters for clients such as Codex that cache the initial MCP catalog.

## Private-session tools

- `ryco_capabilities`: provider instance IDs, model slugs, grants, and the complete available catalog.
- `ryco_create_threads`: a bounded batch of local or isolated-worktree threads, with an optional base
  ref. The caller's project, runtime permission and worktree-isolation restrictions still apply.
  An entry's `artifacts` hands over up to 8 of the caller's own artifacts (see
  [Handing over artifacts](#handing-over-artifacts)). Every entry starts at once unless the request
  sets `maxConcurrent` (1 to 8): then the first entries start, and each later one waits, its first
  message held in its own thread's follow-up queue ("Waiting for a free slot"), until an earlier
  task of the request stops working (its turn ended and nothing else runs in it, or it was
  archived, moved to Trash or deleted). Waiting tasks start in entry order, once the request has
  created all its tasks, with the chat's current model and modes (never above the runtime mode the
  task was created with), and the cap holds across a restart. Resuming a waiting task by hand starts it at once;
  it then counts against the cap. A task whose goal will continue its last turn keeps its slot
  through the goal's grace before that turn. A waiting returnToOrigin task never starts on its
  own once the chat no longer waits for it: stopping, archiving or deleting the chat,
  `ryco_task_cancel`, or its time limit. Its queue then waits for you instead of a slot ("Its
  chat stopped waiting for it"), and Resume starts it; `ryco_task_cancel` takes its first message
  out instead.
- `ryco_list_artifacts`: the caller's own thread's artifacts, newest first, with the ids a
  handover takes. Needs the `read` grant.
- `ryco_send_message`, `ryco_interrupt_thread`, `ryco_update_thread`: queue/steer work (a queued
  message joins the thread's follow-up queue as the agent's, visible and editable in the chat, and
  is sent when the thread is idle; the request completes once it is queued), interrupt a
  turn, rename/archive/restore, select models and options, set runtime/interaction/token modes,
  and set or clear a persistent goal. With `goalStatus` (`complete` or `blocked`) an agent reports
  on its own thread's goal, which ends automatic goal turns (see the Codex provider guide).
- `ryco_read_thread`, `ryco_search_threads`, `ryco_wait_threads`: paginated messages (the first
  page also lists the thread's queued follow-ups and why the queue waits), content search,
  and bounded waiting for completion or user attention. Background agents count as active work. A
  wait returns as soon as a waited thread settles or asks for attention: it wakes on the thread's
  session, turn, pending-request and background-work events instead of polling, and re-checks at
  least every 5 seconds.
- `ryco_inspect_thread`: model/goal/status details, native subagents and their messages, activities,
  plans, review checkpoints, and retained terminal output. History cursors expose older pages;
  partial subagent coverage is reported explicitly.
- `ryco_read_thread_diff`, `ryco_read_thread_file`: checkpoint patches and authorized workspace or
  worktree text files through the same services used by the right panel.
- `ryco_read_project`, `ryco_propose_project_update`: project preferences and revision-checked
  updates, including default model, system prompt, scripts, and preferred remote.
- `ryco_settings_summary`, `ryco_propose_settings_change`: the closed non-secret boolean preference
  allowlist. Provider credentials, connection settings and Agent Control policy are excluded.
- `ryco_usage_limits`: the usage limits Ryco last read for each enabled provider instance, or one
  by `instanceId`, and for each enabled CLIProxyAPI hub's accounts. Each window has the label the
  Limits page uses, the percent used, the reset time and the pace at the read; each instance has
  the read time and says when the numbers are re-served after a failed or throttled read. Hub
  accounts are numbered (`Account 1`, `Account 2`…) in the hub's order, with their provider. An
  instance a hub serves lists no windows of its own and points at that hub's entry. It never asks
  a provider or a hub for a new reading, so a hub shows accounts only after the Limits page or the
  composer's usage popup read it. It needs the `diagnostics.read` grant and no active turn, and
  leaves out emails, account names, ids, credential files, plans and credits (see
  [Usage limits](./providers/usage-limits.md#agents)).
- `ryco_browser`, `ryco_computer`: browser tabs and native app interaction when the desktop bridge
  and the corresponding user permissions are available. Browser `open` accepts `visible: true`.
  Browser `wait` works in every browser; `console`, `network`, `resize`, `appearance` and `upload`
  (files from the thread's workspace, as copies), network idle waits and automatic page-dialog
  answers (`dialog`/`promptText`) are Ryco-browser only.
- `ryco_device`: tap, swipe, type, hardware buttons, scroll to an element, launch an installed app
  and simulator settings on the simulator or emulator attached to the caller's thread (and to no
  other thread), plus describe, wait and app logs. Inputs return the settled screen as text. The
  first input of each task asks the user once with an "Allow Device for this task" card in the chat;
  the tool answers `pending` with a `proposalId` to wait on. An approved or declined card holds
  for the rest of the task, messages sent into it while the agent works included; Stop ends the
  task. Full-access threads skip the card. Boot, attach, install, URLs, recording and
  shutdown stay `ryco_propose_device_*` approvals. Not available to OpenCode sessions, whose Agent
  Control lease covers Computer Use only.
- `ryco_task_status`, `ryco_task_cancel`: status, results and cancel for tasks this chat delegated
  with `returnToOrigin` (see [Delegated tasks](#delegated-tasks)).
- `ryco_queue_list`, `ryco_queue_edit`, `ryco_queue_remove`: a thread's follow-up queue on the
  node. The list (the `read` grant) shows every entry, next first, with its revision and `mine`:
  whether this chat's agent queued it with `ryco_send_message` (`delivery: "queue"`) and no
  person has edited it since. Edit and remove (the `threads.send-message` grant and exact
  active-turn authority, run at once) change only those entries, before the node sends them and
  not while one is being steered: an edit replaces the text at the revision the list showed and
  keeps the entry's place, attachments, model and modes (a retry after a lost reply finds its
  edit applied); a removal of several is all or nothing. The node checks the ownership again
  when it applies the change. A person's entries (and an agent's entry a person edited), another
  chat's agent's and a schedule's stay out of reach. Private sessions only.
- `ryco_list_local_tasks`, `ryco_read_local_task`, `ryco_create_local_task`,
  `ryco_update_local_task`, `ryco_add_local_task_file`, `ryco_remove_local_task_file`,
  `ryco_start_local_task_chat`, `ryco_propose_local_task_delete`: the user's Tasks page (see
  [Tasks](#tasks)).
- `ryco_link_pull_request`: link a pull request the agent opened (or names, by number or URL) to
  its own chat's workspace, so Ryco shows it beside the chat, follows its state and settles the
  chat when it merges, without watching it. Same checks as watching: the repository must be the
  checkout's, and a pull request the user removed from the workspace stays removed. A chat on the
  project's main checkout is refused (the main workspace's pull requests are not shown with
  chats; watch the pull request instead). The answer says whether this chat's workspace or
  another workspace of the project has the link. Needs the pull request grant and an active turn. Thread search (inbox and palette) finds a chat by its
  workspace's pull requests: `#123`, `owner/repo#123` or the URL.
- `ryco_watch_pull_request`, `ryco_unwatch_pull_request`: have Ryco wake a chat with a pull
  request's news instead of polling (see [Pull request watches](#pull-request-watches)).
- `ryco_watch_command`, `ryco_unwatch_command`, `ryco_list_command_watches`: have Ryco run a shell
  command for the caller's own chat on an interval and wake it only when the output changes (see
  [Command watches](#command-watches)).
- `ryco_worktree_handoff`, `ryco_worktree_status`: move the caller's own chat out of the project's
  shared checkout into a new worktree on a new branch and continue there (see
  [Worktree handoff](#worktree-handoff)).
- `ryco_request_secret`: ask the user for a secret (an API key, a token) on a private card
  instead of in the chat (see [Secret requests](#secret-requests)).
- `ryco_html_preview`, `ryco_html_render`: check a self-contained HTML page in Ryco's headless
  browser, then show it inline above the reply as a sandboxed page that follows the user's theme,
  with a card at the end of the reply (see [HTML renders](./user/html-renders.md)). Both need the
  `html.render` grant and exact active-turn authority; a render counts toward the turn's attachment
  budget. Its result, like `ryco_attach_file`'s, names the stored artifact's id. A published page
  can call `ryco.send(text)` to send the reader's answer to its thread once they confirm it (see
  [Answering from a page](./user/html-renders.md#answering-from-a-page)).

Mutation calls return a durable receipt. Reuse `requestId` when retrying the same action, then use
`ryco_wait_for_control_request` with `waitFor: "terminal"` to get dispatch results and created thread
IDs. Successful dispatch is not task completion: for delegated work, end the turn and let Ryco
wake the chat (below); use `ryco_wait_threads` only to follow other threads. An agent must never
approve its own pending requests.

## Delegated tasks

An agent delegates by calling `ryco_create_threads` with `returnToOrigin: true` on each entry,
confirms the request with `ryco_wait_for_control_request` (`waitFor: "terminal"`), and ends its
turn. It does not poll. When a delegated task reaches a terminal state, Ryco wakes the delegating
chat with one automatic message, a normal queued turn that starts or resumes its session.

- **Batching.** Tasks that finish while the chat is busy, or together, arrive in one message with
  one section per task (at most 10 sections and 100,000 characters; the rest follow in the next
  message). Each section links the child and the originating chat.
- **Results and notices.** A finished task returns its final answer as JSON-escaped, untrusted
  reference data (the first 8,000 characters; the wake says when there is more), never as
  instructions or approval. A task that was
  interrupted, stopped (for example by a restart; it is not resumed), failed to start, received
  someone else's follow-up, was archived or deleted, whose request failed, or that did not finish
  within 24 hours of starting (or did not start within 7 days, for a task that waited for a
  free slot) returns a server-written notice instead, with no child text. A task that itself
  delegated returns its output after its own delegated work came back; if that follow-up run fails
  to start, or a restart cuts it off and none of its own delegated work is left to wake it again,
  it returns a stopped notice.
- **When it is delivered.** The chat must be idle: no running or starting session, no pending
  approval or question, no working background agents (a watcher-only "monitoring" state does not
  count) and no turn start waiting to bind. It does not matter whether the chat moved on to other
  work, its session was stopped by the idle reaper, or the server restarted. Starting a cold session
  for a wake is limited to one at a time.
- **Scope.** A wake never runs with more privilege or in a different checkout than the delegation
  had: if the chat's runtime mode was raised or its worktree changed, delivery waits. It also waits
  while Agent Control is disabled. A captured return that cannot be delivered within 24 hours fails
  without a message; open the child instead.
- **Stopping.** If you stop the chat while it is delegating or processing a delegation message,
  the remaining results are not sent automatically, and tasks still waiting for a free slot never
  start on their own. For a request with `maxConcurrent`, a Stop pressed before you approved it
  does not count, for its waiting tasks or for its results. Their queued first messages stay,
  paused, so you can still start one with Resume. Interrupts from agents, startup reconciliation
  and the server do not count. Deleting or archiving the chat, or archiving its worktree, cancels
  its returns too.
- **Task tools.** `ryco_task_status` lists up to 20 of this chat's returnToOrigin tasks (or one by
  `taskId`) with the run state, the return status and the redacted, untrusted result, or the
  notice for a task that ended without one. A task still waiting for a free slot of a capped
  request reports the run state `waiting`, with why; its 24 hours count from when it starts, and
  it is given up if it does not start within 7 days. Pending questions are reported only as a flag. Reading
  one finished task by `taskId` during the chat's own turn acknowledges it, so no separate
  automatic message is sent for it; a list never acknowledges, because a long list may not reach
  the agent in full. `ryco_task_cancel` stops the automatic return first and then interrupts the
  task's running turn through the normal routine interrupt request. A task whose first message
  was not sent yet (it waits for a free slot) has that message and the agent's own queued
  follow-ups taken out of its queue instead: it never starts, takes no slot, and reads as
  `interrupted`. A person's own queued messages stay. If the return is changing at
  that moment, it does not interrupt and asks for a retry.
- **Long results and messages.** A result read by `taskId` comes in pages of 8,000 characters:
  the reply is redacted as a whole first, so a page never shows part of a secret, and each page
  carries `version`, `offsetChars`, `totalChars` and `nextOffsetChars`. Passing `result: { version,
  offsetChars }` reads on. `ryco_read_thread` does the same for any message it cuts short (a
  message over 8,000 characters, or older messages past the page's 80,000-character budget): pass
  `message: { messageId, version, offsetChars }` to read up to 20,000 more characters. A message
  that is still streaming has no continuation yet, and a continuation of a message that changed
  since is refused. Offsets count UTF-16 code units and a page never splits a surrogate pair.
- **Stalled tasks.** A task that still runs but needs attention tells its delegating chat once per
  episode, with an automatic message that says it is still running and its result comes later:
  its first message started no turn within 3 minutes (`never-started`), it has waited 5 minutes
  for the person's approval or answer (`waiting-on-you`), or its provider was reported quiet on
  its running turn (`silent`, after the 15-minute liveness notice) and nothing happened since.
  `ryco_task_status` shows the current one as `run.stalled`. The message waits behind the same
  checks as results (the chat idle, in scope, not reverting, not stopped by the person, the
  delegating turn not reverted away) and, like a result, may start a chat's ended session through
  the shared cold-start budget. Stopping the turn a notice started stops that turn only; the
  task's result still returns. A task sends at most 3 such messages. Ryco never nudges,
  re-sends, interrupts or answers for a stalled task: that stays with the person or the
  delegating agent (`ryco_task_cancel`). The thresholds follow Synara's worker health.
- **Scope of the tools.** They cover only tasks created with `returnToOrigin` by this chat. Local
  Tasks and the standalone integrations' `ryco_read_task` / `ryco_wait_for_task` are separate.
  Return progress is also visible as `completionReturns` on the delegation request
  (`ryco_read_control_request`) and on its proposal card.
- **Returned artifacts.** A finished task's result brings back copies of the pages and files it
  published during its run (the newest 8; never ones that were handed over to it). They are
  attached to the automatic message, so the delegating agent receives them like an upload and they
  show in the chat's Artifacts tab, marked with the task they came from. A batch carries at most 8
  and 50 MiB in all; the message says how many stayed in their tasks. A returned artifact that is
  gone (its task was reverted) is left out.

### Delegation limits

Delegated tasks get the same Agent Control tools as the chat that started them, so a task can
delegate in turn. Settings → Integrations → **Delegation limits** can stop that from running away.
Both limits are off until the person sets them; agents cannot change them.

- A delegation tree starts at a chat that was not delegated itself (a chat the person started, a
  fork, an automation run). Its tasks sit one level down, their tasks two levels down.
- **How deep tasks can go** (1 to 10 levels). A task at the last level gets no delegation tools
  at all: `ryco_create_threads` and `ryco_start_local_task_chat` are not offered to it. A request
  from deeper down is refused with a message that names the limit.
- **Tasks per chat** (1 to 1,000). How many tasks one tree may create in all, finished, stopped
  and archived ones included. A task the person deletes no longer counts. A request whose batch
  does not fit is refused as a whole before it is approved or run.
- The limits are checked when a request is made, again before it runs, and once more for each
  task as it is created, so requests running at the same time cannot overshoot a budget.
- Limits apply to new requests. Tasks that already exist keep running, and a session that started
  before a lower depth limit keeps its tools until it restarts (its requests are still refused).
- Automation runs and chats a person starts are never children, so the limits do not cover them;
  automations have their own limit of 25 active per project.

## Pull request watches

An agent that waits on a pull request's checks or reviews calls `ryco_watch_pull_request` and ends
its turn, instead of polling, sleeping or running a watcher. The server reads the pull request every
2 minutes, with no app open, and wakes the chat with an automatic message when a check fails, the
required checks pass, someone else comments or reviews, or the branch starts to conflict (see
[Pull request watch](./pull-request-watch.md) for the reads, the fences and the limits).

- **Which pull request.** By default the one of the woken chat's workspace; one the agent just
  opened is discovered and linked first. A `number` or `url` may name a pull request of any
  workspace in the project, or one Ryco links to the woken chat's workspace once its repository
  matches the checkout's. The woken chat is the caller's own unless `threadId` names another chat
  of the project; the usual project, runtime-permission and worktree-isolation rules apply to it.
  Unwatching without a `number` or `url` stops the one pull request the chat watches (of several,
  the one of its own workspace); otherwise the answer asks which to stop.
- **Routine and quick.** Both tools need the `pull-requests.watch` grant and exact active-turn
  authority. The request runs at once and the tool waits up to 25 seconds for its outcome: the
  receipt's `result.detail` says what is watched and how the pull request stands now (failing checks
  are reported there, and only later changes wake the chat), or why it cannot be watched. When the
  answer says `timedOut`, follow it with `ryco_wait_for_control_request`.
- **Delegated chats.** A chat delegated with `returnToOrigin` whose result is still awaited cannot
  watch, and no chat can make it watch: it reports the pull request in its result, and the
  delegating chat watches it (a number or URL from another workspace of the project works).
- **Ending.** `ryco_unwatch_pull_request` stops the news; call it before handing the work back so the
  chat can settle (a watched chat never settles on its own). The user's Auto-fix CI keeps running.
  A watch also ends on merge, close, 8 failed reads in a row, 10 comment-only updates in a row,
  settling, archiving or a user Stop. A wake is news, not a merge decision.
- **Scope.** Agents cannot turn Auto-fix CI on or off. While Agent Control is off, an agent-started
  watch holds its news. Standalone integrations cannot watch pull requests.

## Command watches

An agent that waits on something that is not a pull request (an issue reply, another
repository's CI, a deploy, a release) calls `ryco_watch_command` with a read-only check, a label
and an interval, and ends its turn. Ryco runs the check with no model involved and wakes the chat
only when its output changes (see [Command watch](./command-watch.md) for the rules and numbers).

- **Own chat only.** The tools take no thread id: a watch always belongs to the caller's chat.
  Starting or stopping needs the `commands.watch` grant and exact active-turn authority; listing
  needs the grant. They run at once (no approval) and never reach standalone integrations.
- **Full access only.** The chat must be in Full access and default mode, because Ryco runs the
  command later without asking. Leaving either ends its watches.
- **Delegated chats.** A chat delegated with `returnToOrigin` whose result is still awaited cannot
  watch; it reports what to watch, and the delegating chat watches it.
- **Ending.** `ryco_unwatch_command` stops one watch or all of them; call it before handing the
  work back so the chat can settle. A watch also ends after 10 wakes, 7 days, 8 failed runs in a
  row or output over 4 KB, and with the chat's Stop, settle, archive or Trash. The user can stop
  one with the `thread.command-watch.stop` command. A chat's watches wake it at most 30 times a
  day. While Agent Control is off, no run starts and no wake is sent.
- **Visibility.** The command is visible to anyone who may replay the chat's events, as the
  agent's own tool call already is: keep secrets out of it.

## Worktree handoff

An agent that started in the project's shared checkout and finds the work needs its own branch
calls `ryco_worktree_handoff` with a new `branch`, and optionally `baseRef` (default: the branch
the shared checkout is on), `startFromOrigin` (fetch the base from origin first; default off),
`runSetupScript` (default on) and `continuationPrompt` (its next step, up to 120,000 characters).
`ryco_worktree_status` says whether the chat already works in its own worktree and which branch a
handoff would start from.

- **Own chat only.** The tools take no thread id. A handoff needs the `workspaces.manage` grant
  and exact active-turn authority (the status needs the grant). It is a routine request: it runs
  at once and the tool waits up to 50 seconds for the outcome. Standalone integrations cannot use
  it, and a delegated chat whose result is still awaited cannot move.
- **Refusals.** A chat that already has its own worktree, an archived or settled chat, a project
  that is not a Git repository, a branch that exists already, and a branch name Git rejects or
  that would shadow another ref. Branch names must be printable ASCII: anything else (accents,
  emoji, spaces, invisible and text-direction characters, look-alike letters) is refused, so a
  name never reads differently from what Git stores and never names an existing ref in another
  Unicode form. Refused as shadowing: names that start with `refs/`, `heads/`, `tags/`, `remotes/`
  or a configured remote's name and a slash (such as `origin/main`); Git's pseudo-refs (`HEAD` and
  every `*_HEAD` such as `FETCH_HEAD`, `AUTO_MERGE` and the others Git keeps beside them); names of
  4 or more hex digits only (they read as abbreviated commit ids); names of an existing branch, tag
  or remote branch; and names Git already resolves (a commit, `stash`). All of these compare
  without letter case, because a checkout on macOS or Windows keeps its refs in a file system that
  ignores case: there `MAIN` is `main`'s ref, and a worktree on it would move the shared
  checkout's `main` with every commit.
- **Same worktree as every other.** The worktree is made like a delegated worktree (path policy,
  setup ownership, `.worktreeinclude`, submodules) and gets its workspace record. The project's
  setup script starts in a terminal unless the agent skips it or the user turned setup scripts
  off. Uncommitted changes in the shared checkout stay there.
- **Order with the turn.** The chat is re-pointed at the worktree (`thread.meta.update` and
  `thread.attach-to-worktree`), and the continuation joins the chat's follow-up queue as the
  agent's. The turn that asked keeps running in the shared checkout, so the agent ends it right
  after the call; the queue sends the continuation once the chat is idle, and that turn starts in
  the worktree with the conversation carried over (a resume, or a context handoff for providers
  that keep conversations per directory). Without a continuation the chat waits there for the
  next message.
- **Stop.** The handoff checks the turn that asked one last time after the worktree is made and
  just before the chat moves. A Stop of that turn (or a newer turn in the chat) before that check
  rolls the handoff back: the worktree and its branch are removed, and nothing is queued. A Stop
  after it keeps the move, and the continuation is queued with the queue held, with the hold a
  Stop records (`interrupted`), so nothing starts until the person resumes the queue. The queue
  decides that hold together with the add (`thread.queue.add`'s `holdIfTurnInterrupted`), so a
  Stop that lands just before the add is held too; a newer turn pauses the queue instead.
- **Rollback.** If the chat is archived, settled, moved or deleted while the worktree is made, or
  the move is refused (the chat's branch changed since the check), the worktree and its branch
  are removed again. Once the chat points at the worktree, nothing removes it: a later failure
  (linking the chat to the worktree's record, queueing the continuation, starting the setup
  script) is reported in the answer. A setup script that fails to start is named in fixed words
  (such as "the worktree folder was not found"); the error itself goes to the server log. A restart in
  the middle finishes the move when the chat already points at the worktree (linking it to the
  worktree's record and queueing the continuation with the queue held, as after every restart),
  and otherwise removes the worktree and its branch. The worktree stays when the chat is deleted.
- **Answer.** The receipt plus `worktreePath`, `branch`, `baseRef`, `startedFromOrigin`,
  `setupScript` (`started`, `no-script`, `skipped`, `failed`), `continuation` (`queued`, `held`,
  `skipped`, `failed`), `worktreeAttached` (whether the chat was linked to the worktree's record)
  and a `note` for the agent. The worktree path is the chat's own new
  checkout; it is read from the chat for the answer, and neither the receipt nor its `note`
  keeps it. When the outcome is not in within the wait, the answer says so (`timedOut`) and its
  `note` tells the agent to end its turn. Calling again with the same `requestId` answers with
  that request's receipt, also once the chat has moved.

## Secret requests

An agent that needs a secret calls `ryco_request_secret` with an environment variable name
(`key`, `^[A-Z_][A-Z0-9_]{0,127}$`), a one-line `purpose` and a dotenv `file` relative to its own
thread's checkout (default `.env`). The user answers on a private card (web desktop and the native
app, not the frozen web phone tier), and the node writes `KEY='value'` into that file
([Secret requests](./user/secret-requests.md) has the user's side).

- **Grant and authority.** The `secrets.request` grant, issued to private provider sessions like
  the others, and exact active-turn authority. Never on the standalone endpoint. The card is shown
  in, and the file written to, the caller's own thread and checkout: there is no `threadId`.
- **Checked when asked.** The file must be a plain relative dotenv path (`.env`, `.env.*`,
  `name.env`, `.dev.vars`, not a code or config extension such as `.env.js`) with no `..`, link,
  trailing-dot or `.git` segment, inside the checkout and in the checkout's own repository (not a
  nested one or a submodule). Git must ignore it (`git check-ignore`) and track no file of that
  name in any letter case (`git ls-files ':(icase)<file>'`), and an existing file must be named
  exactly so. A bad file fails at once and opens no card. A thread holds at most 5 unanswered
  requests, also when the agent asks in parallel.
- **Waiting.** The call waits up to `waitMs` (default 30 s, at most 45 s) and answers `pending`,
  `provided`, `declined` or `expired`, with the key and file, never the value. Calling again with
  the same `requestId` (and the same key and file) waits on the same card; a `requestId` reused for
  another key or file is refused. While pending, the agent may end its turn instead.
- **Recorded.** The thread records only `secret.requested` (key, purpose, file, expiry and an
  opaque `checkoutId` of the checkout, never its path) and one `secret.resolved` (status)
  activity. A pending request counts as pending user input: it holds settlement, queued wakes and
  restart continuation, survives a turn's end and a restart, and expires after 24 hours (the node
  records the expiry, also after a restart, and retries a failed record with backoff; past its
  expiry a request no longer counts as pending even unrecorded).
- **The answer.** `secrets.answerRequest` is owner-only and never replayed. It is written only
  while the thread's checkout has the recorded `checkoutId` (a removed worktree or a moved thread
  is refused, never redirected to the project's folder). The node checks the file again and
  writes it atomically with mode 0600 (other lines kept, the key's old assignment replaced),
  through a temporary file in the repository's Git directory, one write per file at a time, and
  only then records `provided`. Values with `$` or a backslash are refused (dotenv-expand and
  python-dotenv change them even in single quotes). Refusals carry a fixed reason, never the
  value.
- **Transport.** The value travels over the answering client's connection: end-to-end encrypted
  on an E2EE relay channel, but the node's default `compatibility` E2EE policy also admits relay
  channels without it, and a plain `ws://` direct address is unencrypted. The node does not yet
  refuse answers on such channels.
- **Who else can read it.** Operators of a shared node can read the saved file with
  `projects.readFile`. Older clients and the web phone tier show the thread as waiting but have
  no card, so they can neither answer nor decline; the request then waits for its 24 hours.
- **Instructions.** Agents are told never to ask for secrets in chat, and to load a provided key
  from the environment without printing it or reading the file to see it.

## Tasks

The Tasks page is the user's to-do list on the node (problems, ideas, follow-ups), each task with
notes, a due day, a project, links (pull requests, issues, Jira items, branches, chats, pages) and
up to 8 files. Agents use it with the `ryco_*_local_task` tools. They are a different thing from
the runs a chat delegates (`ryco_task_status`).

- **Reading** needs the `local-tasks.read` grant: `ryco_list_local_tasks` (open, done or all tasks,
  by project or text, newest change first, with a notes preview; `offset` pages past the first
  answer's `nextOffset`) and `ryco_read_local_task` (one
  task whole, with its files and the chats started from it).
- **Changing** needs `local-tasks.manage` and exact active-turn authority, and runs at once.
  `ryco_create_local_task` takes a `requestId` that names the task, so a retry answers with the
  same one. `ryco_update_local_task` edits the title, notes, priority, due day, project or links
  (the whole list), and completes (`state: done`) or reopens a task; it passes the revision last
  read, and a task changed since fails until it is read again. `ryco_add_local_task_file` adds a
  regular file of the caller's workspace (a relative path, the same rules as `ryco_attach_file`);
  adding the same file again adds nothing. `ryco_remove_local_task_file` removes one.
- **Starting a chat**, `ryco_start_local_task_chat`, also needs `threads.create`. It submits a
  `ryco_create_threads` request with the entry's `localTaskId`, so the chat runs under that tool's
  project, runtime-mode and worktree rules, and `returnToOrigin` works as there. The first message
  is the task's title, notes and links unless a `prompt` is given. The chat is recorded under the
  task before it is dispatched and gets copies of the task's files; a task without a project joins
  the caller's, and one in another project can't be started from here. A completed task starts
  nothing. Starting a task's chat through `ryco_create_threads` needs `local-tasks.manage` too. A `ryco_create_threads` entry can carry
  `localTaskId` itself, but not together with `artifacts`.
- **Deleting** is never immediate: `ryco_propose_local_task_delete` asks the user, with the task's
  revision. The approved delete removes the task, its links and its files (its chats are kept), and
  fails if the task changed after it was requested.

Tasks are the node's own list, not one project's: these tools read and edit tasks of every
project. Only starting a chat is bound to the caller's project. Changes reach the Tasks page as
they happen. Standalone integrations have no task tools and cannot start a task's chat.

## Handing over artifacts

A thread's artifacts are the pages it published with `ryco_html_render`, the files it attached with
`ryco_attach_file`, and the ones handed over to it. The user's own uploads are not artifacts.
`ryco_list_artifacts` lists them with ids of the form `messageId:attachmentId`.

A `ryco_create_threads` entry's `artifacts` takes up to 8 of those ids (50 MiB in all). Each must be
one of the calling thread's own artifacts, checked when the request is submitted and again before
it runs, since a revert in between can drop one. Standalone integrations cannot hand over
artifacts. The new thread gets a copy of each, attached to its first message, so its agent receives
them like files the user uploaded (a page as its `.html` source) and they show in its Artifacts tab,
marked with the thread they came from. A copy never shares the source's file: deleting or reverting
either thread leaves the other's copy alone. A handed-over artifact is the receiving thread's own,
so it can hand it on to a thread it delegates in turn. The handover is provenance only: it grants
no access to the thread it came from.

## Ryco sessions versus standalone clients

There are two connection paths.

### Ryco-managed sessions

When Agent Control is enabled, supported provider sessions started by Ryco receive it automatically.
There is nothing to install in the provider's persistent MCP configuration. Access is private,
runtime-scoped, and revoked with the session or turn that received it.

The Integrations page reports this under **Ryco sessions**. Its purpose is to show which configured
providers support automatic access and which do not.

### Standalone provider clients

A Codex, Claude Code, Copilot, Cursor, Grok, or supported OpenCode client started outside Ryco needs
a durable external connection. Under **Standalone provider clients**, choose a detected provider
profile and select **Connect**. Ryco will:

1. create a separately scoped external integration;
2. store its credential in Ryco's private owner-readable runtime directory;
3. add a credential-free stdio bridge entry through that provider's native MCP authority;
4. re-read the native entry; and
5. launch the installed command, negotiate MCP, and verify the Agent Control tool catalog.

The installation is shown as connected only after all five steps succeed. The browser, provider
configuration, logs, and child-process environment never receive the raw credential.

The default connection can list allowed projects, request one task at a time, and read or wait for
tasks created by that integration. It covers current and future projects, allows 60 control calls
per minute, and has no expiry. Every requested Ryco mutation still needs approval. `ryco_wait_for_task`
returns as soon as the task's request is decided or finished. It re-checks the integration whenever
it changes and at least every 5 seconds, so revoking the integration ends a wait in progress at
once, and an expired integration or disabled Agent Control ends it within 5 seconds.

### Standalone read grants

Read access beyond the integration's own tasks is opt-in. Each grant is off by default, is set per
integration on the Integrations page, and only reaches projects inside the integration's project
scope. A thread, project, or workspace outside that scope reads exactly like one that does not
exist.

| Grant                       | Tools                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `external.threads.read`     | `ryco_list_threads`, `ryco_read_thread`, `ryco_search_threads`, `ryco_wait_threads`, `ryco_inspect_thread` |
| `external.reviews.read`     | `ryco_read_thread_diff` and the `review` section of `ryco_inspect_thread`                                  |
| `external.files.read`       | `ryco_read_thread_file`                                                                                    |
| `external.workspaces.read`  | `ryco_read_project`, `ryco_list_workspaces`, `ryco_read_workspace`                                         |
| `external.diagnostics.read` | `ryco_diagnostics_summary`, `ryco_usage_limits`                                                            |

These tools return the same bounded, redacted results as the private-session tools, with two
differences. Standalone inspection never returns terminal output, because that is where secrets
most often appear. Workspace reads have no calling thread, so no workspace is reported as
`current`. `ryco_usage_limits` covers every enabled provider instance whatever the project scope,
because usage belongs to the account, not to a project. `ryco_wait_threads` re-checks the integration whenever it changes and at least every 5
seconds, so revoking a grant or narrowing the scope ends a wait in progress at once, and disabling
Agent Control ends it within 5 seconds. Workspace files can include local
configuration such as `.env`, so grant `external.files.read` only to clients you would also let
read the checkout directly.

Integrations that can request tasks or automations also get `ryco_read_control_request` and
`ryco_wait_for_control_request`. They return receipts only for requests that integration created,
for example an automation proposal awaiting approval.

### Standalone control requests

Two more opt-in grants let a standalone client request changes. Every such request waits for a
Ryco user's approval, regardless of runtime mode; standalone requests never execute as routine
actions. Retrying with the same `requestId` and plan returns the original receipt, even after the
target changed; reusing a `requestId` with a different plan is refused.

| Grant                        | Tools                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| `external.threads.control`   | `ryco_send_message`, `ryco_interrupt_thread`, `ryco_update_thread`  |
| `external.workspaces.manage` | `ryco_plan_workspace_lifecycle`, `ryco_propose_workspace_lifecycle` |

A standalone client has no thread of its own, so its authority over a thread is the same ceiling
that bounds the tasks it can create. Without `external.runtime.full-access` it can only target
threads in `approval-required` mode and cannot raise a thread's runtime mode. Without
`external.checkout.shared` it can only target threads in an isolated worktree. A target outside
the project scope is reported exactly like a missing thread. The request captures the target's
state, and approval is refused at execution if that state changed (for example, the turn it meant
to interrupt already finished) or if the integration lost the grant.

Workspace lifecycle requests follow the [governed workspace lifecycle](#governed-workspace-lifecycle)
rules unchanged. A standalone client has no current workspace, so none is protected as current;
main, active, and unverifiable workspaces stay blocked.

Standalone integrations cannot create or remove projects, change settings, or use devices, the
computer, or the browser.

## Repair and disconnect

Use **Repair** after an interrupted install, a missing credential file, or a failed protocol check.
Ryco revalidates durable state and replaces only missing material or configuration it still owns.
Incomplete installations are also reconciled after a server restart.

Use **Disconnect** to revoke the external integration and remove its private credential. Ryco removes
the provider entry only when its current fingerprint still matches the installed version. If you
edited that entry, Ryco preserves it and reports that manual cleanup remains.

If both `ryco` and `ryco-agent-control` already name unrelated MCP servers, Ryco reports a conflict
instead of overwriting them. Rename one of those entries in the provider's native configuration and
retry.

## Manual setup

Advanced manual pairing remains available for unsupported clients or configuration environments
Ryco cannot mutate safely. It creates the same external security principal but requires you to run
the displayed pairing command and copy the generated MCP entry yourself. Pairing codes are
short-lived; do not place them or the resulting credential in provider configuration.

Provider-specific MCP behavior is documented in [Provider MCP management](./providers/mcp.md).

## Governed workspace lifecycle

Private Ryco sessions expose these project-scoped tools:

- `ryco_list_workspaces({ projectId, after?, limit? })`: pages of up to 50 workspace
  records and synthetic session groups, including archived and missing checkouts. Pass
  `nextCursor` as `after`. IDs are stable within the project. `origin: "manual"` does
  not imply a synthetic group: check `registration` and `worktreeId`.
- `ryco_read_workspace({ projectId, workspaceId })`: bounded session membership,
  archive/current/main protection, checkout existence, Git registration, commit IDs,
  dirty/unmerged state, and inspection blockers. No file contents or Git stderr are returned.
- `ryco_plan_workspace_lifecycle({ projectId, workspaceId, action, checkoutMode,
  sessions, deleteBranch })`: read-only preflight returning `{ plan, planDigest, blockers }`.
- `ryco_propose_workspace_lifecycle({ requestId, plan })`: submit the exact returned plan.
  Requires the `workspaces.manage` grant and exact active-turn authority. Every lifecycle
  action requires human approval, including in Full Access. Do not approve your own request.

Supported combinations:

| Action    | Checkout mode                      | Sessions                        | Branch                                                          |
| --------- | ---------------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `archive` | `remove-checkout` or `record-only` | `preserve`                      | Retain by default; explicit deletion only with checkout removal |
| `delete`  | `remove-checkout` or `record-only` | Explicit `preserve` or `delete` | Same                                                            |
| `restore` | `restore-checkout`                 | `preserve`                      | Must still exist; `deleteBranch: false`                         |

`record-only` requires both the exact path and its Git registration to be absent. It
never removes files, prunes Git registrations, or deletes a branch. This is the supported
cleanup for a retained registered **Manual** entry after external Git worktree removal.
Archiving a thread alone does not remove this workspace record. Synthetic groups have
no record to archive/delete; the tool reports that limitation without deleting history.

Checkout removal never uses force. It requires a registered checkout with no tracked,
untracked, or ignored changes and a branch merged into the project's current HEAD, or
proven merged the way workspace management proves it (the remote default branch contains
it, or its pull request merged at exactly its commit; see `docs/storage-management.md`).
Branch deletion uses the approved commit as an atomic compare-and-delete guard. Main,
current, overlapping, locked, active, or unverifiable workspaces are blocked. Restore
requires an archived record, an absent checkout, and a retained branch. A Git registration
left at the missing path (storage cleanup keeps one) is replaced when the checkout is
recreated; a locked one blocks.

Deleting with `sessions: "preserve"` atomically moves the exact associated sessions to
an existing registered main workspace and clears their removed checkout paths; history
and archive state survive. `sessions: "delete"` explicitly authorizes deletion of the
listed session histories. The authoritative orchestration command checks workspace and
project revisions, path, branch and session membership again before changing records.
No batch cleanup, rename, broad reconciliation, force option, or arbitrary command tool
is exposed by this workflow.

The normal immutable plan digest, request ID, approval and durable receipt protocol applies.
Retry an identical request ID/plan to recover its original receipt. A changed plan needs a
new request ID and approval. Read/wait for the receipt's terminal result. On failure,
`execution.workspaceLifecycle.completedSteps` records intent and completion checkpoints:
a `*-started` step without its `*-completed` counterpart has an **unknown outcome**.
Filesystem and record changes cannot share a transaction. A later failure can therefore
leave the checkout removed while its Ryco record remains. Recovery never repeats deletion
or recreates user files; inspect current state and prepare a new approved plan for any
remaining work. A failed receipt is not a claim that nothing changed.

Standalone integrations with `external.workspaces.read` can list and read workspaces in
allowed projects. Only `external.workspaces.manage` adds the plan and propose lifecycle tools,
and those requests always need approval (see
[Standalone control requests](#standalone-control-requests)). The private catalog is shared across supported
provider injection paths. No hosted, mobile authorization, or service-worker policy changes
are involved.
