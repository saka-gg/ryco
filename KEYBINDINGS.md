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
by a newer version, are ignored here and written back unchanged when you save. Rebinding or
unbinding a command here replaces its unusable entries; **Restore defaults** removes them all.

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

#### Palette and sidebar

- `commandPalette.toggle`: open or close the global command palette
- `sidebar.showInbox` / `sidebar.showProjects`: switch the sidebar to Inbox or Projects

#### Chat and composer

- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newWithoutProject`: start a chat without a project, in its own Ryco-managed folder (see [docs/chats.md](docs/chats.md)). It defaults to `mod+alt+n` outside the terminal. The default lives in the app, not on the node, so older apps have no key for it. It does nothing when the node does not offer chats, and the key goes to the focused control instead.
- `composer.stash`: stash prompt text and images, or open the stash picker when the composer is empty

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

- `view.close`: close the active workspace tab, else the workspace panel when it shows only its launcher, else the focused split pane. It defaults to `mod+w` outside the terminal drawer, so a terminal tab in the workspace panel closes like any other tab; in the focused drawer terminal `mod+w` stays `terminal.close`. When there is nothing to close, the key goes on to the window's Close command (File > Close on macOS, the window menu on Windows and Linux). Holding the key closes one view. A tab holding text you have not sent or saved yet (a comment, a note, an edit) stays open until you finish or discard it.
- `view.reopenClosed`: reopen the most recently closed tab or pane, opening its thread when you have moved on. A pane goes back to its place in the split, or beside the focused pane when the split has changed since. It defaults to `mod+shift+t` outside the terminal drawer. Each window remembers its last 20 closed tabs and panes until it reloads.

Both defaults live in the app, not on the node, so older apps have no keys for them. A regular
browser tab keeps `mod+w` and `mod+shift+t` for the browser, so the defaults work in the desktop app
and in an installed web app; in a browser tab, bind other keys.

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
