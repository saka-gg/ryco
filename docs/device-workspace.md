# Device workspace

How simulators and emulators show up in a chat: device tabs in the workspace panel, a floating
window over the chat, and what happens when an agent opens a device.

## First-run setup

The first time the device panel opens on a node, it shows three steps instead of the picker:

1. **Use simulators**: the "Use simulators" switch (`devicesEnabled`).
2. **Platform checks**: iOS and Android checked on their own, with exactly what is missing
   (Xcode, its license, a runtime, a simulator for that runtime; the Android SDK, Platform-Tools,
   the Emulator, the command-line tools, an AVD) and **Check again**. One missing platform does
   not block the other.
3. **Agent access**: the "Agents can use simulators" switch (`agentDevicesEnabled`).

**Finish** or **Skip setup** saves `deviceOnboardingCompleted` on the node, so the steps show once
per node. A chat that already shows a device keeps showing it. Opening the panel or walking the
steps boots, builds and installs nothing: the checks only read what is installed. Only the node's
owner (on the Hub, with a mutation-ready connection) can change the switches or finish. With Use
simulators off after setup, the panel says so and offers **Turn on**.

While the node's first availability answer is still coming, the panel shows "Checking simulator
support…". A later slow answer (a simulator booting) reports the node's previous answer instead of
flashing "Simulator helper could not start".

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

## 3D view

**3D view** (the cube in a device tab's toolbar) shows the live device as a 3D body: an iPhone
with its Dynamic Island or notch and rear camera, an iPad, or a generic Android phone with a
punch-hole camera. The bodies are built in code from the same chassis numbers as the 2D frame
(bezel, screen corner, side buttons) and the device's own screen size; no vendor artwork or
models are used. The choice is kept per tab across reloads.

- **Press on the screen** to touch it: taps, drags and scrolls go over the same live input as the
  2D view. **Drag outside the screen** (or Alt-drag anywhere) to turn the device; it settles at
  the front, either side or the back, keeping a turn you left within each view's range.
- **Trackpad:** two-finger scroll turns the device; pinch (Ctrl-scroll with a mouse) zooms.
- **Front**, **Side**, **Back** and **Restore 3D view** over the view jump to a view; Restore
  also resets the zoom.
- Rotating the device turns the body. An iOS simulator keeps its picture on the turned body, as
  the 2D view does; an Android emulator sends its picture upright, and the body lies on its side.

3D is unavailable (the button says why) without WebGL, while the pane samples screenshots
instead of streaming video (no WebCodecs, the hosted relay, an Android emulator without scrcpy),
and while the Tools drawer's element frames are on. The tab then shows the 2D view, and returns
to 3D once it can. The floating window is always 2D.

three.js loads only when a tab first turns 3D on, as its own chunk (`deviceViewer3d`, budgeted in
`scripts/perf/model.ts`). The view renders only when something changes (a new frame, motion, a
resize), uses a low-power WebGL context, draws the video decoder's canvas as its screen texture,
and releases the context and every GPU resource when the tab closes or switches.

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
