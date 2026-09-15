# Retired memory and image gallery compatibility

Project memory and the thread image gallery were intentionally removed. Their
curation/recall APIs, clients, panels, indexing and gallery modal no longer exist.
Normal attachments, authorized reads, previews, expanded images, downloads,
history loading, pane focus, provider runtime fences and session locks remain.

## Database upgrades

Migration 058 is unchanged. Migration 059 drops only memory-owned triggers. All
saved memory rows, settings, revisions and crash-claim evidence remain untouched,
including when a project is subsequently deleted. No active service reads those
tables or interprets old claims as authority. Existing authoritative provider
orphan reconciliation remains in startup; the retired memory claim recovery is
removed. The upgrade does not claim to retract context already sent to a provider.

## Persisted requests and history

Command schemas explicitly reject the retired `projectMemory` field rather than
stripping it. The orchestration decider also rejects callers bypassing decoding.
Historical event and handoff schemas retain an opaque optional field so history
remains readable and pending deliveries can be rejected before provider dispatch.
Handoff artifacts and conversations are not rewritten or deleted.

`packages/shared/src/retiredFeatures.ts` contains only detection and a fixed error
message, with no recall or rendering implementation. Web queue sends/steering and
native outbox delivery reject affected requests. Native keeps the original row,
shows the removal explanation and blocks later messages in that thread until the
user removes it; other threads can still drain. Users must compose a new message.

Remaining feature-name references are limited to this compatibility boundary,
its tests, migrations, and the historical research report. The appearance theme
"gallery" and generic in-memory caches are unrelated. No third-party dependency
was exclusive to these features, so the lockfile is unchanged.
