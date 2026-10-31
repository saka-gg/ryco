# Keybindings

Open **App preferences → Keybindings** to edit keyboard shortcuts. Bindings are saved in
the current desktop installation or browser profile and apply across connected nodes.
Connecting, switching or reconnecting nodes, and server configuration pushes, do not change them.
Viewers and operators can edit these local preferences even while a node is disconnected.
Headless nodes have no GUI keybindings settings section or mutation authority.

Desktop stores a separate `app-keybindings.json` document beside its client preferences,
independent of backend state directories and renderer origins. Browser storage uses
`ryco:app-keybindings:v1` in the current origin/profile. Desktop windows and browser tabs
reload the shared local document when another window saves. Concurrent saves follow
last successful save precedence. Separate browser origins/profiles and separate desktop
installations have separate bindings.

Shortcuts remain inactive until the local document loads successfully or defaults are
explicitly restored. Returning after a window has no shortcut subscribers reloads the document
to pick up changes made by other windows during that gap.

Only command overrides and deliberately disabled commands are persisted, allowing future
defaults to evolve. **Restore defaults** removes both. Failed writes retain the last
successfully saved bindings. Corrupt or unreadable documents are retained and surfaced:
**Retry loading** retries the read; **Replace local bindings with defaults** explicitly
replaces the local document. Ordinary edits cannot overwrite an unreadable document.

Every Ryco version in a browser profile or desktop installation shares this document, so it is
read one entry at a time. Entries this version cannot use, such as shortcuts for commands added
by a newer version, are ignored here and written back unchanged when you save. So are fields
this version doesn't know on a shortcut it does use, for as long as you leave that shortcut as it
is. Rebinding or unbinding a command here replaces its unusable entries; changing a shortcut here
writes it without the fields this version doesn't know; **Restore defaults** removes them all.

## Import existing node bindings

There is no automatic adoption of a node's bindings. Existing files remain available at
`~/.ryco/userdata/keybindings.json` (or `$RYCO_HOME/dev/keybindings.json` in dev mode).
Copy the desired node's file to your client and select it under **Import legacy bindings**.
Review the listed rules and click **Import reviewed bindings**. Cancel makes no changes.
The import keeps local command overrides and explicit disables; it fills untouched commands.
It neither modifies the node's file nor grants the node future control of local shortcuts.

Legacy `script.{id}.run` rules require an explicit project/node choice. Every imported script
must exist in the selected project; otherwise the whole import is rejected without changes.
Split multi-project legacy files or assign shortcuts from each project's Actions editor.
New script shortcuts include environment and project identity internally, so identical
script and project IDs on different nodes cannot collide. Only the active project's script
bindings participate in shortcut resolution; execution uses that project's node API.

Legacy RPC mutation methods remain in the wire protocol for compatibility but reject writes
with a message directing older clients to App preferences. Nodes still send their frozen
defaults and legacy file to older clients, limited to the commands nodes served when app defaults
moved into the app. A legacy rule for a newer command is reported as an invalid entry instead.

A legacy file is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts) for schemas.

## Defaults

**App preferences → Keybindings** lists every command with its current shortcut and marks the ones
you changed. The defaults come from two lists: the frozen node list,
[`NODE_DEFAULT_KEYBINDINGS`](packages/shared/src/keybindings.ts), and the app's own list,
[`APP_DEFAULT_KEYBINDINGS`](packages/client-runtime/src/state/settings/appKeybindingDefaults.ts).
The app list starts from the node list, may replace some of its rules, and adds the defaults of
newer commands. Nodes only ever send the node list.

## iPad keyboard

The iOS app has its own fixed shortcuts for a hardware keyboard. They are not edited in
**App preferences → Keybindings**. Hold **Command** to see them.

| Shortcut                  | What it does                                                                   |
| ------------------------- | ------------------------------------------------------------------------------ |
| `Cmd+1` … `Cmd+9`         | Open the first nine threads the Inbox shows, in its current order and filters. |
| `Cmd+K`                   | Open the command palette: actions, projects and threads. `Cmd+K` closes it.    |
| `Cmd+F`                   | Search the Inbox or Projects list.                                             |
| `Cmd+N`                   | Start a new task.                                                              |
| `Cmd+[`                   | Go back.                                                                       |
| `Cmd+Shift+F` / `T` / `R` | On a thread: open its files, terminal or review, when the thread has them.     |
| `Return`                  | Send the message. `Shift+Return` starts a new line; `Cmd+Return` also sends.   |

