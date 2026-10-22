# Composer

## Send shortcut

In **Settings > General > Send shortcut**, choose when Enter sends a message on web and desktop.
`Cmd` below is `Ctrl` on Windows and Linux.

- **Enter**: Enter sends. This is the default.
- **⌘↵ for multiline prompts**: Enter sends a one-line prompt. Once the prompt has more than one
  line, Enter adds a new line and `Cmd+Enter` sends.
- **Always ⌘↵**: Enter always adds a new line and `Cmd+Enter` sends.

`Shift+Enter` always adds a new line. The setting belongs to this browser or app, so each device
keeps its own. It does not apply to the phone layout of the web app or to the Ryco iPhone app.

While the agent works, **Messages sent while a turn runs** chooses whether a message waits in the
queue or steers the running turn. `Cmd+Enter` does the opposite for one message. Where sending
needs `Cmd+Enter` (always, or for a multiline prompt), use `Cmd+Shift+Enter` for the opposite
instead. While a turn runs, the empty composer's hint names the shortcut for a one-line prompt.

## Chat width

In **Settings > Appearance > Chat width**, choose how wide messages and the composer grow on large
screens: **Comfortable** (the default), **Wide**, or **Full**, which fills the chat pane. The
setting belongs to this browser or app. Phone layouts keep the comfortable width.

## Large pastes

On web and desktop, a text paste of 32 KiB or more becomes an attachment instead of prompt text.
It shows as a **pasted-text.txt** card marked **Pasted text** with its size, and a short notice
says where the paste went. Further folded pastes in the same message are named
`pasted-text-2.txt`, `pasted-text-3.txt`, and so on. A smaller paste also becomes an attachment
when it would push the message past its 120,000-character limit. Pasted over selected text, the
paste replaces the selection, as a paste into the prompt would.

The agent receives the attachment as a file it reads when it needs to, so a long log or document
stays out of the message itself and the transcript shows a short message. Shorter pastes stay
inline, where the agent sees them directly. The size counts both characters and UTF-8 bytes, so
text in scripts that take more bytes per character folds sooner.

The pasted text stays with your draft, like an attached image: wherever drafts are saved, it
survives a reload or an app restart, and it goes with the message when you send it, so it never
has to be attached again.

To keep a large paste as text, paste with `Cmd+Shift+V` on macOS or `Ctrl+Shift+V` on Windows and
Linux. In the desktop app, **Edit > Paste as Text** does the same, and on macOS so does
`Cmd+Option+Shift+V`. Pastes stay text while you answer an agent's question, and when the message
has no room for another attachment (at most eight, 50 MB in total) but the prompt can still hold
the text. A paste that fits neither is refused with a message saying why. Remove the card to
discard the pasted text; preview it from the card like any other attachment.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt empties the composer again. Recall walks the prompts loaded in the thread, including a send
that is still on its way.

Only the text you typed comes back. Attachments, terminal context and quoted assistant text from
the original message are not restored. File mentions, skills and thread mentions are part of the
text, so they come back as chips. An `Ultrathink:` line at the start comes back too, so a Claude
prompt sent with Ultrathink is sent with it again. Prompts that Ryco composed for you, such as
**Implement plan**, are skipped.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the composer shows an unedited recalled prompt, with the caret on the first visual line for
`ArrowUp` or the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled
prompt turns it into a normal draft. A composer that holds an attachment or context chip does not
count as empty, and while an approval or a question waits, the arrows stay with it. Nothing is
stored for recall: it reads the thread's own messages.
