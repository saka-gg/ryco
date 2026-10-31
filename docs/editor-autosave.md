# File Preview autosave

Desktop and web File Preview save editable text files after 400 ms without typing. Save and
Ctrl/Command-S drain immediately. File switching, closing the panel, route navigation and turn
submission wait for pending edits, including text entered during a write. Queued turns use the
same save barrier before dispatch. A failed save preserves the file draft and composer; text or
attachments added while a send waits remain in the composer.

Each environment/workspace/file has one in-memory edit session and one serialized writer.
Failed drafts survive panel remounts and can be recovered by reopening File Preview. Clean unused
sessions are released. Drafts are not stored on disk or in the service worker. Browser shutdown
cannot wait for a write and uses the unsaved-changes warning instead.

Failures pause automatic saving. Typing does not dismiss the error or trigger a retry loop.

- **Save** retries explicitly. An uncertain write is read back before retrying: an acknowledged
  disk match is accepted, an unchanged baseline permits retry, and an external change conflicts.
- **Reload** confirms replacement of the draft with current disk contents. Newer typing and stale
  connection responses cannot replace the draft.
- **Discard** abandons local edits without reading or writing, including while offline. If a write
  might already have reached the server, the UI marks disk state unknown and requires Reload
  before further editing. Discard cannot undo a write already delivered to the server.
- **Overwrite** confirms replacing an externally changed file. It reads the current version and
  uses the existing atomic, version-checked write with the disk encoding and line endings. An
  intervening external edit fails with another conflict. Explorer does not recreate deleted files.

## Changes on disk

On nodes that advertise `projectFileWatch`, File Preview watches the open text file while the
panel shows it and the page is visible (`projects.subscribeFileChanges`). The node watches the
file's folder, so an editor's atomic save is seen too, and reports the version `projects.readFile`
would return for the file's bytes. It never sends the content. When the version differs from the
one the panel holds, the panel reads the file again:

- A clean editor takes the new text.
- Unsaved edits get the conflict notice at once, and autosave pauses until **Reload** or
  **Overwrite**. Before, the conflict appeared only at the next save.
- A deleted file goes through the usual missing-file handling.

The panel's own saves report the version it already holds, so they cost no extra read. A file that
becomes a link out of the project reads as deleted. Each connection watches at most 8 files and a
node at most 256 folders; past that the watch is refused and the panel refreshes as older nodes do.
While a file is watched its workspace stays held, as it does after any read on that connection.
Older nodes still refresh an open file only after a turn that changed it.

## Connections

Autosave consults the existing connection and hosted mutation authorities. It does not reconnect,
restore mutation readiness, or replay writes automatically after a connection change. Native
mobile and the frozen web phone presentation are unchanged.