Thread jumps count only the thread rows you can see: a collapsed Snoozed or Settled
section is skipped. They work from the Inbox and from a thread, and close any open sheet
first; the thread you jump to replaces the open one, so **Back** still returns to the
Inbox. In the Projects list there are no thread rows to jump to.

In the palette, the arrow keys move the highlight, `Return` runs it, `Cmd+1` … `Cmd+9`
pick a numbered result and `Escape` closes it. Type to search projects and threads; start
with `>` to show only actions. Search and ranking match the web command palette.

The palette and thread jumps are iPad shortcuts; on an iPhone with a keyboard, `Cmd+K`
searches instead. While an input method is composing text, the palette's keys and `Return`
belong to it.

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid imports are rejected without changing local preferences. The same shared compiler validates shortcut and context expressions on every client.

### Available Commands

#### Terminal

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)

#### Workspace and diff

- `workspace.files`: open the thread workspace files view
- `workspace.review`: open the thread review/diff view
- `workspace.terminal`: open the thread terminal view
- `workspace.simulator`: open the thread iOS Simulator view
- `diff.toggle`: toggle the diff panel
- `diff.hunk.next` / `diff.hunk.previous`: jump to the next or previous hunk of the diff panel while
  focus is inside it. They default to `alt+arrowdown` and `alt+arrowup` outside the terminal. A
  text field in the panel keeps those keys for moving the caret. The defaults live in the app, not
  on the node, so older apps have no key for them.

#### Palette and sidebar

- `commandPalette.toggle`: open or close the global command palette
- `sidebar.showInbox` / `sidebar.showProjects`: switch the sidebar to Inbox or Projects

#### Chat and composer

- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newWithoutProject`: start a chat without a project, in its own Ryco-managed folder (see [docs/chats.md](docs/chats.md)). It defaults to `mod+alt+n` outside the terminal. The default lives in the app, not on the node, so older apps have no key for it. It does nothing when the node does not offer chats, and the key goes to the focused control instead.
- `composer.stash`: stash prompt text and images, or open the stash picker when the composer is empty

The three new-chat commands work on every page, such as Tasks, Settings or Pull requests, not only
in a chat.

#### Editor

- `editor.openFavorite`: open current project/worktree in the last-used editor

#### Model picker

- `modelPicker.toggle`: open or close the model picker
- `modelPicker.jump.1` through `modelPicker.jump.9`: pick a visible model by position while the model picker is open

#### Threads

- `thread.find`: search the messages of the current thread
- `thread.pinToggle`: pin or unpin the current thread
- `thread.previous` / `thread.next`: navigate between threads
- `thread.jump.1` through `thread.jump.9`: jump to a visible thread by position

#### Split view

- `pane.split`: pick a thread to open in split view
- `pane.close`: close the focused pane
- `pane.focusNext` / `pane.focusPrevious`: focus the next or previous pane

With a single pane, `pane.close`, `pane.focusNext` and `pane.focusPrevious` leave the key to the
focused control.

#### Pages

- `pullRequests.open`: open the pull requests page (no default key)
- `projects.open`: open the projects page (no default key)

#### File search

- `workspace.quickOpen`: find a file of the current thread's project by name and open it in the
  Files panel. It defaults to `mod+p` outside the terminal and also works while typing in the
  composer. That key used to open the Files panel: this app moves `workspace.files` to
  `mod+shift+e`, while older apps keep `mod+p` for it. Both defaults live in the app, not on the
  node.
- `workspace.findInFiles`: search the contents of the current thread's project and open a match at
  its line in the Files panel. It defaults to `mod+shift+f` outside the terminal, in the app only,
  and also works while typing in the composer.

#### Thread lifecycle

- `thread.settle`: settle the open thread, or move a settled one back to Active (default `mod+alt+shift+d`)
- `thread.snooze`: pick a time to snooze the open thread until in the command palette, or wake a snoozed one (default `mod+alt+shift+s`)
- `thread.archive`: archive the open thread, asking first when the "Archive confirmation" setting is on (default `mod+alt+shift+a`)
- `thread.markUnread`: mark the open thread unread; it stays unread until you leave it (default `mod+alt+shift+u`)
- `thread.undo`: undo the newest settle, snooze, archive or unpin from its Undo notice (default `mod+z`)

The first four work while you type, but not in the terminal, a menu or a dialog. When the thread
cannot take the action, for example while it is working or its machine is offline, a toast says
why. Without an open thread the key goes to the focused control. The command palette offers the
same four actions for the open thread, with the same reason when one cannot run.

`thread.undo` acts only while an Undo notice is shown. In the composer it does so until you press
another key or edit text after the notice appeared; then the key is the composer's own undo again.
Other text fields, code editors, dialogs and the terminal always keep their own undo, and without a
notice the key goes to the focused control.

Their defaults live in the app, not on the node, so older apps have no keys for them.

#### Attention

- `thread.attention.next`: open the next thread that needs you (`mod+alt+a` outside the
  terminal). Threads waiting for an approval, an answer or a plan decision come first, then results
  you have not seen yet, failures before finished turns. Running threads are skipped, and a
  sub-agent counts only while it waits for an approval or an answer. Repeated presses walk that
  order and wrap around, across every connected machine and whatever the inbox filters show. It
  also works while you type in the composer. When no other thread needs you, a short note says so.
- `thread.attention.previous`: walk the same order backwards (no default key).

This default lives in the app, not on the node, so older apps have no key for it.

#### History and navigation

- `navigation.back` / `navigation.forward`: go back or forward through the pages you opened in this
  window (`mod+[` / `mod+]` outside the terminal). Back stops at the first page you opened, so it
  never leaves Ryco. Forward goes where the browser's own Forward would: in a browser tab, that can
  be a site you left Ryco for in the same tab. They also work while you type in the composer; other
  text fields keep the keys. In the desktop app, a mouse's back and forward buttons and a trackpad
  swipe between pages do the same. Over the browser panel, a mouse button moves its page instead,
  and so does a swipe while the panel has focus.
- `thread.interrupt`: stop the running turn in the focused chat, like the stop button (`mod+.`
  outside the terminal).
- `thread.copyReference`: copy the thread's pull request link, or its thread ID when it has none
  (`mod+shift+c` outside the terminal). Browsers on Windows and Linux may keep Ctrl+Shift+C for
  their developer tools.

Stop and copy also work while you type. With nothing to stop or copy (no running turn, or a draft),
they leave the key alone.

These defaults live in the app, not on the node, so older apps have no keys for them.

#### Tabs and panes

- `view.close`: close the active workspace tab, else the workspace panel when it shows only its launcher, else the focused split pane. It defaults to `mod+w` and `mod+alt+w` outside the terminal drawer, so a terminal tab in the workspace panel closes like any other tab; in the focused drawer terminal `mod+w` stays `terminal.close`. When there is nothing to close, `mod+w` goes on to the window's Close command (File > Close on macOS, the window menu on Windows and Linux); other keys do nothing then. Holding the key closes one view. A tab holding text you have not sent or saved yet (a comment, a note, an edit) stays open until you finish or discard it.
- `view.reopenClosed`: reopen the most recently closed tab or pane, opening its thread when you have moved on. A pane goes back to its place in the split, or beside the focused pane when the split has changed since. It defaults to `mod+shift+t` and `mod+alt+shift+t` outside the terminal drawer. Each window remembers its last 20 closed tabs and panes until it reloads.

These defaults live in the app, not on the node, so older apps have no keys for them. A regular
browser tab keeps `mod+w` and `mod+shift+t` for itself and never passes them to Ryco, so there use
`mod+alt+w` and `mod+alt+shift+t`. The desktop app and an installed web app get all four.

#### Side chat

- `sideChat.toggle`: open the current thread's [side chat](docs/side-chat.md), or minimize it when
  it is open (`mod+alt+s` outside the terminal: ⌘⌥S on macOS, Ctrl+Alt+S elsewhere). A new side
  chat starts on the thread's model, as from the workspace launcher. Opening moves the typing into
  the side question; minimizing moves it back to the composer and never stops a pending answer. It
  also works while you type, in the composer and in the side question, but not in a dialog. Where
  the thread has no side chat (a draft, the frozen phone layout, or no access to side questions on
  its machine), the key goes to the focused control.

This default lives in the app, not on the node, so older apps have no key for it.

#### Chat tabs

- `threadTab.next` / `threadTab.previous`: show the next or previous open chat tab in the chat
  header, wrapping at either end like a browser. On macOS they default to `mod+ctrl+arrowright` /
  `mod+ctrl+arrowleft` (⌃⌘→ / ⌃⌘←), which also work from the terminal; elsewhere to
  `ctrl+pagedown` / `ctrl+pageup` outside the terminal. A regular browser tab on Windows and Linux
  keeps Ctrl+PageUp/PageDown for its own tabs, so there bind other keys or use the desktop app.
  They also work while you type in the composer. With the tabs turned off (Settings > Appearance >
  Open chat tabs) or no other tab open, the keys do nothing.

These defaults live in the app, not on the node, so older apps have no keys for them.

#### Scripts

- `projectScript.{environment}/{project}/{id}.run`: a locally assigned script shortcut. The app constructs these scoped IDs; legacy `script.{id}.run` rules are supported only through explicit import.

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

With `alt`, some layouts change the character a letter key types. On macOS, for example,
Option+N is a dead key and Option+P types `π`. In that case the binding matches the physical
letter key, so a `mod+alt+n` binding works as ⌘⌥N. Layouts that still report the plain letter while Alt is
held match by that letter.

On Windows and Linux, AltGr types characters on many layouts (Polish AltGr+A types `ą`, German
AltGr+8 types `[`), and Windows reports it as Ctrl+Alt. In a text field or the terminal those keys
keep typing: while Ctrl is held, the physical letter stands in only for the letters of a non-Latin
layout (Russian Ctrl+Alt+P reports `з` and matches `mod+alt+p`), and a symbol typed with AltGr
never matches a binding when the browser reports AltGr. Elsewhere they type nothing, so Ctrl+Alt
shortcuts match by the physical key on every layout (US-International Ctrl+Alt+P reports `ö` and
matches `mod+alt+p`).

### `when` Conditions

Currently available context keys:

- `terminalFocus` — the terminal drawer has keyboard focus
- `terminalOpen` — the terminal drawer is visible in the active thread
- `modelPickerOpen` — the model picker dialog is open
- `commandPaletteOpen` — the command palette is open
- `composerFocus` — the message composer (main chat input) is focused
- `isMac` — the app runs on macOS, for defaults that need another chord there

Enter in the focused composer is reserved. The **Send shortcut** setting (Settings > General >
Composer controls) decides when it sends: `enter` always, `mod+enter` for multiline prompts, or
always `mod+enter`. `shift+enter` adds a new line. While a turn runs, `mod+enter` does the opposite
of the follow-up setting when the Send shortcut is `enter`; with either `mod+enter` option,
`mod+enter` is the plain send and `mod+shift+enter` does the opposite. Do not bind `mod+enter` or
`mod+shift+enter` to commands that can fire while the composer is focused.

The focused composer also keeps these keys, which are not configurable (see
[docs/user/composer.md](docs/user/composer.md)):

- `ArrowUp` / `ArrowDown` in an empty composer recall the thread's earlier prompts.
- `mod+shift+v` pastes text as text, even when it is large enough to become an attachment. The
  desktop app's **Edit > Paste as Text** does the same, and so does `cmd+alt+shift+v` on macOS.

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.

## Adding a command

A new command takes four places. Each has one group or section per feature, so features built in
parallel never edit the same lines:

1. The command, in its group in [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts).
2. Its default key, if it has one, in its group in
   [`appKeybindingDefaults.ts`](packages/client-runtime/src/state/settings/appKeybindingDefaults.ts).
   A test fails when two defaults share a key and `when`.
3. Its title, in its group in [`apps/web/src/lib/keybindingCategories.ts`](apps/web/src/lib/keybindingCategories.ts).
   Typecheck fails when a command has no title.
4. Its entry and default key in **Available Commands** above. A feature section replaces its
   comment there.

Never add a command to `NODE_DEFAULT_KEYBINDINGS` or to the commands nodes serve in
`apps/server/src/keybindings.ts`. Nodes send those to older apps, which cannot read a command they
don't know. To move a node default's key to a new command, list the node rule in
`SUPERSEDED_NODE_DEFAULT_KEYBINDINGS`; nodes keep sending it unchanged.
