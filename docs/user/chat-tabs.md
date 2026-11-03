# Chat tabs

On desktop and in the browser, every chat you open gets a tab in the chat header, like a browser.
The tabs take the place of the chat's title, after the project name. They stay until you close
them, also across reloads. `Cmd` below is `Ctrl` on Windows and Linux.

Turn them off in **Settings > Appearance > Open chat tabs**. The phone layout and the iPhone app
have no tabs.

## What a tab shows

- The chat's title and its provider's icon. A spinner takes the icon's place while the chat works.
- The chat on screen is the highlighted tab. Its close button always shows; other tabs show theirs
  when you point at them.
- Tabs keep their order. A new chat's tab goes last. Many tabs shrink to a minimum width, then the
  row scrolls: use a trackpad, or the mouse wheel over the tabs, to scroll it sideways. A faded edge
  means more tabs are hidden on that side.
- An unsent new chat has no tab until you send its first message. An archived chat keeps its tab
  only while it is on screen. A deleted chat's tab goes away.

## Using tabs

- **Click** a tab to open its chat.
- **Drag** a tab to move it. A press only becomes a drag after the pointer moves a few pixels, so
  a click never moves a tab.
- **Close** a tab with its `×` or a **middle click**. Closing the chat on screen opens the tab to its
  right (or to its left when it was the last one). Closing the last tab opens a new chat in its
  project. A chat that cannot be left yet, for example because an edited file could not be saved,
  keeps its tab.
- **Right-click** a tab for **Close Tabs to the Left**, **Close Tabs to the Right** and **Close
  Other Tabs**. Only the rows that would close something are listed.
- `Cmd+Ctrl+Right` and `Cmd+Ctrl+Left` on macOS (`Ctrl+PageDown` and `Ctrl+PageUp` on Windows and
  Linux) open the next and previous tab, wrapping around at either end. They work while you type.
  See [KEYBINDINGS.md](../../KEYBINDINGS.md) to change them.

## With split view

In a [split view](../thread-split-panes.md) the tabs show in the header of the focused pane, the one
you type into. Clicking the tab of a chat that is in the split focuses its pane. Clicking any other
tab opens that chat on its own, just like choosing it in the sidebar: the split is kept and comes
back when you open one of its chats again. Tabs never change a split's layout, and closing a tab
never closes a pane.

## What tabs keep

A tab only remembers which chat it is. It shows what the app already knows about the chat (title,
whether it works), so open tabs do not keep chats loaded or connections open. The list is saved on
this device. In a browser signed in to the Hub it lasts until the page reloads.
