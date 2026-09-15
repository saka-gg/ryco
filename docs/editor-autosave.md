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

Autosave consults the existing connection and hosted mutation authorities. It does not reconnect,
restore mutation readiness, or replay writes automatically after a connection change. Native
mobile and the frozen web phone presentation are unchanged.
