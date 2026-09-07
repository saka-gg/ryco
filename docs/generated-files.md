# Generated files in conversations

Agents can deliver images, audio, video, documents and other task outputs as persistent message
attachments. Ryco supplies delivery and playback, not media generation: the agent still needs the
appropriate generation tool, API or local program.

## Delivering an output

Save the output inside the current thread's workspace. When the private Ryco MCP connection is
available, call `ryco_attach_file` with a workspace-relative `path` and optional display `name`:

```json
{ "path": "output/narration.mp3", "name": "Narration.mp3" }
```

The tool publishes an assistant message immediately. Do not deliver the same file again in the final
reply. It requires an active provider turn and the dedicated `files.attach` capability. It is available
through the existing opt-in Agent Control connection for Codex, Claude, Copilot and supported Cursor
sessions; it is never exposed to external Agent Control clients. Existing provider sessions may need
to be restarted to receive the new tool.

All providers also receive instructions for a fallback format. Append this top-level block to an
assistant reply:

````markdown
Your narration is ready.

```ryco-attachments
{"files":[{"path":"output/narration.mp3","name":"Narration.mp3"}]}
```
````

Ryco processes the block when the reply completes, copies the files into its attachment store and
replaces the block with attachments. Ordinary file links and code examples do not trigger delivery.
This format also works when Agent Control is disabled, and for OpenCode and Grok without injecting
cross-session MCP configuration. Model compliance with the delivery instructions is still required.

## Presentation and storage

The web/desktop timeline previews supported raster images, provides native audio/video controls and
offers named downloads. Unsupported media codecs retain a download fallback. Playback never starts
automatically. Native mobile uses its existing image/video presentation and audio play/pause controls.

Hosted web clients load files on demand using bounded chunks over the existing authenticated RPC
transport. The server checks that the requested attachment belongs to the specified persisted message.
The browser releases temporary blob URLs when their rows unmount. No direct node URLs or service
worker data caching are introduced. Native clients can consume the same platform-neutral chunk API;
the current native timeline uses its existing attachment URLs.

Each fallback reply accepts up to 8 files and 50 MiB in total. The MCP tool enforces those limits per
turn. Raster images up to 10 MiB get image previews; larger images and other formats are file
attachments. Empty files, paths outside the thread workspace, symbolic links, hard links and special
files are rejected. Media generated elsewhere must first be copied into the workspace.

Copies use bounded reads and atomic publication. Attachment IDs include a content digest, so later
workspace edits cannot overwrite a delivered snapshot. Attachment metadata travels in the existing
orchestration event and projection pipeline and remains available after reconnecting or restarting.
Missing or rejected fallback files produce a visible delivery error while preserving the reply and
any successful attachments.
