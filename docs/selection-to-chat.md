# Selection to chat

On desktop and web, select 1–4,000 characters within one completed assistant message.
A toolbar offers **Add to chat**, **Add to Side**, and **New chat**. Streaming output,
message metadata, attachments, and selections crossing message boundaries are excluded.
The frozen web phone tier is unchanged.

**Alt+Enter** focuses the selection toolbar. Use arrow keys or Tab to reach an action;
Enter activates it. Escape dismisses the toolbar and restores transcript focus.

- **Add to chat** appends an attributed quotation to the current prompt without replacing
  its text or attachments. It focuses the composer without sending.
- **Add to Side** appends the quotation to the existing side draft without sending or
  changing its model. Side remains temporary, read-only, and subject to its existing
  provider and connection restrictions.
- **New chat** opens a mini composer with the captured quote and a choice of project
  folder or a new worktree from the source thread's branch. **Open in chat** transfers
  the quote and prompt to a separate full draft, even with no question entered.
  **Send** requires a question and transfers a snapshot to the existing first-turn queue.

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

Quotation formatting is shared, with scoped source thread/message identifiers. Quotes use
the ordinary text payload, so all providers and existing send/queue recovery paths receive
identical context. No new RPC, provider runtime, service-worker cache, or hosted lifecycle
owner is introduced.

## Side failure recovery

If a Side request fails, is cancelled, or disconnects after a newer draft was entered,
the shared store retains one unsent question alongside that newer draft. Another ask is
blocked until the user restores the unsent question into the draft or explicitly discards
it. Repeated cancellation/disconnection cannot overwrite it. Web and native Side chat
expose the same recovery actions; `/btw` preserves its originating composer while recovery
is pending. This adds no native selection gesture or second state implementation.

Reference behavior: [Synara PR #1130](https://github.com/Emanuele-web04/synara/pull/1130),
merged September 11, 2026. Implemented against Ryco's shared draft and queue services;
no upstream code copied.
