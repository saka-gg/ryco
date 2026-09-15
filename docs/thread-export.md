# Markdown thread export

Select a thread and run **Export thread as Markdown** in the command palette. Keep the
palette open while history loads; close it or choose **Cancel thread export** to cancel.
The browser starts a Markdown download. Desktop opens a native save dialog; cancelling it
writes nothing.

The export contains all retained Ryco messages, timestamps, current provider/model,
project/thread identifiers, branch/worktree metadata, recorded provider handoff boundaries,
and condensed summaries of known tool lifecycle events. Message bodies are literal fenced
text, preserving whitespace, Markdown delimiters and Unicode. Recognizable credentials are
replaced with visible redaction markers. Arbitrary secret detection is not guaranteed.
Tool payloads, raw protocol dumps, credentials from settings, attachment URLs and binary
attachment contents are excluded. Attachment counts are included. Provider-only or deleted
history cannot be recovered by export; no provider calls are made.

History is read through the existing authorized environment API, independently of the UI's
loaded window. Every messages/activities page must be exhausted at one projection sequence,
which is revalidated before serialization. Reconnect, stale/repeated cursors, page failure,
cancellation or a sequence change produce no file. The sequence is currently environment-wide,
so activity in another thread can require retrying once activity settles. There are no automatic
retries. Older servers without history pagination report an update requirement.

Collection is bounded to 20,000 records and a conservative 16 MiB retained-data estimate
(strings plus per-record overhead), checked on the initial snapshot and every page, including
the final page. Only export-needed fields accumulate; full activity payloads are discarded.
Individual RPC pages still use the existing transport limits. Each read has a 30-second deadline;
cancellation detaches the export immediately but does not cancel shared underlying RPC work.
The final UTF-8 file is limited to 32 MiB. Exceeding any limit fails without producing a partial file.
