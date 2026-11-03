# Context handoffs

Ryco can continue one visible thread with a different provider instance or model. On supported
desktop and tablet layouts, choose the target while the thread is idle and send the next message.
The selection is only a local composer draft: it creates no provider session, server activity, or
timeline marker until that message is sent. Options-only changes, such as reasoning effort, remain
ordinary turns.

The send uses the existing `thread.turn.start` command. The server rechecks that the thread has no
running or starting turn, pending approval or question, queued/local dispatch, worktree setup,
checkpoint revert, or other active handoff. A busy-state race rejects the send without changing the
canonical provider selection; the composer keeps the message and staged target for a predictable
retry. The frozen web phone provider flow does not offer handoffs.

A thread can be idle while its provider runtime still runs native background tasks (subagents,
background shells, watch loops). A handoff stops that runtime, and the tasks with it. So does a
model or option change on a Claude instance, which restarts the Claude session. The server refuses
either send before recording anything and names the live tasks in the refusal. The composer then
offers **Stop tasks and switch**: it sends the same message again under the same command id, marked
to proceed, and replacing the runtime ends the tasks. Nothing is stopped before the server accepts
the switch. Cancel keeps the message and the staged target; on mobile a queued message waits for an
explicit retry. The server refuses only sends that ask for it (`keepBackgroundWork`), and current
clients mark every send. Sends from clients that predate the choice switch as before, because an
older mobile outbox would drop a refused message. Only tasks of the thread's current runtime count,
and background liveness is held in memory, so after a server restart no task blocks a switch.
Runtime-mode and token-mode changes also restart the session but are not guarded yet.

## Runtime and context model

Every version 1 target is a fresh provider-native runtime, including a return to a provider used
earlier in the Ryco thread. Ryco never resumes an older native conversation for a handoff. Before
starting the target, the server builds a deterministic context document from canonical Ryco
history before the triggering message. It includes allow-listed messages, plans, useful tool and
terminal results, paths and file/checkpoint summaries, relevant failures or questions, completed
subagent summaries, and prior boundary metadata.

Hidden reasoning, protocol noise, telemetry, arbitrary unknown payloads, target startup events,
the triggering message, and prior context bodies are excluded. Rendering is section-aware,
Unicode-safe, and bounded by the provider input limit. The provider receives one context envelope
followed by the exact current user message. The visible canonical message is never rewritten.

The large structured document lives only in the server-local `provider_context_handoffs` table.
It is not copied into orchestration events, snapshots, RPC responses, activities, logs, or
analytics. Timeline activities contain only small boundary metadata and a digest.

The document and the prepared delivery payload each carry a sha-256 digest of their canonical JSON.
Every load checks the digest against the JSON as stored, before validating it, and refuses a
document that was changed afterwards. Values are stored in the form validation reads back: a value
cut to its length limit drops any whitespace left at the cut, and a shortened entry is marked
`truncated` only where its format has that flag. Rows written by earlier versions, which could keep
such whitespace, still verify, and so does a stored payload whose digest covers the context exactly
as the provider received it.

## Durability and failure behavior

The operation records `requested`, `preparing`, and `dispatching` before provider delivery. Target
acceptance is durably recorded before Ryco commits the target model selection and replaces the
pending activity with a persisted timeline divider. A successful thread can repeat handoffs such
as A → B → C → A while retaining every divider and its original provider/model presentation.

If startup or delivery is rejected before acceptance, Ryco stops partial target state, restores an
exact still-live source binding when possible, preserves the source model selection, and shows a
failed divider. If the server restarts after dispatch and acceptance cannot be proved, recovery
marks the operation `delivery-uncertain` and never blindly resends the message. Both outcomes remain
visible after reload and can be retried with a new send.

A source that cannot be put back is shown in error with the failure's message, and a failed handoff
never blocks the next one: the next send prepares a new handoff. Earlier versions refused some
intact stored documents with a digest error. At startup, a thread whose session still shows that
error is put back to rest (`stopped`, no error) when the failed handoff's stored document verifies
now. This is not new activity, so a snoozed thread stays snoozed.

Every provider event is checked against both its `ProviderInstanceId` and `RuntimeSessionId` before
any lifecycle, message, tool, request, plan, checkpoint, activity, or buffer mutation. Late events
from earlier epochs—including `session.exited` after A1 → B → A2—are dropped. Different-instance
cleanup is bounded and retried asynchronously; same-instance fresh replacement fails explicitly if
the prior thread-keyed runtime cannot stop safely.

Provider-native rollback is limited to the active runtime epoch. Ryco rejects a revert that would
cross the latest successful handoff boundary before changing either provider conversation state or
the filesystem. Cross-epoch provider-native resume, delta context transfer, and cross-process
exactly-once delivery are deliberate version 1 non-goals.

