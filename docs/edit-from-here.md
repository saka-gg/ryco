# Edit from here

**Edit from here** appears under a sent message whose turn has a checkpoint: next to its copy
button on web and desktop, and under the message in the mobile app. It rewinds the thread to
before that message and returns the message to the composer, so you can change it and send it
again. Any draft you have not sent stays above the returned prompt.

Ryco asks how far to go back:

- **Revert and keep changes** rewinds the conversation only. The agent forgets this message and
  everything after it, and the thread drops them. Files stay exactly as they are, including the
  changes the removed turns made; when the revert finishes, Ryco names the files those turns
  changed. The next turn's changes then include those edits.
- **Revert files too** also puts the checkout's files back to how they were before the message.
  Changes since then are discarded, including your own edits. Ryco refuses this when another
  thread or agent session works in the same checkout, or changed it after that point, since
  restoring would erase its work. Changes another thread kept with **Revert and keep changes**
  count as its work too, also after a later revert of that thread failed.

Either way the prompt and its attachments return to the composer once the machine has rewound the
thread. The prompt comes back as it was sent: an Ultrathink prefix stays, and terminal output that
was attached comes back as text at the end of the prompt. Ryco reads the attachments before it
reverts, because the revert deletes the sent copies; when they cannot be read, or the composer has
no room for them, nothing is reverted. In the mobile app, a prompt whose revert finishes after you
left the thread waits for you in that thread's composer.

The thread stays busy until the machine has answered, also when you switch to another thread and
back. When the machine refuses the revert, Ryco says why and the message stays where it was. When
Ryco cannot confirm the revert, because the connection dropped or the machine never answered, the
prompt still comes back, with a note to check the thread before you send it. After a dropped send,
Ryco watches for a minute; once the machine shows it took the revert, the thread stays busy until
that revert finishes.

Nothing changes when the agent cannot forget turns (Ryco says so before asking anything), while a
turn runs or waits for your answer, or when the revert would cross a model switch (see
[context handoffs](context-handoffs.md)). A revert never undoes actions outside the checkout or
memory the provider keeps elsewhere.

**Undo** on a turn's changed files is the files revert alone: it asks for a confirmation and
does not return the prompt. A turn after **Revert and keep changes** starts from that checkpoint,
so its changes include the kept edits and its Undo discards them too; the confirmation, like
**Revert files too**, says so.

## Compatibility

Keeping the files is a command of its own, `thread.conversation.revert`. A node that does not
advertise the `conversationRevert` capability only offers **Revert files**, and an older node
rejects the command rather than restoring files. Ryco reads the outcome from the revert's journal
row; a node from before that journal (v0.1.30 and older) is followed by watching the thread
rewind or its failure row. If Ryco stops in the middle of a revert, startup recovery finishes it
the way you chose: a revert that keeps the files never restores them.

To branch off without rewinding this thread, use [Fork from here](thread-forks.md) on a reply.
