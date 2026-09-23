# Durable streaming message storage

`thread.message-sent` previously read the complete projected message, concatenated
one delta, and upserted the growing body. Long answers repeatedly rewrote SQLite
pages containing already-persisted text.

Migration 60 adds `projection_message_chunks`, keyed by message id and durable
event sequence, plus a per-message sequence fence and optional JSON text fallback.
`ProjectionThreadMessageRepository.applyEvent` owns append and completion:

- Each delta is persisted in the same transaction as message metadata and the
  projector cursor. The event log, event identity/order, commit boundaries,
  SQLite synchronous setting, and live incremental events are unchanged.
- Streaming writes never fetch the accumulated body. Resuming an existing body
  moves it into a prefix chunk once. There is no in-memory debounce or volatile
  buffer to lose on restart.
- Reads assemble ordered chunks through `persistence/messageText.ts`. Snapshot,
  detail, turn, paginated history, search, and priority readers share this logic.
  Completed ordinary messages take a direct JSON-escaped base-text path.
- Empty completion preserves assembled text; nonempty completion replaces it.
  Completion removes chunks atomically. Repeated/stale message events are fenced
  by sequence even after compaction. Event-store duplicate identity rejection and
  engine command receipts retain their existing responsibilities.
- Replacement and deletion discard chunks; revert assembles retained messages
  and preserves a sequence fence. Fork/import copies use the assembled body.
  Thread soft deletion continues to retain durable history and hide it from
  active snapshots; recreating a thread clears its old message projection.
- JSON strings retain embedded NUL and UTF-16 code units, including surrogate
  pairs split across deltas. A fallback on completed unusual text avoids native
  SQLite TEXT truncation/replacement. SQL search keeps SQLite's existing LIKE
  case/NUL semantics; returned message content is decoded in JavaScript.

The additive migration leaves saved bodies and projector cursors intact. Existing
streaming rows convert lazily on the next delta. This supports upgrading saved
databases, not running an older binary against the new in-flight chunk layout.
Previously lost/corrupted legacy code units cannot be reconstructed from a body
that no longer contains them; rebuilding uses the retained event log.

## Reproducible measurement

Run from the repository root after installing with the pinned Bun and frozen
lockfile:

```sh
node apps/server/scripts/measure-streaming-sqlite.ts 8000 1
node apps/server/scripts/measure-streaming-sqlite.ts 50000 1
node apps/server/scripts/measure-streaming-sqlite.ts 200000 1
node apps/server/scripts/measure-streaming-sqlite.ts 50000 4
```

Each invocation creates and removes its own synthetic file database, uses real
migrations, the production Effect SQL client, event store and projection pipeline,
and commits each event with its projections. It does not invoke the engine command
queue, command receipts, provider journal, providers, Electron, or UI. Therefore
these are **event-store/projection fixture measurements**, not whole-app results.
An empty completion exercises durable assembly; every result checks exact text,
streaming status, and reports a SHA-256 digest. Four messages are interleaved in one
thread. No timing assertion is used as a correctness test.

The baseline used the unchanged implementation before this patch, with the same
fixture script copied into that checkout. WAL was truncated after setup and
`wal_autocheckpoint` disabled solely in the fixture so file size measures WAL
volume. Production checkpoint configuration is unchanged. Measurements use
Node 24.21.0, SQLite 3.53.4, macOS arm64, 4096-byte pages, synchronous FULL (2),
and 40-byte ASCII deltas. Byte counts below are decimal input bytes; WAL uses MiB.

| Input             | Samples per version | WAL before → after (MiB) | WAL reduction | Stream before → after (ms) | Completion before → after (ms) |
| ----------------- | ------------------: | -----------------------: | ------------: | -------------------------: | -----------------------------: |
| 1 × 8,000 bytes   |                   1 |            14.75 → 14.49 |         1.76% |             192.97 → 84.64 |                    0.98 → 0.81 |
| 1 × 50,000 bytes  |                   1 |           123.10 → 93.04 |        24.42% |            766.06 → 447.75 |                    0.39 → 1.90 |
| 1 × 200,000 bytes |                   3 |          859.87 → 377.70 |        56.08% |          3612.11 → 1646.53 |                    0.39 → 5.10 |
| 4 × 50,000 bytes  |                   1 |          497.96 → 381.68 |        23.35% |          1987.67 → 1700.53 |                    1.58 → 6.23 |

The 200,000-byte row reports medians of three fresh-process samples; WAL byte
counts were identical across those samples. Every before/after final-content hash
matched. [Raw results](measurements/streaming-sqlite.json) retain individual times,
exact WAL byte counts, settings, and final hashes. Baseline source was
`1b53113f4a91f8aefc0d42db6791940fad3b4418`; copy the fixture script into that revision
to repeat the baseline. Final measurements ran after tests finished, with no
other verification suite launched by this task running simultaneously.

WAL volume is not physical SSD writes. No claim is made about whole-app disk,
RAM, battery, or provider throughput. Timing on this shared host is noisy; the
8 KB, 50 KB and interleaved cases are single samples. Large-answer completion
cost increases because assembly now happens once at completion. Reads of an
unfinished body still require work proportional to its accumulated content.
Normal completed side-question reads retain their SQL character bound; unusual
JSON-fallback bodies are decoded before the existing output bound is applied.

## Upstream reference

[Synara 0.8.4](https://github.com/Emanuele-web04/synara/releases/tag/v0.8.4) and its
[changelog](https://www.trysynara.com/changelog) describe append-only streaming
chunks and explicitly distinguish WAL from physical writes. The inspected
[chunk implementation](https://github.com/Emanuele-web04/synara/blob/v0.8.4/apps/server/src/persistence/messageTextChunks.ts)
and [migration 100](https://github.com/Emanuele-web04/synara/blob/v0.8.4/apps/server/src/persistence/Migrations/100_MessageTextChunks.ts)
informed the lazy-prefix migration, sequence fence, and lossless JSON encoding.
Ryco keeps its own message-id key, repository owner, transaction boundaries and
read model. Synara's separate journal/commit optimizations and segment model are
outside this change; its published percentages are not Ryco measurements.

## Regression coverage

Focused tests cover per-delta reads, duplicate/stale events, rollback and retry,
empty and replacement finals, resuming completed messages, metadata/attachments,
NUL/Unicode/split surrogates, upgrade from migration 59, actual file close/reopen
mid-stream, lagging projector replay, message projection rebuild, unchanged event
identity/order, snapshot/detail/turn/window/history/search, revert with live chunks,
replacement/fork copying and cascade cleanup. Existing engine/client tests remain
part of the repository backstop. No production database or running Ryco instance
is used by the fixture or tests.
