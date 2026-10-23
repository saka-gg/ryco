# Window capture

The macOS desktop app can attach a screenshot of any app window to the message you are writing. The
capture is a normal image attachment, so it reaches local, remote and Hub-connected devices the same
way a pasted image does. The file is named after the app and window title (for example
`Safari - Release notes.png`), which tells the agent what the image shows.

## Capture from the composer

Open **Add context** (the paperclip in the composer) and choose the window icon. Ryco lists the
visible windows of other apps, frontmost first; pick one to attach it to that composer. The first time,
the list asks for **Screen Recording** instead: **Set up** opens the System Settings pane with Ryco's
guide, and the list appears once you come back with the grant. The list never asks for Input
Monitoring, even with the Option-key shortcut on.

## Capture shortcut

**Settings → General → Window capture** has an optional global shortcut. It is off by default. When
on, pressing it in any app captures the frontmost window, brings Ryco forward and attaches the capture
to the focused chat.

- **Both ⌥ Option keys** (press left and right Option together) needs Input Monitoring as well as
  Screen Recording, because it watches the modifier keys.
- **Custom shortcut** takes one modifier and one key. Ryco refuses chords macOS or another app
  already uses, chords Ryco binds itself (such as ⌘K for the command palette), and chords that
  would break typing or a universal action: ⌘C or ⌘Space, ⌥ with a letter or digit (it types
  characters such as é or @), the ⌃ text-editing keys such as ⌃A and ⌃K, terminal keys such as ⌃C,
  ⌘ or ⌥ with an arrow key, and macOS's own ⌃ shortcuts: ⌃ with an arrow key (Mission Control and
  Spaces) and ⌃Space (input sources).

The shortcut starts working once its grants are allowed, including grants given later through the
setup guide. Until then the attachment menu keeps working with Screen Recording alone, and settings
shows which grant is missing. If another app takes a saved custom shortcut, settings says so and
the shortcut stays off; Ryco tries it again each time you switch back to Ryco or open these
settings, and it works again once the other app has let go of it. The attachment menu keeps
working meanwhile. If you later give one of Ryco's own commands the saved shortcut, settings warns
you below any other notice about the shortcut: while the capture shortcut works it takes that chord
over, so choose another one.

## Permissions and Computer Use

Window capture runs the same signed helper as the Computer Use beta, inside the same app, so a
Screen Recording or Input Monitoring grant given through either setup serves both. Window capture
does not need Computer Use turned on. Startup never prompts: with a saved shortcut Ryco only checks
its grants, and it asks for nothing until you choose **Set up**.

## Delivery and recovery

The desktop app keeps each capture on disk, private to the user, until a composer has it. A capture
taken while no chat is open waits and is attached to the next composer you focus, also after a
reload or restart; so does one the open chat could not take yet, and a notice says so. A shortcut
capture never goes to another pane's chat: with the focused pane on no chat, it waits for that pane
or the next chat you open. Up to eight captures wait; a ninth discards the oldest with a notice. A
capture is released once its draft has saved it, or once it has been out of the draft for a few
seconds because you sent or removed it. Until then a reload or restart attaches it again, and a send
that fails within those seconds and puts it back keeps it (see [Limits](#limits)). A composer that
refuses it (attachment limits, an open plan question) shows why and the capture is dropped, like a
refused paste.

## Limits

- The release waits for the capture to stay out of the draft for 5 seconds after you send it. If you
  reload or quit Ryco within those 5 seconds, the capture is attached once more to the next chat you
  open; remove it if you do not need it again.
- A send that fails after more than 5 seconds has already released the desktop app's copy. The image
  it puts back is then an ordinary draft attachment, kept only as long as the draft keeps it; the
  desktop app no longer attaches it again.
- Windows and Linux are not supported yet. Attaching the window's accessibility text is a planned
  follow-up.
