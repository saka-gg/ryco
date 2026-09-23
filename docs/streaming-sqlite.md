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
  Completed ordinary messages return raw TEXT without JSON encoding or decoding.
  Only streaming rows and explicit fallback rows assemble/decode JSON.
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

The additive migrations leave saved bodies and projector cursors intact. Migration
61 scans saved text once to populate the fallback for legacy NUL bodies, including
databases already at migration 60; existing surrogate fallbacks are retained. This
adds upgrade work proportional to saved body size, outside the measurements below. Existing
streaming rows convert lazily on the next delta. This supports upgrading saved
databases, not running an older binary against the new in-flight chunk layout.
Previously lost/corrupted legacy code units cannot be reconstructed from a body
that no longer contains them; rebuilding uses the retained event log.

## Reproducible measurement

```sh
bun install --frozen-lockfile # Bun 1.4.0
node apps/server/scripts/compare-streaming-sqlite.ts
# Individual run; profiles: buffered, streaming, timer, stress, reads
node apps/server/scripts/measure-streaming-sqlite.ts 200000 1 buffered
# Exact base server sources, same fixture/runtime/dependencies, no checkout needed
RYCO_SQLITE_FIXTURE_REF=1b53113f4a91f8aefc0d42db6791940fad3b4418 node --import ./apps/server/scripts/streaming-sqlite-revision.ts apps/server/scripts/measure-streaming-sqlite.ts 200000 1 buffered
node apps/server/scripts/reproduce-streaming-downgrade.ts
```

The comparison runs sequential fresh processes, alternating base and fixed order.
It loads committed server source via a read-only Node module hook: base
`1b53113f4a91f8aefc0d42db6791940fad3b4418`, reviewed PR
`da8127a58b9a2688b0abdf7e846367bda37d5489`, and the fixed working tree. The
fixture and installed dependencies stay identical. Node 24.21.0, SQLite 3.53.4,
macOS arm64, 4096-byte pages, synchronous FULL (2). No other verification suite
was launched by this task during measurement; shared-host activity is uncontrolled.
[Raw samples](measurements/streaming-sqlite-review.json) include every timing,
WAL byte count, settings, and final-content hash.

Each write invocation creates a synthetic file database, runs real migrations,
and commits each event through the production Effect SQL client, event store and
projection pipeline. WAL is truncated after setup and automatic checkpoints are
disabled only in the fixture. Every final body is checked exactly and SHA-256
hashes match across versions. This measures **event-store/projection work**, not
provider throughput or whole-app performance. It excludes the engine command queue,
command receipts, provider journal, provider/network waiting, Electron and UI.

Batch profiles follow `ProviderRuntimeIngestion`'s existing policy:

- **Buffered (default token streaming off):** 40-character source fragments spill
  after exceeding 24,000 characters, hence 24,040-character persisted batches;
  flush the remainder before an empty final.
- **Streaming threshold:** 4,096-character persisted batches, representing the
  size-triggered flush. The production timer also flushes after 32 ms.
- **Streaming timer:** 320-character batches model 40 characters arriving every
  4 ms for 32 ms. Slower arrivals can produce still smaller batches; 4 KB is not
  a minimum. These are synthetic post-coalescing profiles, not recordings of
  provider traffic, and the fixture does not sleep between commits.
- **Stress:** the original unbatched 40-character profile remains available.
  Its historical [raw results](measurements/streaming-sqlite.json) are retained
  only as stress evidence. The original single-sample speedup claims are withdrawn.

### Writes

Five samples per version/scenario. Times below are median [minimum–maximum] ms;
WAL byte counts were identical within every scenario/version. ASCII input sizes
are decimal bytes. Completion timing is separate from streaming timing.

| Profile / bytes     | WAL base → fixed (bytes) | Change | Streaming base → fixed (ms)               | Completion base → fixed (ms)        |
| ------------------- | -----------------------: | -----: | ----------------------------------------- | ----------------------------------- |
| buffered / 4,000    |        156,592 → 177,192 | +13.2% | 1.07 [0.89–5.16] → 1.13 [1.11–1.60]       | 0.60 [0.54–4.13] → 0.94 [0.79–1.41] |
| buffered / 50,000   |        477,952 → 482,072 |  +0.9% | 2.59 [2.28–12.70] → 2.63 [2.40–3.10]      | 0.57 [0.46–7.84] → 0.99 [0.85–1.26] |
| buffered / 200,000  |    2,051,792 → 1,421,432 | -30.7% | 8.25 [7.45–14.15] → 9.76 [6.27–13.48]     | 0.65 [0.56–1.10] → 1.44 [1.30–2.54] |
| streaming / 50,000  |    1,520,312 → 1,289,592 | -15.2% | 9.88 [7.26–10.21] → 10.54 [7.83–11.42]    | 0.49 [0.39–0.76] → 1.19 [0.97–2.13] |
| streaming / 200,000 |    9,179,392 → 4,746,272 | -48.3% | 33.88 [33.32–57.64] → 27.76 [27.34–33.46] | 0.63 [0.44–0.96] → 3.53 [3.23–7.03] |
| timer / 50,000      |  16,092,752 → 12,623,712 | -21.6% | 72.94 [67.65–95.49] → 75.50 [67.22–93.35] | 0.33 [0.30–0.64] → 1.53 [1.25–2.02] |

