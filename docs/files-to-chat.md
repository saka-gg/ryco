# Files and chat

## File links in replies

A file link in an agent's reply opens the file in the thread's **Files** panel,
scrolled to the linked line and marked. This works on hosted web and on remote
nodes: the panel reads the file through the thread's own node, so no local
editor is involved. An unsaved edit in the panel still asks before another file
opens; cancelling stays on the current file and drops the link. The mark stays
while the file is open and is gone once you open another one. A link to a folder
shows that folder in the Files tree. In split panes a link opens in the Files
panel of its own pane's thread.

**Cmd/Ctrl-click** opens the file in your editor instead. The link's context menu
(right-click) offers **Open in Ryco**, **Open in editor**, **Copy relative path**
and **Copy full path**. Links to files outside the thread's workspace, and links
outside a thread (side chat, agent activity), open in the editor as before. The
frozen web phone tier is unchanged.

The panel opens through a one-shot route key (`workspaceFile`, with
`workspaceFileLine`), consumed like the pull request tab's reveal: a repeat link
opens again, and history, reload and returning to the thread never replay it.

## Lines from the Review and Files panels

The Review diff and the Files viewer and editor share a gutter **+** on desktop:
click it next to a line, or drag it over a range, add an optional note, and
**Add to chat** (⌘↵ / Ctrl↵) hands the lines to the thread's composer. Escape or
**Cancel** drops the pick, and a new pick starts with an empty note. The action
only appears while the thread's composer can take it (it registers on the shared
composer context intake once and refuses while it is busy, so the gutter does not
flicker on every send). A diff range that crosses from removed into added lines
becomes a range of the new version.

Files in the Files tree can be dragged; the drag carries the workspace file
(`application/x-ryco-workspace-file`, plus the path as plain text) for the composer
to take as a mention of that file.

## What the agent receives

References travel in the ordinary prompt text, so every provider, the queue and
send retries see the same context. They form one block after the prompt and
before any terminal context. The client runtime writes them in one place
(`composeOutgoingPrompt`) and reads a sent message back in one place
(`deriveDisplayedUserMessageContext`, for display, search and copy alike):

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
