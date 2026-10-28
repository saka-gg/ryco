# Files and chat

## File links in replies

A file link in an agent's reply opens the file in the thread's **Files** panel,
scrolled to the linked line and marked. This works on hosted web and on remote
nodes: the panel reads the file through the thread's own node, so no local
editor is involved. An unsaved edit in the panel still asks before another file
opens; cancelling stays on the current file and drops the link. The mark stays
while the file is open and is gone once you open another one. A link to a folder
shows that folder in the Files tree. A linked file opens even when the tree does
not list it (inside `node_modules` or another ignored folder, gitignored, or past
the listing's cap in a large repository); only a read that finds no such file
takes the panel back to the tree. In split panes a link opens in the Files panel of its own
pane's thread.

**Cmd/Ctrl-click** opens the file in your editor instead. The link's context menu
(right-click) offers **Open in Ryco**, **Open in editor**, **Copy relative path**
and **Copy full path**. Links to files outside the thread's workspace, and links
outside a thread (side chat, agent activity), open in the editor as before. The
frozen web phone tier is unchanged.

The panel opens through a one-shot route key (`workspaceFile`, with
`workspaceFileLine`), consumed like the pull request tab's reveal: a repeat link
opens again, and history, reload and returning to the thread never replay it.

## Quick open

**Cmd/Ctrl+P** opens quick open for the current thread's project (its worktree
when it has one). Type part of a file's name or path and press Enter: the file
opens in the thread's **Files** panel. It also opens while you type in the
composer, but not in the terminal or in other fields. It uses the node's file
index and the cache of the composer's `@` picker, so the ranking is the same and
a warm index answers at once. It lists files only: the Files panel tells a folder
from a file by its own listing, which is often not loaded yet. On a node that
lists a workspace for an empty query, quick open shows its shallowest files before
you type.

Cmd/Ctrl+P used to open the Files panel. In this app the Files panel moves to
**Cmd/Ctrl+Shift+E**; older apps keep Cmd/Ctrl+P for it, because the node keeps
serving its own defaults (see [KEYBINDINGS.md](../KEYBINDINGS.md)). Quick open and
find in files are also in the Cmd/Ctrl+K palette as **Go to file** and **Find in
files**. Inside either search, Cmd/Ctrl+P and Cmd/Ctrl+Shift+F switch between them
(each keeps its query), the key of the one shown closes it, and Cmd/Ctrl+K goes back
to the palette's commands. The frozen web phone tier has neither.

## Find in files

**Cmd/Ctrl+Shift+F** searches the contents of the same workspace on the thread's
own node, so it works on hosted web and on remote nodes too. Results are grouped
by file and highlighted; Enter or a click opens the file in the Files panel at
that line, marked as for a file link. **Aa** matches case and **ab** matches whole
words (letters, digits and `_`, as git counts them). The search is literal text of
at least two characters on one line; there are no regular expressions.

What is searched:

- In a git checkout, `git grep` reads tracked and untracked files. Ignored files
  are skipped, and so are the folders the file index leaves out at the top level
  (`node_modules`, `dist`, `build`, `out`, `.next`, `.turbo`, `.cache`, `.convex`).
  Elsewhere, or when git fails, the node scans its file index, which can cover only
  part of a very large folder; the results then say so.
- Binary files, files over 512 KiB (the Files panel cannot open them either) and
  links are skipped.

Results arrive in pages of whole files, at most 100 lines per file, and more load
as you scroll, up to 2,000. Each page has a one-second budget on the node. A page
that runs out of time before it finds anything stops with **Search stopped
early.** and a **Keep searching** button, instead of searching on by itself. Typing
cancels the search in flight, and the search text never appears in the node's
process list or logs. The last search of each workspace, with its options, is kept
in memory for the session and comes back selected when find in files opens again.

A node from before this feature shows "Update Ryco on this node to search file
contents." Quick open still works there.

## Lines from the Review and Files panels

The Review diff and the Files viewer and editor share a gutter **+** on desktop:
click it next to a line, or drag it over a range, add an optional note, and
**Add to chat** (⌘↵ / Ctrl↵) hands the lines to the thread's composer. Escape or
**Cancel** drops the pick, and a new pick starts with an empty note. The action
only appears while the thread's composer can take it (it registers on the shared
composer context intake once and refuses while it is busy, so the gutter does not
flicker on every send). A diff range that crosses from removed into added lines
becomes a range of the new version.

The lines wait in the composer as chips above the prompt (`app.ts:12-18`); the
tooltip shows the file, the note and the start of the excerpt, and **×** removes
one. Adding the same lines again replaces the chip's excerpt and note instead of
adding a second chip. A message carries up to 20 references: past that, the note
row says the message is full and asks you to remove one first. While the composer
cannot take input (a question waits, or the connection is down), it says the chat
can't take the lines right now. Either way the note is kept. The chips belong
to the draft: they survive switching threads and reloading, go out with the next
send, and come back if that send fails. A queued message keeps them too, and
editing it puts them back; a steered message and a redirect past a waiting
approval carry them as well. ArrowUp recall only brings back what you typed, and it
does not step while chips are in the composer. A send of references alone is
fine; its title names the first file. On a proposed plan, chips are feedback on
it: with or without typed text the send refines the plan (the button reads
**Refine**) rather than implementing it.

## Dragging files into the composer

Files in the Files tree can be dragged onto the composer. A drop inserts an
`@path` mention of the file at the caret, the same mention the `@` picker
writes: the agent reads the file on its node, so it sees all of it as it is
when the turn runs, where an excerpt copied into the prompt would be bounded and
could go stale (line ranges are what the gutter **+** is for). The drag carries
the workspace file (`application/x-ryco-workspace-file`, plus the path as plain
text for drops elsewhere); while it hovers, the composer says what a drop will do.
A file of another machine or another workspace is refused with a short notice,
and the editor never pastes the path as text.

## What the agent receives

References travel in the ordinary prompt text, so every provider, the queue and
send retries see the same context. They form one block after the prompt and
before any terminal context. The client runtime writes them in one place
(`composeOutgoingPrompt`, in the send engine) and reads a sent message back in
one place (`deriveDisplayedUserMessageContext`, for display, search and copy
alike). The sent message shows the references as chips again, on web and in the
mobile app; copying the message copies the text as sent, block included:

```text
<file_context>
- src/app.ts lines 12-14 (new version):
  comment: Why does this run twice?
  12 | for (const item of items) {
  13 |   run(item);
  14 | }
</file_context>
```

Each excerpt is bounded to 40 lines and 4,000 characters; longer ranges end in
`… (truncated)`, and so do ranges the panel could not read fully (a collapsed
stretch of a diff). Notes are bounded to 2,000 characters. Every line inside the
block is indented and every excerpt line numbered, so file contents, paths and
notes cannot fake an entry or close the block. Characters some readers take for a
line break (line and paragraph separators, NEL and other C1 controls, vertical
tab, form feed) become `�` in excerpts and notes, and paths containing them
cannot be referenced. A terminal context's own placeholders are resolved in your
text only, so an excerpt keeps whatever it contains, and a `<terminal_context>`
line inside an excerpt never opens the terminal block. A sent prompt's blocks are
read back only when they parse exactly; anything else stays text.

Paths are relative to the thread's folder, where the agent works. Review diffs
name paths from the repository root, so when the project is a folder inside its
repository they are mapped into it, and lines of files outside the folder cannot
be added (the **+** does not appear). When the two cannot be related (a
symlinked path, or a turn diff in a repository without a remote), the folder is
taken as the root.
