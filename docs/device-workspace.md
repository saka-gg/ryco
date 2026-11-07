# Device workspace

How simulators and emulators show up in a chat: device tabs in the workspace panel, a floating
window over the chat, and what happens when an agent opens a device.

## Device tabs

Open the workspace panel's **+** and choose **Device**, or press the simulator shortcut. The
first tab is the picker: devices grouped per platform (and per host once SSH device hosts are
configured), each marked Running, Starting or Stopped, with **Open** for a running device and
**Start** for a stopped one. Start boots the device for this chat and opens it; past the boot
cap, the "shut one down" dialog offers the devices Ryco booted.

Each device opens in its own tab, named after the device. Double-click a tab, or right-click it
and choose **Rename**, to give it a name; an empty name goes back to the device's. **+ →
Device** again opens another device beside the first.

Only the tab on screen streams: switching tabs closes the other tab's frame socket and decoder
and keeps its device running. Closing a tab stops watching the device and leaves it running; a
device Ryco booted then shuts down after the usual idle grace unless something else uses it.
Tabs are kept per chat across reloads, so a closed tab stays closed.

While a device is starting, for this chat (from its picker, by its agent, or attached to it),
every client viewing the chat shows "Starting <device>… this can take a minute."

## Floating device over chat

**Float device over chat** in a device's toolbar (or its tab's menu) moves the live,
interactive device into a small window over the chat, so the workspace panel can show
something else. Drag the window by its handle; resize it from any edge or corner; it keeps
the device's shape and stays clear of the composer. **Open in right panel** puts it back in
its tab; the close button stops watching it.

A device streams in one place at a time: while it floats, its tab shows a placeholder.

The window is the workspace mini-player (`apps/web/src/deviceWorkspace`): generic over what
it shows, with a device as its first source. The browser preview can become another source
once its native desktop view can follow a floating DOM slot.

## When an agent opens a device

When an agent boots, attaches or drives a device in a chat, every web and desktop client
viewing that chat shows it floating over the chat. A client that opens the chat later (within
the request's hold window) shows it then. Turn off **Settings → Chat → Float devices agents
open** to open the agent's device as a tab in the workspace panel instead. Nothing opens when
the visible panel already shows that device, and a device whose tab or window you closed is
not reopened for that agent's further use of it. An agent's device you watch in a tab becomes
yours like any device you open: it keeps running while the tab is open. The agent's tool calls
appear in the chat timeline as usual.

## Several devices per chat

A chat may attach up to eight devices (`DEVICE_THREAD_ATTACHMENT_LIMIT`). `ThreadDeviceState`
lists them oldest first in `attachments`, each with who attached it (`user` or `agent`), its
startup phase and its last error. `attachedDeviceUdid` is the most recent one: what an agent or
Agent Control means by "the attached device" when it names none. Attaching a device the chat
already has makes it the most recent. `device.lifecycle` `detach` takes an optional `udid`;
without one it detaches every device. `boot` takes an optional `threadId`, which puts the
device in that chat's `startingDeviceUdids` while it boots.

Boot ownership is unchanged: a person's attachment keeps a Ryco-booted device running, an
agent's does not, and only Ryco's own boots are ever shut down. Attaching a second device no
longer shuts the first down at once; closing its tab lets the idle grace decide. Agent Control
checks a device against all of the chat's attachments, and an agent's new attachment asks the
chat's clients to show the device.