## Working-directory moves

A thread's working directory can move after its native conversation last ran. This happens when a
chat is turned into a project (see [Chats without a project](chats.md)), when a project's workspace
root changes, or when a worktree is relocated. On the next turn start, the server compares the
thread's current working directory with the directory where the conversation last ran. With a
live session, that is the session's directory, provided the session has a resume cursor. Without
one, it is the directory of the persisted binding, provided the binding belongs to the same
provider instance and has a resume cursor. Both paths are compared after symlinks are resolved.

When the directory moved, the outcome depends on the provider instance:

- **Native resume.** Providers whose adapter reports `resumeSurvivesCwdChange` resume normally in
  the new directory. Today only Codex does.
- **Relocation handoff.** For all other providers (today Claude, GitHub Copilot, OpenCode and
  Cursor), the server continues the turn with an ordinary `full-context-fresh-session` handoff on
  the same provider instance. The target is the turn's own model selection. Nobody stages it in the
  composer: the server appends the `requested` activity itself. The coordinator, operation record,
  context document, durability rules and timeline divider are the same as for a model change.

Relocation handoffs, and the [missing native history](#missing-native-history) handoffs below,
use deterministic ids that derive from the `thread.turn-start-requested` event:

- handoff id: `context-handoff:cwd-relocation:<event id>`
- activity id: `context-handoff-activity:cwd-relocation:<event id>`
- command id of the appended activity: `server:cwd-relocation-handoff:<event id>`

Because of these ids, a replay, retry or restart finds the same operation instead of starting a
second one. A turn start becomes at most one such handoff, so both kinds share the ids: a replay
that meets the other kind of failure still finds the first operation. At startup, a relocation
turn start that never reached the provider is abandoned through the same deterministic reference.
It ends as a failed divider, and sending the message again retries it.

Handoff activity payloads carry a `reason`. It is `model-change` for a selection staged by the user,
`cwd-relocation` for a working-directory move, `native-history-unavailable` when the provider no
longer has the conversation, and `fork` for the first message of a fork that continues by handoff
(see [Forks](#forks)). Records written before reasons existed have no `reason`; they are model
changes. The operation record does not persist the reason, so the terminal activity copies it from
the `requested` activity it replaces. Clients present a relocation divider as a fresh session in
the new folder, not as a model switch.

**Fallback.** A resume after a move can fail because the provider cannot find the conversation,
for example Codex `thread/resume` on a missing rollout, or Claude's "No conversation found". In
that case the turn continues with the same relocation handoff instead of failing. This applies to
every provider, including those that report `resumeSurvivesCwdChange`. Errors qualify when they
say the thread, conversation or session itself is missing ("thread not found", "No conversation
found", "no such session"). An error that only mentions a thread next to some other missing thing,
such as "for thread t-1: codex binary not found", does not, and neither does one where the noun
describes something else, such as "Unknown session mode".

A session restart without a message, such as a runtime-mode or token-mode change, never resumes a
conversation that cannot follow the move. The live session keeps running in its old directory,
and the next turn moves the conversation. Restarts keep their own failure behavior and get no
handoff fallback, because they have no message to carry the context. Relocation handoffs are
started by the server. They therefore also run for messages sent from clients that cannot stage a
handoff themselves.

## Missing native history

A thread's native conversation can disappear while the thread still has history: Claude deletes
transcripts after its cleanup period (30 days by default), a Codex rollout can be lost, and a node
can move to a machine without the provider's store (for Claude, only detected as described below).
A thread has history when a turn reached the provider, whether it completed, was stopped or failed,
when a message was sent to it before this start (its prompt may have reached the provider before
Ryco recorded that the turn started), or when it has a parent thread (a fork's inherited history).
Only messages recorded before the turn's own message, or before a restart was requested, count: a
message queued while the start resolves never reached the provider. A message recorded at the same
instant counts. When a turn start's resume finds no conversation on such
a thread, the turn continues with a `full-context-fresh-session` handoff on the same provider
instance, with reason `native-history-unavailable`. It works like a relocation handoff: the server
appends the `requested` activity itself, the target is the turn's own model selection, and the
coordinator, operation record, context document, digest checks, durability rules and divider are the
same as for a model change. A restart that cannot confirm delivery marks it `delivery-uncertain` and
never sends the message again.

How the missing conversation shows depends on the provider:

- **Codex**, **OpenCode** and ACP agents that resume strictly fail the resume itself
  (`thread/resume`, OpenCode's session lookup, `session/load` or `session/resume`). Errors qualify
  when they say the thread, conversation, session or rollout itself is missing ("no rollout found
  for thread id …", "Session not found"), as above. An ACP agent's standard "Resource not found"
  answer (-32002) to that resume, and OpenCode's not-found answer to its session lookup, count as a
  missing session; the same answers to any other request do not.
- **Claude** accepts a resume of a deleted session and fails it only on the first prompt, after the
  turn reached the CLI. When the first turn of a running session completes, the server checks
  whether the session's transcript (`<session id>.jsonl`) is in one of the project directories of
  the instance's Claude config directory, and marks the resume cursor when it is. Before it
  resumes a marked session, the server checks that the transcript is still there. Only a readable
  `projects` directory whose project directories hold no such file counts as missing. An unmarked
  session (the CLI runs through a wrapper, in a container, or with a config directory set only
  inside a wrapper, so its transcripts never showed in that config directory, or a cursor from an
  older release) is never checked. A config directory without a `projects` directory, a missing
  config directory, any other read error, and a check that takes longer than two seconds read as
  unknown. These resume as before and leave the decision to Claude, whose failure then shows on
  the first send as it did before. A node moved to a machine is therefore covered for Claude only
  when the session was marked and that machine's config directory already has a `projects`
  directory without the transcript.
- An ACP agent that does not resume strictly and starts a new session when its `session/load`
  fails (Cursor does today) still does so silently and shows no divider: the server never learns
  that the history is gone. Detecting it is a follow-up.

A thread without history has nothing to carry, and its provider never kept a conversation for it
(Codex writes a rollout and Claude a transcript with the first turn, so a cursor from a prewarm or
an unprompted session names nothing). Its start, or a restart of its session, retries with a fresh
session, without a handoff. On a thread with history, a session restart without a message (a
runtime-mode or token-mode change) keeps the provider's failure, as after a move; this includes a
restart right after a message was sent, before the provider reported its turn. The server logs
the provider's error either way. A false positive costs a visible fresh session, never a silent
rebuild.

Clients present the divider as a fresh session and say that the provider no longer has the
conversation's history. Clients older than this reason cannot decode it and show no divider for
these handoffs; the message and the reply still show. A server downgraded to a release older than
this reason cannot decode these handoffs either. It treats a handoff it cannot read as still in
progress, so on such a thread it refuses checkpoint reverts, chat promotion and model-change
handoffs until the server is upgraded again. From this release on, the server decides whether a
handoff is still in progress by its status alone, so a finished handoff with a reason it does not
know never blocks a thread.

## Forks

A [fork](thread-forks.md) whose provider cannot make an exact native copy of the original's session
continues by handoff. The fork owes its provider the conversation it inherited: its `thread.forked`
provenance activity records `providerContext: "handoff"`, and no provider session or binding
exists for it yet.

The first message sent in such a fork becomes a `full-context-fresh-session` handoff with reason
`fork`. The decider adds it to that `thread.turn.start`, exactly like a staged model change: the
same ids (`context-handoff:<command id>`), operation record, durability rules and divider. The
target is the selection the message is sent with: the model the fork inherited, or the one you
switched to before sending. A switch does not add a second handoff; the `fork` handoff carries the
conversation to the new selection, and clients name the model it switched from. The context
document is built from the fork's own history, which consists of the inherited messages and
therefore ends at the reply the fork was made from; the original thread is never read, and its
later messages are never included.

The handoff stays owed until one is consumed. A failed or `delivery-uncertain` handoff leaves it
owed, so the next message tries again with a new handoff. The rule reads only the fork's
`thread.forked` activity and its consumed `context-handoff` activities, which both survive the
activity cap and a restart. A fork that continues natively never gets this handoff; switching its
model before the first message is an ordinary `model-change` handoff. The handoff does not depend
on the inherited history holding a prompt: a fork whose inherited history starts with a reply (an
imported turn whose prompt had no text) still hands it over on its first message. The document
lists every inherited item before the fork's own, whatever time the sending device stamped on the
fork's messages.

Reverts in such a fork follow the handoff boundary rule above. The fork's first own turn carried
the inherited conversation into the fresh session, so a checkpoint revert that would undo that turn
(undoing the fork's first message reverts to checkpoint 0) is refused with `handoff-boundary`
before anything changes, exactly like a revert across a model change; reverting to that turn's
checkpoint or later works. The web app still offers undo on that turn, as on the turn after a model
change; the node then reports the revert as failed and changes nothing. A fork that continues
natively has no such boundary: a revert to checkpoint 0 rewinds its copied session to the end of
the inherited turn.

Clients present a fork divider as the inherited conversation being sent to a fresh session. When
that first message also switched model past the model-change threshold, the divider names the model
it switched from, and lists such as the Inbox count it as a model change too.
