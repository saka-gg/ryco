# Forking a thread

A fork is a new thread that starts with a copy of another thread's conversation up to one reply.
You keep working in the fork while the original stays exactly as it was. Use it to try another
approach from an earlier point, or to continue a conversation in a fresh worktree.

## Where to fork

**Fork from here** appears on the reply of a completed turn: its last message from the agent. A
page or file the agent attached with a tool after writing its reply does not take the reply's
place; the fork still inherits it, together with system notes the turn added after the reply. A
turn whose only output is an attached page or file is forked from that attachment.

- On desktop and tablet layouts, it is an icon button next to **Copy** on that reply.
- In the native mobile app, it is a button below that reply.

It is not offered on your own messages, on commentary the agent wrote in the middle of a turn, on
a reply followed by a message you sent into the running turn (also one with only an image), on a
reply that is still being written, on a turn that was interrupted or failed, or on messages that
are not saved on the node yet. Clients and the node pick a turn's reply with the same shared rule;
the node also checks the turn's outcome (see [Limitations](#limitations)). The frozen web phone
layout does not offer forks.

Forking needs operator access to the thread's node, and a node that supports forks. A node running
an older Ryco shows no fork button.

The dialog shows the thread and the reply you fork from, where the fork works, and how its agent
continues. **Cancel** creates nothing. **Fork** creates the thread and opens it; the original stays
in your history, so **Back** returns to it. While the request is on its way, the dialog cannot be
closed; see [Retries, interruptions and restarts](#retries-interruptions-and-restarts) for what it
shows when the outcome is not known yet.

## What the fork contains

The fork inherits every message of every turn up to and including the turn of the reply you
picked, and nothing after it. Messages keep their original text, order and time. Later messages of
the original are never copied, even when a later message was sent while the picked turn was still
running.

Also copied:

- attachments of inherited messages, as the fork's own copies, so deleting or reverting the
  original never removes them,
- proposed plans of inherited turns (a plan carried out after the picked reply counts as not
  carried out in the fork),
- tool activity of inherited turns, for display.

Not copied: approvals and questions, checkpoints, setup-script output, model-switch dividers, and
other state that belongs to the original's sessions. The fork has no turn of its own yet: nothing
is sent to the agent until you send a message, and the composer starts empty.

The fork is titled `<original title> (fork)` and uses the original's model, access mode,
interaction mode and token mode. Its timeline starts with the inherited conversation, followed by
a **Forked from “<original title>”** divider that links to the reply you forked from. Once the
original is deleted, the divider says so instead. The fork appears at the top of recently used
lists, like a new thread: the inherited messages do not count as activity of the fork, and usage
statistics and daily recaps leave out the inherited turns. Unlike a new thread, a fork already
holds a conversation before you send anything in it, so it can be archived, and removing its
workspace's checkout archives it with the workspace's other conversations.

A fork can inherit at most 2,000 messages; a longer conversation cannot be forked. When older
proposed plans or tool activity do not fit (200 plans, 2,000 tool events), the newest are kept and
the divider notes it.

## Where the fork works

The choices depend on the original thread:

| Original thread        | Destinations                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| Project with Git       | **This worktree** or **The current checkout** (shared), or **New worktree** |
| Project without Git    | **This folder** (shared)                                                    |
| Chat without a project | **New chat**                                                                |

### Sharing the current checkout

The fork works in the same checkout as the original: the same folder, branch and workspace. No
file is copied, changed or rewound, and Ryco runs no Git command. The files are whatever the
checkout contains now, which may differ from the point you forked from. Both threads change the
same files from then on.

### New worktree

Ryco creates a new branch, `<worktree branch prefix>/fork-<8 characters>`, and a worktree for it in
the project's worktree root, named like other managed worktrees. Pick how it starts:

- **Saved checkpoint of this turn.** Files match the end of the picked turn. Ryco checks out the
  original checkout's current commit, then lays the turn's checkpoint over it. Tracked files and
  new files that were not ignored match the turn; commits made after the turn show as uncommitted
  changes. Ignored files, such as `.env`, dependencies and build output, are not included, and
  neither are the contents of nested repositories and submodules. Only available when the turn
  has a saved checkpoint and the original's checkout still exists; otherwise pick a branch or
  commit.
- **Branch or commit.** A clean checkout of the branch, tag or commit you enter. Its files may
  differ from the point in the conversation you forked from.

Ryco never copies uncommitted or ignored files from the original checkout, and never changes the
original checkout or other worktrees. When the project's **Run setup script** preference is on, the
setup script starts in the new worktree, as for other new worktrees. It starts once Ryco has
recorded the fork as created, and at most once: if the node stops in that very moment, the script
does not start, and Ryco never runs it a second time in a worktree the fork's agent may already
work in.

### New chat

Forking a chat creates a new chat with its own, empty folder. Files from the original chat's
folder are not copied. Ryco's apps keep one thread per chat, so a chat cannot be forked into the
same folder.

## How the agent continues

| Provider                                                    | Continues with                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Codex                                                       | An independent copy of its session that ends with the picked turn |
| Claude                                                      | An independent copy of its session that ends with the picked turn |
| OpenCode, GitHub Copilot, Cursor, Grok and other ACP agents | A fresh session that receives the conversation as context         |

**Native copy (Codex, Claude).** Ryco asks the provider to copy the original's session through the
picked turn: Codex `thread/fork` with that turn as the last turn, and Claude's session fork up to
the turn's last transcript entry. Ryco finds that entry in the original's transcript the moment you
fork and copies up to exactly it later, so turns the original runs while the fork is prepared never
reach the copy. Ryco reads the copy back and uses it only when it is exactly the original's
conversation through that turn, in the fork's folder. The fork's agent then resumes this copy, with
its tool results and reasoning, on your first message.

**Context handoff (everything else).** The fork's first message starts a fresh session on the same
provider instance. Ryco sends a context document built from the fork's own inherited history ahead
of your message, as described in [Context handoffs](context-handoffs.md#forks). The timeline shows
a divider when it is delivered. Native tool state and reasoning are not carried over, inherited
attachments are not sent to the provider, and very long conversations are trimmed to the provider's
input limit.

These providers continue by handoff because their native fork cannot stop exactly at a picked
turn: OpenCode's fork cuts by message position, which Ryco cannot yet prove matches its turns;
GitHub Copilot's fork is experimental and needs provider event ids Ryco does not record; and the
Agent Client Protocol fork used by Cursor, Grok and other ACP agents copies the whole session with
no cutoff.

A Codex or Claude fork also continues by handoff when an exact copy is not possible or not proven:

- the original has no resumable session on the instance it uses (for example, it never ran, or its
  model was switched to another instance),
- the picked turn is not part of that session anymore (for example, it predates a model switch, or
  a Claude checkpoint revert is still pending),
- for Claude, you forked the newest reply while the original was running, or about to run, another
  turn: where the picked turn ends in the transcript cannot be proven then,
- the provider configuration changed after you forked, or the provider refused the copy,
- Ryco could not confirm whether the provider made the copy. Ryco then never tries again and never
  uses that copy; the divider notes that an unused copy may exist. When the provider did return the
  copy's id, Ryco records it and removes the copy once the fork is created. A copy the provider
  confirmed but the node could not record is removed right away.

The fork and the original are independent from then on. The fork has its own provider session.
Sending, stopping or reverting in the fork never touches the original's session or files, and the
other way around. A checkpoint revert in the fork only reaches back to the fork's own turns: the
inherited conversation always stays. A native fork can undo its first own turn; its agent then
rewinds to the end of the inherited conversation. A fork that continued by handoff cannot undo its
first own turn, because that turn carried the inherited context into the new session: the node
refuses it, exactly as it refuses undoing the turn of a model switch (see
[Context handoffs](context-handoffs.md#forks)). Fork the original again instead.

## Retries, interruptions and restarts

Every fork request carries a fork key. The node records the fork under its key before it creates
anything and creates at most one fork per key; every error it reports also says what it still holds
for the key: nothing, a fork attempt that stopped, or one that is still being prepared. The web and
mobile apps follow one shared set of rules on top of that:

- Retrying never creates a second thread, worktree or provider copy. A retry after success opens
  the existing fork, and so does opening **Fork from here** on the same reply when a fork finished
  while its dialog was gone. If that fork's thread was deleted since, the dialog starts a new
  attempt instead.
- The dialog cannot be closed while a request is on its way. Once it can, closing it keeps an
  attempt that is not settled yet: opening **Fork from here** on the same reply again shows that
  attempt, with the same key and choices, instead of starting a new one.
- If the connection drops while forking, Ryco cannot tell whether the fork was created; the fork
  continues on the node. The dialog keeps your choices locked and offers **Retry**, which sends the
  same request under the same key and either joins the fork or returns its result.
- If the node restarts while forking, it finishes the fork once it is ready again, from the last
  recorded step.
- If a step fails in a way that can pass (for example, the node could not publish the fork or check
  its folder for a moment, or the run stopped unexpectedly), the fork stays recorded where it
  stopped and the node reports it as still being prepared. The node then finishes it on its own: it
  tries again after a few seconds, then at growing intervals of up to 10 minutes, and again when it
  restarts. The choices stay locked and **Check again** continues it right away. The dialog never
  starts another fork meanwhile.
- The node does not try forever. Once 10 of its attempts in a row stopped (about an hour), or 3 once
  the fork has not advanced for a day (for example on a node that keeps restarting), it stops
  trying: it removes what it created for the fork and reports the failure, so the dialog no longer
  shows the fork as being prepared. When the fork stopped while its checkout was being prepared,
  **Retry** starts it again with the same choices; when it stopped later, fork again, because Ryco
  never asks the provider for a second copy under one key. A fork that was already created is never
  undone this way; the node only completes it.
- When the node refused a request before recording anything (for example, the reply is no longer
  the end of its turn, or the branch or commit you entered does not exist), you can change your
  choices and fork again from the same dialog. When the turn's checkpoint cannot start a worktree,
  the dialog switches to **Branch or commit**, prefilled with the original's branch (or `HEAD`)
  unless you already typed one. When Git could not run or a folder could not be read for a moment,
  the node says the request can be retried, and the dialog keeps your choices, including the
  checkpoint start.
- When an attempt stopped after Ryco removed what it had created (for example, Git could not create
  the worktree), **Retry** with the same choices starts it again under the same key. Changing the
  choices sends them as a new attempt under a new key; the stopped attempt never resumes.
- If a fork can no longer be created (for example, its project or folder was deleted or moved, the
  project is no longer a Git repository, the worktree root setting or the node's workspace access
  policy does not allow the new worktree's folder, or the original's checkout was removed before
  the fork was created), Ryco removes what it created for this fork (the new worktree and branch, a
  native copy, an empty new chat folder, copied attachments) and only then reports the failure. The
  node checks the project's folder and Git repository before it reserves a folder for a new
  worktree, so such a fork fails at once instead of being retried. Until that cleanup succeeds, the
  fork stays recorded as still being prepared and the node keeps retrying the cleanup, as a retry or
  a restart also does. When the project's repository itself was deleted, or lost its Git data, Git
  can no longer remove the new worktree, so Ryco removes the worktree's folder directly. A new chat
  a fork is still preparing is never removed by the startup cleanup of unused chats.
- Ryco never removes anything it did not create. It deletes the fork's branch only while the branch
  still points at the commit the fork started from, so a branch someone else created or moved under
  the same name stays.
- A fork that stopped and is never retried keeps its start commits reachable for 7 days, then Ryco
  releases them and the fork can no longer be retried. Fork again instead. This holds however long
  the node keeps running: a retry after the 7 days is refused, and the node releases the commits
  within about 15 minutes.
- A fork whose thread was deleted later is not recreated by a retry.
- The apps remember an unsettled attempt only while they run. After an app restart the dialog starts
  a new attempt; the node still finishes (or, as above, stops) a fork it recorded on its own, and a
  finished fork then appears in the thread list.

Each node prepares at most two forks at a time; further forks wait their turn. Asking again about a
fork that already finished, or that stopped for good, is answered right away.

## Limitations

- Clients only know the outcome of a thread's latest turn. For an older reply, the node checks the
  turn and refuses a turn that was interrupted or failed. In a fork this includes the turns it
  inherited: each keeps how it ended in the original, so a fork of a fork never starts from a reply
  of a turn that was interrupted or failed.
- Turns are ordered by the time the sending device stamped on them. When a device's clock was so far
  off that this order disagrees with the order the node recorded, the node refuses to fork from the
  affected replies rather than guess where they end.
- An inherited attachment whose file is missing on the node, or could not be copied, is left out
  of the fork, and the divider notes it.
- When settings leave a new worktree's submodules uninitialized, the fork's divider says so, with
  the same notice other new worktrees show.
- Forks run on the original's node; you cannot fork a thread onto another node.
- A fork of a fork works the same way. Its lineage points to the thread it was forked from.
