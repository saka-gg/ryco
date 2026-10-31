# Settings ownership

Web and desktop settings are a page at `/settings` that replaces the main content, like
Statistics. Its navigation lists both destinations at once, each under its own heading, so
the destination is stated once instead of on every row:

- **This browser / This app** stores appearance, composer preferences, confirmations,
  notifications, keybindings, and other interaction preferences in the current client. Desktop
  permissions, updates, and saved connections also belong here. Changing a theme
  in the Hub never changes a desktop or phone theme.
- **Node: name** configures the selected server: providers, MCP, source control
  integrations, model selections, project defaults, and diagnostics.
  Only sections permitted by the current node role are offered. Node security is
  its own Security section. The device name and icon live in its General section.

A node section says which device it changes above its title: "Changes apply
to [device]". Its menu is the nav header's own device menu (the same devices,
the same rule for which ones a hosted browser may open, and the same switch),
with a search field above six devices; a device that is not reachable shows
Offline or Connecting. This app's sections, and browser or device sections,
keep their one-line label instead.

Hub account and device enrollment remain on the Hub account pages. Browser
appearance on those pages is still local to that browser.

Keybindings use a separate local document and are editable independently of node readiness or role. Legacy node files require explicit, reviewed import; server pushes never update local bindings. See [Keybindings](../KEYBINDINGS.md).

Mixed panels are filtered by persistence ownership. Search results and reset
actions use the same destination; a node reset cannot reset the client's theme.
The settings target carries the selected node's configuration and authorization.
Its writes never fall back to another node when the connection is unavailable.

Desktop can select another known node directly. Its own Hub alias resolves to
the existing local connection. Other native nodes acquire an interactive scope
through the shared workspace connection owner. The hosted browser uses its
current authorized node; switching nodes remains owned by Hub navigation and its
session/directory/relay readiness checks.

`@ryco/shared/settingsOwnership` classifies unified setting patches for web,
desktop, and native mobile using the shared settings schema. Mobile retains its
own native screens and the same persistence ownership. The legacy web phone
presentation remains frozen.

## Applying a node setting to every node

With two or more nodes known, some node defaults offer **Apply to all nodes**:
auto-settle, New threads, worktree branch prefix and setup, branch names by
change type, the Git writing style, commit and pull request instructions, pull
request templates, and response streaming. It is a bulk edit, not a synced
global: the value shown is written once to every connected node this client may
change, each through its own connection, and offline nodes keep their value. The
result names every node left out and why. A row whose value differs on another
connected node shows **Mixed**, with each node's value in its tooltip; nodes
that are not connected never count.

Each node's write carries that node's own compare-and-set values, read from its
own last known config, never the values of the node on screen. Hosted mode asks
each node's own session whether it may change settings. Project overrides, the
initial model (provider instances differ per node), providers, MCP, security,
diagnostics, storage cleanup, paths and execution authority (Agent Control,
process priority, continue after restart) are never written across nodes.
`@ryco/client-runtime/state/settings/nodeSettingsFanOut` holds the shared
mechanism for web and mobile.

## A chat's model, effort and speed

In a started chat, the model, effort and speed belong to the chat on its node, not to the
client. A pick is stored on the thread when it is made, so every client of that node (web,
desktop, a hosted browser, the native app) shows it at once; the last stored pick wins, and a
client's own pick that is still being written wins over a change that arrives meanwhile. The
session applies a stored pick at its next turn and never restarts or interrupts a running one.
A pick of another provider is a handoff and stays in the composer until it is sent. Nodes
without the `liveThreadModelSelection` capability keep a pick in the composer until it is sent.
Turns the node starts by itself (goal continuations, usage-limit resumes, delegated results,
watch updates, an agent's or an automation's queued follow-up) name no model: they take the
stored pick only where the session can, and keep the session's model when it cannot switch
models or when a restart would end its background work. A person's queued follow-up runs with
the model it was queued with, and that model becomes the chat's only while nobody stored another
pick since it was queued (an older client stores a pick only by sending or queueing it).
New-chat defaults (the last model per provider) stay in each client for now.

## Project inheritance

Node General settings expose initial model/effort, thread location, generated
branch prefix, setup behavior, worktree root and worktree submodules with
independent project overrides. One picker in the Project defaults heading chooses
between the node defaults and a project's overrides for all of them. Each field
shows its effective source and can reset to the node default. The server owns
resolution and atomic patching; native New Task consumes the same contract and
shared runtime. See [project defaults and inheritance](project-preferences.md)
for precedence, compatibility and the feature-specific policy boundary.

## Device icons

Open the named device's settings on web or desktop and choose **Device icon**.
On mobile, open **Nodes → Device icon** beneath the device. Choose Laptop,
Desktop, Mini PC, Workstation, Server, Cloud, Linux / WSL, or Windows, or reset to
Automatic. Automatic uses existing device-name and OS metadata; it does not run
hardware commands or request system permissions.

The override is the node-owned `environmentIcon` server setting. Existing
configuration and settings events synchronize it to connected clients, including
other clients' selectors, device lists, and task/project context. Rendering icons
does not open connections. Before receiving a node's configuration, a client
uses its available name and platform metadata. Older nodes remain usable with
an automatic icon; updating the node enables selection. Unknown future icon
values fall back to Automatic when reading, while write requests remain strict.

Changing an icon requires a current, authorized settings connection to that
exact device. Names, IDs, projects, authentication, and app appearance are
independent of the icon choice.
