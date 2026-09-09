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
