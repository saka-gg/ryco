# Attachment previews

Web and Electron share the attachment preview UI. PDF attachments can be opened
inside a dialog, with previous/next page, zoom, fit-to-width, and download actions.
Locally attached PDFs can also be inspected in the composer before sending.

Text, Markdown, JSON, CSV, and common source files have a UTF-8 source preview,
limited to 512 KB. HTML is shown as escaped source, not executed. Unknown binary
formats and Office documents remain downloadable. A missing/generic MIME type
falls back to the filename for PDF and text preview classification; an explicit
conflicting MIME type takes precedence.

PDF.js and its worker are loaded when a PDF preview is opened. Fonts, character
maps, and image decoders are bundled locally and fetched as needed. The renderer
renders one page at a time, caps canvas dimensions, cancels superseded renders,
and destroys the document when the dialog closes. Composer blob URLs are created
on demand and revoked on close or unmount. Message blobs retain their existing
message-lifetime ownership so reopening does not repeat the RPC download.

Attachment reads continue through the existing authorized RPC transport when no
preview URL is available. Direct environments retain their existing attachment
URLs. This does not add a new public asset endpoint or change download response
headers, authorization, or service-worker caching policy.

The PDF preview is currently visual: text selection, search, interactive links,
forms, and document scripting are not enabled. Password-protected and invalid
PDFs show a download fallback. Native mobile and workspace file-explorer previews
are separate surfaces and are not changed by this implementation.

## T3 Code comparison

Reviewed `pingdotgg/t3code` at commit
[`05d404210058d714cfef902517fc20ad66b82339`](https://github.com/pingdotgg/t3code/tree/05d404210058d714cfef902517fc20ad66b82339).

- [Web FilePreviewPanel](https://github.com/pingdotgg/t3code/blob/05d404210058d714cfef902517fc20ad66b82339/apps/web/src/components/files/FilePreviewPanel.tsx)
  opens attachment and workspace PDFs in browser frames using resolved asset
  URLs. HTML uses a sandboxed frame. Ryco uses PDF.js so the shared web/desktop
  UI does not depend on a browser's embedded PDF plugin or weaken its existing
  download-only response headers.
- [iOS FilePreview](https://github.com/pingdotgg/t3code/blob/05d404210058d714cfef902517fc20ad66b82339/apps/mobile/src/components/FilePreview.ios.tsx)
  presents and dismisses a native file-preview sheet, with an error alert.
- [Composer file classification](https://github.com/pingdotgg/t3code/blob/05d404210058d714cfef902517fc20ad66b82339/apps/web/src/components/chat/composerAttachmentFiles.ts)
  normalizes supported image MIME types from filenames when a file's MIME type
  is empty or generic, handles unsupported images explicitly, and surfaces
  capability-loss send blockers.
- [Upload queue](https://github.com/pingdotgg/t3code/blob/05d404210058d714cfef902517fc20ad66b82339/apps/web/src/lib/attachmentUploadQueue.ts)
  distinguishes draft-owned uploaded attachments from queue-owned temporary
  uploads and throttles progress updates.

## Further improvements identified

1. **Native previews:** Ryco's native generic file row currently opens the share
   flow. A native file-preview sheet would let users read PDFs and supported
   Office documents in the app. Keep reads and authorization in client-runtime.
2. **MIME normalization on upload:** handle supported images dragged from apps
   that supply empty/generic MIME types. Preview classification alone does not
   correct provider routing, image sizing, or image upload validation.
3. **Restore composer previews:** uploaded drafts restored without local bytes
   currently have tokens but cannot preview until sent. Add an authorized read
   for draft-owned uploads with token-expiry handling; do not persist file bytes
   or reuse expired upload credentials.
4. **Upload cancellation:** the current transfer adapter has no abort signal.
   Removing a row invalidates its result but does not abort the transfer. Since
   the queue is already sequential, a removed large upload can delay the next
   file until its transfer settles. Propagate cancellation while preserving
   other drafts' uploads.
5. **PDF accessibility and navigation:** add a text layer, search, and page jump
   for long documents. Reuse the renderer for file-explorer PDFs only after that
   surface has an appropriate authorized binary read path.

Upload progress, retry, size/count limits, and expired-token send blockers already
exist in Ryco; they should be extended rather than replaced.
