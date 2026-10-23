# Selection to chat

On desktop and web, select 1–4,000 characters within one completed assistant message.
A toolbar offers **Add to chat**, **Add to Side**, and **New chat**. Streaming output,
message metadata, attachments, and selections crossing message boundaries are excluded.
The frozen web phone tier is unchanged.

**Alt+Enter** focuses the selection toolbar. Use arrow keys or Tab to reach an action;
Enter activates it. Escape dismisses the toolbar and restores transcript focus.

Lines of code from the Review and Files panels go to the composer as chips instead; see
[files and chat](files-to-chat.md).

- **Add to chat** adds the quote to the current prompt as a chip, after its text and
  attachments. It focuses the composer without sending.
- **Add to Side** appends the quoted text to the existing side draft without sending or
  changing its model. Side's question is a plain text field, so the quote goes in as
  quoted lines rather than a chip. Side remains temporary, read-only, and subject to its
  existing provider and connection restrictions.
- **New chat** opens a mini composer with the captured quote and a choice of project
  folder or a new worktree from the source thread's branch. **Open in chat** transfers
  the quote, as a chip after the question, to a separate full draft, even with no question
  entered. **Send** requires a question and transfers a snapshot to the existing first-turn
  queue.

The mini composer reuses the normal prompt editor. Minimize, Escape, and outside clicks
keep its text and location choice while the source chat remains mounted; **Resume new
chat draft** brings it back. Discard explicitly clears it. A pending operation cannot be
dismissed accidentally. Creation/navigation failures leave the mini draft available.
Changing routes without a successful handoff discards this temporary mini presentation.

New-chat creation leaves the project's pre-existing draft intact. Retries reuse the same
identity and refuse to replace a destination draft edited elsewhere. Both source file saves
and destination file saves pass through the existing autosave barriers. A failed first turn
keeps its complete quoted snapshot in the normal queue for explicit retry; it does not
silently retry or create another conversation. The existing queue is memory-only, so reload
has the same limitations as other queued messages. Full composer drafts use normal draft
persistence.

## Quote chips

A quote in the composer is a chip showing the start of the quoted text. Hover it to read
the whole quote and its comment.

- **Comment:** the pencil opens a short note for the agent about this quote (up to 4,000
  characters). The [Send shortcut](user/composer.md#send-shortcut) saves it (Enter by
  default), Shift+Enter adds a line, and Escape leaves the comment as it was. Saving an empty
  comment removes it. A chip with a comment shows a note icon.
- **Remove:** the cross takes the quote out of the prompt; Backspace after the chip does
  too.
- **Jump back:** clicking the chip scrolls to the quoted passage and highlights it. A quote
  from another thread opens that thread first, loading older history when needed. If the
  passage can no longer be found, the chip turns muted and says the source is no longer
  available. A history load that fails, on a dropped connection say, leaves the chip as it
  was.
- **Pending quotes:** while the prompt holds a quote, the quoted passage stays lightly
  highlighted in the answer it came from, in every chat pane on screen.

Each quote is the selected text plus up to 32 characters on each side of it, so the
passage is found again after the message re-renders. In the prompt it is one Markdown
link, `[preview](ryco-quote:v1/…)`, which carries the source ids, the quote, its context
and the comment. That text is what drafts, the prompt stash, copy and paste keep, so a
pasted quote becomes a chip again. A paste of chips alone never folds into an attachment,
however long their tokens; a paste whose other text is large enough to fold takes its
quotes into the file as quoted lines. Queued messages, stash entries and new thread titles show the quote's preview in quotation
marks instead.

## What the agent receives

Every send composes the prompt the same way on web, desktop and mobile: each quote chip
becomes `[Quote N]` where it stood, and one `<assistant_quotes>` block after the message
spells the quotes out once, before any file and terminal context. The block opens with a
short note saying the quotes are reference material. Each entry has a header line, the
quote as `>` lines and the comment indented under `Comment:`. Every quoted and comment line
is prefixed, so quoted text cannot end the block or pose as another entry. The expanded
prompt, with any effort prefix the model adds, counts against the 120,000-character input
limit; a draft that would run over it stays in the composer and says by how much.

A `/btw` question and a `/goal` objective are plain text, so the quotes in them become
`[Quote N]` and `>` lines with the comment below, as on the phone app. Side reads the quote,
and a goal's 4,000-character limit counts it in that form.

In the transcript, sent quotes show as chips again, and copying a message copies the text
as sent. ArrowUp brings a sent prompt back with its quote chips. Messages sent with the
older plain quote format keep rendering as before. The phone app shows quotes as readable
`[Quote N]` and `>` lines with the comment below, and the frozen web phone tier shows the
message as sent.

Quotes use the ordinary text payload, so all providers and existing send/queue recovery
paths receive identical context. No new RPC, provider runtime, service-worker cache, or
hosted lifecycle owner is introduced.

## Side failure recovery

If a Side request fails, is cancelled, or disconnects after a newer draft was entered,
the shared store retains one unsent question alongside that newer draft. Another ask is
blocked until the user restores the unsent question into the draft or explicitly discards
it. Repeated cancellation/disconnection cannot overwrite it. Web and native Side chat
expose the same recovery actions; `/btw` preserves its originating composer while recovery
is pending. This adds no native selection gesture or second state implementation.

Reference behavior: [Synara PR #1130](https://github.com/Emanuele-web04/synara/pull/1130),
merged September 11, 2026, and T3 Code's inline citations (v0.0.39). Implemented against
Ryco's shared draft and queue services; no upstream code copied.
