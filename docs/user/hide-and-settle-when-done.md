# Hide until needed, and settle when done

Two ways to clear the Inbox without losing track of work. Both are kept by the machine the thread
runs on, so every device sees the same thing. They need a machine that runs this version; on an
older one the menu items are disabled.

## Hide until needed

Choose **Hide until needed** from a thread's menu (on the iPhone app: **Hide task**). The thread
moves to the **Hidden** section at the bottom of the Inbox, which starts collapsed. It stays there
while it works and after it finishes, and finishing makes no alert.

A hidden thread comes back on its own only while it needs you:

- it asks for an approval or an answer,
- it has a plan for you to review, or
- its run failed after you hid it.

It returns to the shelf once that is dealt with. To keep a thread whose failure you have seen on
the shelf, hide it again. **Show in Inbox** brings it back for good. Hide has an Undo notice; see
[Sidebar Undo](../sidebar-undo.md).

This suits threads you start and check later, such as nightly runs.

## Settle when done

**Settle** on a thread that is still working is **Settle when done**: the thread moves to
**Settled** right away, still shown as working, and the machine settles it once the turn and any
work it started in the background finish. A monitor it left running, such as a dev server, does not
hold it back. Its finish makes no alert.

The thread comes back to Active instead when:

- it asks for an approval or an answer, or has a plan to review (it settles once that is dealt
  with and the work finishes),
- its run fails or someone presses Stop, or
- you send it a message, Move it to Active, or snooze or archive it.

Agent Control messages, delegated results and pull request updates keep it filed: they continue the
work you filed.
