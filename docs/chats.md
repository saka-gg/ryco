# Chats without a project

A chat is a thread that works in its own Ryco-managed folder instead of a project. Files the agent
writes there persist on the node, and you can later turn the chat into a regular project without
losing the conversation. Behind the scenes a chat is a project record of kind `chat`; it never
appears in the project tree or in project pickers.

## Starting a chat

These entry points start a chat on the node you are working with:

- **or start without a project** under the new-thread headline. The draft you are composing
  becomes a chat and keeps its prompt, attachments and model.
- **No project** at the top of the new draft's project switcher, and in the device and project
  picker of a hosted draft. Picking a project turns the draft back into a project draft.
- The **+** button of the sidebar's **Chats** section, which appears once there is a chat. When
  the node has no projects, the sidebar's new-thread button also starts a chat.
- **New chat without a project** and **No project** in the command palette.
- The `chat.newWithoutProject` shortcut. It has no default key; bind one in your keybindings, for
  example `mod+alt+n` (⌘⌥N on macOS, Ctrl+Alt+N elsewhere). See [KEYBINDINGS.md](../KEYBINDINGS.md).

Ryco's apps keep one thread per chat. While a chat is open, **New thread** (`chat.new`,
`chat.newLocal`) starts another chat instead of a second thread in the same folder, and no picker
offers a chat as the place for a new thread. Starting a chat returns to the node's unsent chat
draft when there is one. The node itself does not enforce this rule; see
[Limitations](#limitations).

Nothing is created on disk until the first message is sent. Until then the draft is called
**New chat**, in the **Chats** section and in its header, where its project reads **No project**.
The first send creates the folder and the chat in one server request. If the send fails, Ryco
removes the still-empty folder and keeps the chat, so sending the same draft again reuses the chat
and recreates its folder.

A chat whose first send never succeeded has no conversation; only its unsent draft shows in the
sidebar. When the node starts, it removes every chat that has no conversation at all (none in the
sidebar, the archive or Trash) and was created more than an hour earlier. It also removes the chat's folder, but only when
the folder is empty and strictly inside the current chats folder. Files are never deleted. The
cleanup runs in the background after startup. A chat that it cannot remove, or that gained a
conversation in the meantime, stays, and a failed cleanup is tried again at the next start.

A draft whose chat was removed this way cannot reuse that chat. The node refuses the send before
creating anything, and Ryco then gives the draft a new chat and sends the same message once more,
with the same prompt and attachments. The draft keeps the new chat, so a later send uses it too.
If that second send also fails, Ryco shows its error and puts the message back in the draft.

A chat runs locally in a plain folder. Ryco's apps never treat that folder as a Git repository:
they do not poll the folder's Git status, pull requests or CI runs, and offer no branch, worktree
or diff controls for it. The overview rail shows no **Branch**, **Changes**, **Checks**, **Pull
request** or **Push** for a chat, and no **Notes**: notes belong to a project checkout, and a chat
folder is none. They become available once the chat is a project. The node refuses a worktree for
the first send that creates a chat. Where a project shows its Git state, a chat's header offers
**Turn into project…** instead, and the overview rail has a **Turn into project** icon. The header
also has a button that shows the folder when it is on this machine.

## Where chats live

The node creates each chat's folder under its chats folder. By default this is the `chats` folder
of the Ryco home: `~/.ryco/chats`, or `$RYCO_HOME/chats` when `RYCO_HOME` or `--base-dir` sets
another home. Under `--restrict-to-cwd` the default is `<workspace>/.ryco/chats`. Ryco creates the
chats folder with the first chat.

To use another location, open **Settings → General → Project defaults → Chats folder**, next to
**Worktree root**. Use an absolute path on the node, or `~/` for the node user's home directory.
The path is on the server's filesystem, also when you edit a remote node from another computer.
Before saving, the server resolves symlinks and checks that the directory, or its nearest existing
parent, is writable. Under `--restrict-to-cwd` the folder must be inside the authorized workspace.
**Reset to default** (or an empty field) restores the default. The row shows the folder in effect.

A new Chats folder applies only to new chats. Existing chats stay where they are. The setting is
stored on the node as `chatsRoot`; an empty string selects the default. It has no per-project
overrides, and the Agent Control settings allowlist does not include it.

### When chats are unavailable

The node checks its chats folder and tells clients whether chats are available. When they are not,
every chat entry point is hidden, and the **Chats folder** row in Settings explains why:

- **Inside a Git repository.** Every chat would otherwise show the parent repository's branch and
  diff. The node asks Git (`git rev-parse --is-inside-work-tree`) from the folder, or from its
  nearest existing parent, so ignored folders count too. When the authorized workspace of
  `--restrict-to-cwd` is itself a repository, the default chats folder is inside it. Chats are then
  unavailable.
- **Not usable.** The path cannot be resolved or created, or the check did not finish (Git gets 10
  seconds). The node retries a failed check every 30 seconds.
- **Restricted.** The workspace access policy does not allow the folder.

When Git is not installed, no repository can appear in a chat, so chats stay available. A node
running an older Ryco reports no chat support; clients then show no chat entry points and keep the
**Chats folder** row disabled. Saving a new Chats folder triggers a new check right away, and
connected clients update without a reload. While chats are unavailable, existing chats keep working
and can still be turned into projects. Only new chats are blocked.

## Folders and names

Each chat has exactly one folder, named `<date>-<slug>-<suffix>`, for example
`2026-10-08-summarize-the-quarterly-report-1a2b3c4d`:

- The date is the node's local date when the chat was created.
- The slug comes from the first message, or from attachment names when there is no text. It
  contains lowercase ASCII letters and digits joined by hyphens (accents are removed) and is at
  most 48 characters long. When nothing usable remains, it is `chat`.
- The suffix is 8 hexadecimal characters derived from the chat's ID. If a folder with that name
  already exists, Ryco picks another suffix. Two chats never share a folder.

The folder is flat: Ryco adds no subfolders. Its name never changes. **Rename chat** changes only
the title that Ryco shows.

Chats are listed in the sidebar's **Chats** section. Unsent chat drafts come first, followed by
chats in your thread order (pinned chats first). The inbox labels a chat's project **No project**,
and searching the inbox for "No project" finds your chats. Trash lists them the same way.
A chat row's menu has these items:

- **Show folder in Finder** (Explorer or Files on other platforms) and **Open folder in editor**,
  when the chat is on this machine.
- **Copy folder path**.
- **Turn into project…**.

## Deleting a chat

Archiving a chat hides it from the Chats section. **Move to Trash** keeps the conversation
recoverable, and the chat's folder and files stay on disk.

To delete a chat permanently, use **Settings → Archive → Trash → Delete permanently**. When no
conversation of the chat is left, including in Trash, Ryco also removes the chat record. The folder
stays on disk unless you select **Also delete the chat's folder** in the confirmation. That option
is off by default. If you select it, Ryco deletes the folder and everything in it. It does not move
the files to the OS trash. The node deletes the folder only when all of these hold:

- The project is still a chat (it was not turned into a project).
- No conversation of the chat remains, whether in the sidebar, the archive or Trash.
- The folder's real path is strictly inside the current chats folder, and is never the chats
  folder itself.
- No agent session runs for the chat or inside its folder. Ryco briefly waits for the sessions of
  the deleted conversation to stop.

If a check fails, the conversation stays deleted, and a notice says where the files remain. A
folder outside the current chats folder is never deleted. If you changed the Chats folder, remove
older chats' folders by hand.

## Turning a chat into a project

Open **Turn into project…** from any of these places:

- the chat's header,
- the overview rail on desktop: its **Turn into project** icon previews what happens on hover and
  opens a card with the **Turn into project…** button,
- the chat's row menu in the sidebar,
- the command palette (**Turn chat into project…**).

You need operator access to the chat's node. The project keeps the chat's ID, and its threads and
history stay attached.

The dialog shows a live preview:

- **Name.** The chat's title is filled in, and the dialog opens with the cursor in this field.
- **Location.** The default is `<parent>/<folder name>`. The parent is the authorized workspace
  under `--restrict-to-cwd`. Otherwise it is **Add project starts in** (`addProjectBaseDirectory`,
  under **Settings → General → Projects & threads**), then `~/Code` when it exists, then the home
  folder. The folder name follows the project name until you edit it. If the name is taken, the
  dialog suggests `-2`, `-3`, and so on. You can pick a folder with the desktop folder picker or
  type a path, which browses as you type.
- **Location check.** The location must be an absolute path that does not exist yet, inside a
  writable parent folder. The workspace access policy must allow it, also after symlinks in the
  parent are resolved. It must be outside both the chat's folder and the chats folder. It must
  not be at or inside a workspace checkout that Ryco removed or moved away, or is removing or
  moving, because Ryco keeps new work out of those folders. A location that another chat is being
  moved into counts as taken. Ryco never moves a chat into an existing folder.
- **What will happen.** The plan shows how many files and bytes will move (counting stops at
  20,000 entries), from where to where, and whether the new location is on another disk, in which
  case the files are copied and checked first. Only a location the node accepted is shown as
  where the files go: one still being checked is dimmed, and one the node refused is replaced by a
  prompt to choose another location. A long path shortens its parent folders first; a chat
  folder's name that is still too long is cut in the middle, so its suffix stays visible. Hover a
  path to see all of it. The plan then says how the conversation continues: **Codex** resumes it
  in the new folder, and other providers continue in a fresh session with a summary of it (see
  [Provider continuity after the move](#provider-continuity-after-the-move)). When the chat's
  conversations would not all continue the same way, or one uses a provider the node does not
  list, it only says that your next message continues the conversation. Last, it shows the Git
  setup you chose.

Enter in a field confirms when nothing blocks the move. Escape cancels.

When you confirm, the node runs these steps:

1. It checks the new location once more and records the move in a journal in its database. Until
   the move settles, no turn, agent session or terminal can start in the chat's folder or at the
   new location, and Ryco does not write files there. Such attempts get "This chat is being moved
   into a project. Try again in a moment."
2. It checks again that the chat is idle. It stops the chat's agent sessions, and any other agent
   session that runs in its folder, and closes the chat's idle terminals, whose history is kept. If
   a session does not stop or a terminal does not close, the move is refused and the chat is left
   unchanged.
3. It renames the folder to the new location. If the new location is on another disk, it creates
   the new folder and copies everything into it. Symbolic links are copied as links, not followed.
   It then checks that the copy matches the original (same entries, types, sizes and link targets)
   and that nothing changed while it copied. A failed or mismatched copy is removed, and the chat
   is left unchanged.
4. It updates the same record into a regular project with the new name and folder. If this update
   fails, the move is undone.
5. After a copy, it removes the original folder. If something changed the original after the copy
   was checked, it keeps the original.
6. It runs the Git steps you selected (below).

Afterwards the chat leaves the Chats section and appears in the project tree with its Git
controls. A notice offers to show the new folder when it is on this machine.

Keep the dialog open until the promotion finishes. If the client disconnects while the node is
still stopping the chat's sessions (step 2), the move is cancelled and the chat is left unchanged.
From step 3 on, the node finishes the move even without the client. The Git steps (step 6) can
stop when the client disconnects; if the project has no Git repository afterwards, use
**Initialize Git** in the project.

### Git options

**Initialize Git** is on by default. On a node without Git, it is off and cannot be turned on. It
runs `git init`, registers the main workspace, and attaches the project's threads, as
**Initialize Git** does for any project. Two more options are on by default:

- **Add a .gitignore** writes `.DS_Store`, `node_modules/`, `.env`, `.env.*` and the project's
  managed worktrees folder (`/.ryco/worktrees/`). An existing `.gitignore` is never changed.
- **Make an initial commit** stages everything and commits it as `Initial commit`. This happens
  only if the folder has no commit history yet and something is staged.

Git problems never undo the promotion. If `git init` fails, use **Initialize Git** in the project
later. If the first commit fails, the dialog says what to fix: a missing name or email, commit
signing, a hook, or a commit that took longer than 60 seconds.

The preview checks whether Git knows your name and email at the new location: `user.name` and
`user.email`, or `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` and `EMAIL`. If it does not, and an initial
commit is selected, the dialog warns that the commit cannot be made and offers these commands to
copy:

```sh
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

### When it is refused

While any conversation in the chat is busy, the dialog blocks the move. A conversation is busy
when it has a running or starting turn, a waiting approval or question, a message that is still
starting, background work, a model switch in progress, a pending checkpoint revert, or a terminal
running a command. Another conversation's terminal that is open in the chat's folder also blocks
the move. The dialog says what it sees:

- **The agent is still working.** The dialog offers **Stop the agent**, which interrupts the
  agent's turn.
- **A terminal is still running a command.** Stopping the agent does not end it. Let the command
  finish or stop it in its terminal.
- **Anything else** shows as "This chat is still busy".

The dialog checks again by itself when an agent stops or a terminal command in the chat ends. When
the work is not the agent's, it also offers **Check again**.

The node also refuses a promotion in these cases:

- the chat changed since the dialog opened,
- another promotion of the same chat is running,
- the chat has no conversations left,
- the chat's folder contains the chats folder,
- an earlier move of the chat did not finish. Restart Ryco to recover it, then try again.

### Crash recovery

The node records every move in its journal before any file moves. If Ryco stops mid-move, the next
start settles the move from what is on disk, before anything reads project folders:

- **The new folder is complete** (the rename happened, or the copy was verified). Ryco finishes
  the promotion with the name you chose and removes a leftover original of a copy, unless the
  original changed after it was copied: then both folders are kept. If the project record was not
  updated yet, no Git steps run: use **Initialize Git** in the project.
- **Only the original exists.** Nothing moved, and the chat is unchanged.
- **Only an unfinished copy exists.** The copy was never checked, and the original may only be
  unreachable, for example on a drive that is not mounted yet. Ryco keeps the copy, leaves the chat
  pointing at the original, and records both paths.
- **Both exist after an interrupted copy.** Ryco removes the partial copy it created, and the chat
  is unchanged. If the journal does not show that Ryco created the new folder, Ryco keeps both
  folders. A partial copy Ryco cannot remove, such as one with read-only folders it cannot make
  writable, is kept and named in the journal; the chat stays usable.
- **The chat was deleted or changed in the meantime.** The files stay at the new location, and the
  journal records why.
- **Neither folder exists.** Ryco changes nothing, and the journal records it. Recover the files
  by hand.

Recovery never deletes a folder that Ryco did not create. Each start spends at most 30 seconds on
recovery. A move that cannot be settled is retried on the next start.

## Provider continuity after the move

The next message continues the conversation in the new folder.

- **Codex** resumes its native conversation there.
- **Claude** stores conversations per folder. **GitHub Copilot**, **OpenCode** and **Cursor** are
  not yet known to resume from another folder. For these providers, the next message starts a
  fresh session on the same provider instance. Ryco sends a context document of the conversation
  ahead of your message, and the timeline shows a divider for the new session, on the web and
  in the mobile app.

If a resume after the move finds no conversation, also for Codex, Ryco uses the same fresh-session
handoff instead of failing the turn. The same rules apply whenever a thread's working directory
moves for another reason. See
[Context handoffs → Working-directory moves](context-handoffs.md#working-directory-moves).

For Claude, the first message after the move shows no resume review for a large conversation:
nothing is resumed, because the conversation continues by handoff. Later messages are reviewed as
usual.

A promotion stops the chat's agent sessions (step 2 of the move). If the move then does not
happen, because it is refused, cancelled or undone, the chat stays in its folder with its sessions
stopped, and your next message starts a new session that resumes the conversation there. For a
large Claude conversation the resume review may come first: **Continue with full context** works,
but **Compact then send** is not offered while the session is stopped, because compacting needs a
running session. See
[Observed Claude cache usage and resume review](providers/claude-cache.md).

## Limitations

- The frozen web phone layout does not start chats or offer **Turn into project…**, and its home
  list does not show chats. The native mobile app does not start or turn chats into projects yet.
- **Show folder** and **Open folder in editor** work only for chats on this machine. For chats on
  other nodes, use **Copy folder path**.
- You cannot move a chat's files into an existing project.
- Only Ryco's apps keep one thread per chat and keep worktrees out of a chat. The node accepts a new
  thread in a chat's project from Agent Control (`ryco_create_threads`) or from an older client.
  Such a thread works in the same folder and gets its own row in the **Chats** section. If the
  chat's folder became a Git repository (for example, you ran `git init` in it), such a client can
  also create a worktree for it.
- Agent Control lists chats (`kind: "chat"`) but cannot create them.
- Only the first send and **Turn into project…** can create a chat, move its folder or change its
  kind. Clients cannot do this through ordinary project updates.
- Usage statistics and daily recaps list a chat under its title, like a project.
