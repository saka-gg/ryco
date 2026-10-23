# Response streaming

**Settings → General → Responses → Response streaming** chooses how a node delivers assistant
text to every client while a reply streams. It is a node setting (`responseStreamingMode`), so
web, desktop and the phone app all see the same thing.

| Mode                    | What clients see                                                       |
| ----------------------- | ---------------------------------------------------------------------- |
| Paragraphs (default)    | Each finished paragraph or closed code block, at most every 400 ms.    |
| Whole messages          | Each message once it is complete (or the turn pauses for an approval). |
| Token by token (legacy) | Every provider delta, coalesced every 32 ms. Asks for confirmation.    |

## Paragraph mode

`ProviderRuntimeIngestion` buffers each assistant message and releases its ready prefix as an
ordinary `thread.message.assistant.delta`. `splitBufferedAssistantText`
(`@ryco/shared/assistantStreaming`) decides what is ready:

- Only newline-terminated lines count, so a partial line never leaks.
- Text is ready up to the last blank line, closing code fence or finished indented code block
  outside an open code block. Code blocks follow CommonMark, including the list items they sit
  in: backtick or tilde fences, a closer of the same character that is at least as long, has no
  info string and is indented at most three columns past its list item's content; a fence that
  ends with its list item; and indented code, which only a less indented line ends. CRLF line
  endings, tabs and backtick info strings are handled. Block quotes are not tracked, so a fence
  inside one is quoted text (a blank line ends the quote anyway).
- No text inside an open code block is released, however many blank lines it holds. Only the
  memory spill below can cut one before the message ends.
- A file delivery manifest (a `ryco-attachments` fence) and everything after it wait for the
  reply to complete, when the node turns it into attachments, so the manifest never streams.
  Only the memory spill can send it early, if more than 24,000 characters follow it.

Each message keeps where its sent text left off in the Markdown (an open fence, open list
items, a line begun but not finished). The next split continues from there, so text sent whole
does not throw the split off: the 24,000-character spill, a flush when a turn pauses for an
approval or a question, and text streamed token by token before a switch to paragraphs.

Every release is a persisted orchestration event and relay traffic, so releases are paced to at
most one per message every 400 ms on the server clock. Blocks that finish in between land
together with the next delta, or with a trailing release once the 400 ms have passed, so a
finished block never waits for a provider that has gone quiet. Held text changes only once a
release is persisted: a write that fails sends the same text with the next release. The
24,000-character spill, the remainder on completion and the flush when a turn pauses for an
approval or a question work as before.

A long answer in the ingestion test (20,671 characters arriving as 1,034 provider deltas over
10.3 s, about 2,000 characters a second) is persisted as 27 deltas: 26 paced releases and the
remainder on completion. Token mode would persist about 320 (one per 32 ms flush) and whole
messages one.

## Clients

Released text is plain message text, so clients need nothing new to show it; the phone app
renders it as it arrives. On web and desktop, each block that arrives while a paragraph-streamed
message is on screen fades in once (CSS `@starting-style`). The blocks already there when a
message mounts never fade, so opening a thread, even mid-reply, or scrolling back to a running
turn replays nothing. Reduced motion, from the OS or the app's own preference, turns the fade
off. The gradual character reveal stays for token mode only, without the fade; paragraph and
whole-message releases appear as finished blocks. Live chapters show their streamed paragraphs
the same way.

## Compatibility

- `responseStreamingMode` replaces `enableLegacyTokenStreaming`. A node that reads a settings
  file with `enableLegacyTokenStreaming: true` and no `responseStreamingMode` keeps token mode;
  otherwise it uses the paragraph default. The next save writes the new key and drops the old
  one.
- Older clients still write `enableLegacyTokenStreaming`: on selects token mode, off returns
  token mode to the default and leaves other modes alone. When a patch carries both keys,
  `responseStreamingMode` wins. Older clients read the switch as off.
- Agent Control's `legacyTokenStreaming` setting maps the same way (see
  [Agent Control settings](agent-control-project-settings.md)).
- Nodes advertise the `responseStreamingModes` capability. Against an older node, the setting is
  shown read-only as "Set by the node" with a note to update the node, and text keeps the
  gradual reveal. Such a node streams whole messages, or tokens if its legacy switch is on;
  clients cannot read that switch, so neither the row nor Restore defaults changes it.