The long-message WAL benefit is real in this fixture, but there is **no established
general net benefit for default users**: short/default messages write more WAL,
most timing distributions overlap, and completion is slower. The 200 KB
size-triggered streaming case shows lower median streaming time, but that does
not establish an application-wide speedup. WAL bytes are not physical disk writes
or SSD wear; checkpointing, the event log and other application writes still exist.

### Completed-message reads

Each fresh process seeds 2,000 completed 4,200-character messages (quotes,
backslashes and newlines included). For each operation, three warmups precede
20 timed calls with result checks; three processes per version give 60 samples.
All full bodies and the final retained-history hash match. Repository, query,
pagination and priority calls include SQL, schema decoding and result mapping.
The actual `thread.reverted` event transaction retains all messages and recomputes
the shell summary, including its full message-list read. Setup is outside timing.
Search checks snippets; command read model returns the first user message.

Median [p10–p90] ms (nearest-rank percentiles); these are warm-operation distributions, not independent host trials.

| Read path              |                   Base |            Reviewed PR |                  Fixed |
| ---------------------- | ---------------------: | ---------------------: | ---------------------: |
| repositoryList         |    6.903 [5.552–9.349] | 20.563 [18.885–23.295] |    6.813 [5.745–8.500] |
| repositoryGet          |    0.011 [0.010–0.014] |    0.020 [0.019–0.024] |    0.014 [0.013–0.018] |
| snapshot               |   9.792 [7.888–11.846] | 23.580 [21.687–25.910] |  10.069 [8.214–14.005] |
| detail                 |    8.049 [7.141–8.843] | 22.544 [20.741–25.693] |   8.540 [7.606–10.896] |
| window100              |    0.480 [0.450–0.523] |    1.124 [1.065–1.366] |    0.540 [0.476–0.845] |
| history100             |    0.323 [0.304–0.378] |    0.976 [0.931–1.119] |    0.360 [0.328–0.515] |
| turn100                |    0.230 [0.225–0.239] |    0.877 [0.834–0.956] |    0.257 [0.249–0.332] |
| queryMessage           |    0.011 [0.010–0.014] |    0.019 [0.019–0.022] |    0.013 [0.012–0.017] |
| commandReadModel       |    0.160 [0.150–0.197] |    0.175 [0.162–0.197] |    0.165 [0.148–0.197] |
| search50               |    8.992 [8.357–9.532] | 13.278 [12.081–14.523] |   9.235 [8.420–10.729] |
| priority               |    0.181 [0.177–0.189] |    0.200 [0.183–0.443] |    0.180 [0.174–0.188] |
| sideContext201         |    0.526 [0.494–0.706] |    2.463 [2.028–3.306] |    0.576 [0.505–0.696] |
| revertIncludingSummary | 12.803 [11.224–14.217] | 40.318 [37.668–47.167] | 12.356 [11.013–14.080] |

These results reproduce the reviewed JSON regression (including revert) and show
its removal. They do **not** prove every path is as fast as base: additional row
metadata, fallback selection, query shape, allocation and host noise remain.
Small-page/side-context and revert medians can remain higher. Normal completed
side-question reads keep their SQL character bound; unusual fallback bodies are
decoded before the existing output bound. Unfinished reads remain proportional to
the accumulated body/chunk count.

## Restart and downgrade limits

A file reopen and projector replay do not invent a terminal event. Without provider
completion evidence, orphaned messages keep their durable chunks indefinitely;
this is retained message content, not a volatile cache with a timeout. Repeated
close/reopen tests check exact text and unchanged chunk counts. Existing provider
history reconciliation completes recovered messages and removes their chunks;
a regression now asserts both the pending chunks and their cleanup. Completion,
replacement, hard message deletion and revert remove applicable chunks. Thread
soft deletion intentionally retains history; no automatic orphan garbage collection
is added. If a provider never supplies terminal history, retained chunks continue
to cost storage and assembly work. No process-kill/provider integration was run;
file-backed connection reopen and ingestion reconciliation are separate tests.

The downgrade counterexample is **reproduced**, not hypothetical. On a synthetic
schema-61 database with `prefix more` in chunks, the actual base repository and
migration runner open successfully and read an empty body. Appending ` OLD` with
that repository and then ` NEW` with the new repository yields
` OLDprefix more NEW`, demonstrating reordered/corrupted content.

The new migration runner refuses a schema newer than its supported migration
before migrations/repairs run. A regression checks refusal without schema mutation.
This protects future downgrades between binaries containing that check; it cannot
make already-shipped older binaries reject schema 60/61 or prevent their reads.
Triggers would not prevent old reads and would add another write protocol, so
none are introduced. Do not open this migrated database with an older binary.
For rollback, restore a **pre-upgrade backup in a separate data directory**, keeping
the upgraded database intact; the backup will not include subsequent events.
There is no supported in-place downgrade or automatic repair of mixed-version writes.

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
NUL/Unicode/split surrogates, upgrade from migrations 59 and 60, raw completed read/bounded-text fallback,
future-schema rejection, actual file close/reopen
mid-stream, lagging projector replay, message projection rebuild, unchanged event
identity/order, snapshot/detail/turn/window/history/search, revert with live chunks,
replacement/fork copying and cascade cleanup. Existing engine/client tests remain
part of the repository backstop. No production database or running Ryco instance
is used by the fixture or tests.
