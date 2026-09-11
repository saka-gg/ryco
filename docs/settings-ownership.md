# Settings ownership

The shared web and desktop settings dialog has two destinations:

- **This browser / This app** stores appearance, composer preferences, confirmations,
  notifications, and other interaction preferences in the current client. Desktop
  permissions, updates, and saved connections also belong here. Changing a theme
  in the Hub never changes a desktop or phone theme.
- **Node: name** configures the selected server: providers, MCP, source control
  integrations, model selections, project defaults, keybindings, and diagnostics.
  Only sections permitted by the current node role are offered. Node security is
  under Connections → Advanced.

Hub account and device enrollment remain on the Hub account pages. Browser
appearance on those pages is still local to that browser.

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
