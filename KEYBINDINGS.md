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
with a message directing older clients to App preferences.

A legacy file is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See [`packages/contracts/src/keybindings.ts`](packages/contracts/src/keybindings.ts) for schemas.

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+d", "command": "terminal.split", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+p", "command": "workspace.files", "when": "!terminalFocus" },
  { "key": "ctrl+shift+g", "command": "workspace.review", "when": "!terminalFocus" },
  { "key": "ctrl+`", "command": "workspace.terminal", "when": "!terminalFocus" },
  { "key": "mod+d", "command": "diff.toggle", "when": "!terminalFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+s", "command": "composer.stash", "when": "!terminalFocus" },
  { "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" },
  { "key": "mod+shift+[", "command": "thread.previous" },
  { "key": "mod+shift+]", "command": "thread.next" },
  { "key": "mod+1", "command": "thread.jump.1" },
  { "key": "mod+2", "command": "thread.jump.2" },
  { "key": "mod+3", "command": "thread.jump.3" },
  { "key": "mod+4", "command": "thread.jump.4" },
  { "key": "mod+5", "command": "thread.jump.5" },
  { "key": "mod+6", "command": "thread.jump.6" },
  { "key": "mod+7", "command": "thread.jump.7" },
  { "key": "mod+8", "command": "thread.jump.8" },
  { "key": "mod+9", "command": "thread.jump.9" },
  { "key": "mod+1", "command": "modelPicker.jump.1", "when": "modelPickerOpen" },
  { "key": "mod+2", "command": "modelPicker.jump.2", "when": "modelPickerOpen" },
  { "key": "mod+3", "command": "modelPicker.jump.3", "when": "modelPickerOpen" },
  { "key": "mod+4", "command": "modelPicker.jump.4", "when": "modelPickerOpen" },
  { "key": "mod+5", "command": "modelPicker.jump.5", "when": "modelPickerOpen" },
  { "key": "mod+6", "command": "modelPicker.jump.6", "when": "modelPickerOpen" },
  { "key": "mod+7", "command": "modelPicker.jump.7", "when": "modelPickerOpen" },
  { "key": "mod+8", "command": "modelPicker.jump.8", "when": "modelPickerOpen" },
  { "key": "mod+9", "command": "modelPicker.jump.9", "when": "modelPickerOpen" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `packages/shared/src/keybindings.ts`](packages/shared/src/keybindings.ts)

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid imports are rejected without changing local preferences. The same shared compiler validates shortcut and context expressions on every client.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `workspace.files`: open the thread workspace files view
- `workspace.review`: open the thread review/diff view
- `workspace.terminal`: open the thread terminal view
- `diff.toggle`: toggle the diff panel
- `commandPalette.toggle`: open or close the global command palette
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `chat.newWithoutProject`: start a chat without a project, in its own Ryco-managed folder (see [docs/chats.md](docs/chats.md)). It has no default key; bind one, for example `{ "key": "mod+alt+n", "command": "chat.newWithoutProject", "when": "!terminalFocus" }`. It does nothing when the node does not offer chats, and the key goes to the focused control instead.
- `composer.stash`: stash prompt text and images, or open the stash picker when the composer is empty
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `modelPicker.toggle`: open or close the model picker
- `modelPicker.jump.1` through `modelPicker.jump.9`: pick a visible model by position while the model picker is open
- `thread.previous` / `thread.next`: navigate between threads
- `thread.jump.1` through `thread.jump.9`: jump to a visible thread by position
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

### `when` Conditions

Currently available context keys:

- `terminalFocus` — the terminal drawer has keyboard focus
- `terminalOpen` — the terminal drawer is visible in the active thread
- `modelPickerOpen` — the model picker dialog is open
- `commandPaletteOpen` — the command palette is open
- `composerFocus` — the message composer (main chat input) is focused

Mod+Enter in the focused composer is reserved: while a turn runs it does the opposite of the
follow-up setting. Do not bind `mod+enter` to commands that can fire while the composer is
focused.

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
