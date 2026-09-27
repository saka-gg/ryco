# Ryco overview sidebar studies

## Second exploration: small shortcut docks

Open `shortcut-docks.html` for the three new concepts. It is also self-contained.

- **Edge capsule:** a short 44 px rail under the header; approach to reveal labels.
- **Floating stack:** a short 46 px rail centered on the edge; hover an icon for a
  small preview, while the rail remains icon-only.
- **Corner dock:** a horizontal icon dock above the composer with brief hover labels.

All three are launchers. Clicking Review, Files, Terminal, Browser, or Run opens
the separate full right workspace panel. Open-in shows an application picker.
Use Show workspace to compare coexistence; switching concepts preserves the open
workspace. Hover never opens the workspace. Keyboard activation and Escape work
with hover hints disabled. Actions and content remain simulated.

Rebuild this second demo with `node output/overview-sidebar/generate-shortcuts.mjs`
from the repository root after installing its pinned dependencies. The generator
reuses the first demo's shell and the repository's existing Lucide icons.

Checked: desktop and laptop layout containment, hover hints, separate workspace
opening and closing, tool switching, application picker, keyboard activation and
focus restoration, JavaScript parsing, and focused HTML formatting.

## First exploration

Open `index.html` directly in a browser. The file includes its font, icons, styles,
and interactions; it does not need a server or network connection.

The three tabs use the same sample Ryco project and conversation:

| Concept | Default width | Expanded view | Tradeoff |
| --- | --- | --- | --- |
| Compact overview | 232 px | 320 px overlay | Recommended: preserves visible context while saving about 120 px. |
| Quiet rail | 56 px | 320 px overlay | Most conversation space, but status details need an extra interaction. |
| Status strip | 112 px | 298 px flyout beside the strip | Keeps counts visible; details are split into contextual views. |

The current production overview frame is `calc(340px + 0.75rem)`, approximately
352 px. These concepts reserve their default width and overlay the extra detail,
so expanding does not reflow the conversation. On very small demo viewports,
the compact concept uses 176 px. This is standalone demo behavior, not an update
to Ryco's frozen web phone tier.

Try hovering near the sidebar, pinning it, disabling hover, opening the editor
menu, expanding sections, and using Files, Terminal, Browser, Run, or file review.
Use Tab for keyboard navigation and Escape to dismiss. Status-strip sections can
be clicked to hold their flyouts open. The laptop-width button constrains the
sample app to 1120 px; Reset restores the current concept's initial state.

All project data and workspace actions are simulated. Nothing launches an editor,
starts an agent, runs a command, or changes the real project. The live app source
is unchanged.

Validation: Bun 1.4.0 frozen install; focused HTML formatting and JavaScript parse
checks; browser checks for hover expansion/collapse, pinning, keyboard focus,
Escape, editor menus, workspace actions, and desktop/laptop layout containment.
Embedded SVG icons come from the repository's Lucide React dependency; DM Sans
comes from its existing font dependency.
