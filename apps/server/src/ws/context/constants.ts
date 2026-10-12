export const PROVIDER_STATUS_DEBOUNCE_MS = 200;
export const SOURCE_CONTROL_LINKED_REFRESH_DEBOUNCE_MS = 5_000;
export const ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT = 1_000;
export const ORCHESTRATION_LEGACY_REPLAY_MAX_EVENTS = ORCHESTRATION_REPLAY_PAGE_MAX_LIMIT;
/**
 * How far behind the global event log a thread subscription may resume from.
 * A thread decides resumption on its own backlog (at most one replay page),
 * but its replay still scans global pages, so the scan is bounded too. At the
 * busiest observed rate this covers several minutes; at a typical rate, hours.
 */
export const ORCHESTRATION_THREAD_RESUME_MAX_SCAN_EVENTS = 5_000;
export const ORCHESTRATION_LIVE_QUEUE_MAX_EVENTS = 1_000;
/**
 * Byte ceiling on a subscriber's queued-but-undrained live events. The event
 * count bound above cannot bound memory on its own (payload sizes vary), so a
 * subscriber that cannot drain also trips this budget. Tripping fails the
 * subscription (never silently drops frames) and the client resynchronizes
 * from snapshot + replay, the same recovery path as count overflow.
 */
export const ORCHESTRATION_LIVE_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Burst window for progress-grade live frames (task/tool progress heartbeats,
 * streaming subagent messages, context-window gauges). Frames within a window
 * collapse to the latest per key before enqueue; every other frame passes
 * through immediately. 150ms keeps progress visibly live while collapsing
 * multi-hundred-Hz tick streams to ~7 frames/s per key.
 */
export const ORCHESTRATION_PROGRESS_COALESCE_WINDOW_MS = 150;
/**
 * Burst window for the shell stream's high-frequency thread events (activity
 * appends, streaming message deltas). The shell only sends the re-read thread
 * row, so a burst collapses to the latest event per thread; structural thread
 * events still pass through immediately.
 */
export const ORCHESTRATION_SHELL_THREAD_COALESCE_WINDOW_MS = 250;
/**
 * Ceiling on one streamed RPC chunk. Each chunk is one WebSocket frame that the
 * server waits to see acknowledged before sending the next, so batches are the
 * unit of throughput; this keeps a batch far below the 4 MiB relay message cap.
 */
export const ORCHESTRATION_STREAM_CHUNK_MAX_BYTES = 256 * 1024;
/**
 * Shell items are small re-read rows (~2 KiB) that are not measured, so shell
 * chunks are bounded by count instead.
 */
export const ORCHESTRATION_SHELL_STREAM_CHUNK_MAX_ITEMS = 128;
/**
 * Ceiling on one message of a paged shell snapshot. A shell of thousands of
 * threads is megabytes; one message that size exceeds the 4 MiB relay message
 * cap and the relayed client never gets its snapshot. Each page is one
 * acknowledged RPC chunk (a round trip on a relayed connection), so pages are
 * large: a few per thousand threads, still far below the cap.
 */
export const ORCHESTRATION_SHELL_SNAPSHOT_PAGE_MAX_BYTES = 1024 * 1024;
