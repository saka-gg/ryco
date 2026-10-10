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

Relocation handoffs use deterministic ids that derive from the `thread.turn-start-requested`
event:

- handoff id: `context-handoff:cwd-relocation:<event id>`
- activity id: `context-handoff-activity:cwd-relocation:<event id>`
- command id of the appended activity: `server:cwd-relocation-handoff:<event id>`

Because of these ids, a replay, retry or restart finds the same operation instead of starting a
second one. At startup, a relocation turn start that never reached the provider is abandoned
through the same deterministic reference. It ends as a failed divider, and sending the message
again retries it.

Handoff activity payloads carry a `reason`. It is `model-change` for a selection staged by the user
and `cwd-relocation` for a working-directory move. Records written before reasons existed have no
`reason`; they are model changes. The operation record does not persist the reason, so the
terminal activity copies it from the `requested` activity it replaces. Clients present a relocation
divider as a fresh session in the new folder, not as a model switch.

**Fallback.** A resume after a move can fail because the provider cannot find the conversation,
for example Codex `thread/resume` on a missing rollout, or Claude's "No conversation found". In
that case the turn continues with the same relocation handoff instead of failing. This applies to
every provider, including those that report `resumeSurvivesCwdChange`. Errors qualify when they
name a missing thread, conversation or session.

A session restart without a message, such as a runtime-mode or token-mode change, never resumes a
conversation that cannot follow the move. The live session keeps running in its old directory,
and the next turn moves the conversation. Restarts keep their own failure behavior and get no
handoff fallback, because they have no message to carry the context. Relocation handoffs are
started by the server. They therefore also run for messages sent from clients that cannot stage a
handoff themselves.
