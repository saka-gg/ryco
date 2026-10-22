# Composer

## Large pastes

On web and desktop, a text paste of 32 KiB or more becomes an attachment instead of prompt text.
It shows as a **pasted-text.txt** card marked **Pasted text** with its size; further folded pastes
in the same message are named `pasted-text-2.txt`, `pasted-text-3.txt`, and so on. A smaller paste
also becomes an attachment when it would push the message past its 120,000-character limit.

The agent receives the attachment as a file it reads when it needs to, so a long log or document
stays out of the message itself and the transcript shows a short message. Shorter pastes stay
inline, where the agent sees them directly. The size counts both characters and UTF-8 bytes, so
text in scripts that take more bytes per character folds sooner.

To keep a large paste as text, paste with `Cmd+Shift+V` on macOS or `Ctrl+Shift+V` on Windows and
Linux. Pastes stay text while you answer an agent's question, and when the message already has the
maximum of eight attachments. Remove the card to discard the pasted text; preview it from the card
like any other attachment.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt empties the composer again. Recall walks the prompts loaded in the thread, including a send
that is still on its way.

Only the text you typed comes back. Attachments, terminal context and quoted assistant text from
the original message are not restored. File mentions, skills and thread mentions are part of the
text, so they come back as chips. Prompts that Ryco composed for you, such as **Implement plan**,
are skipped.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the composer shows an unedited recalled prompt, with the caret on the first visual line for
`ArrowUp` or the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled
prompt turns it into a normal draft. A composer that holds an attachment or context chip does not
count as empty, and while an approval or a question waits, the arrows stay with it. Nothing is
stored for recall: it reads the thread's own messages.
