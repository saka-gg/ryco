# Local provider usage history

Statistics reads provider-recorded counters, including sessions outside Ryco. Filters,
merging, currency totals and coverage use the shared client runtime on desktop, web
and native. Missing tokens, reasoning, price or history are unavailable, not zero.
Pricing estimates are API equivalents; provider-reported model cost takes precedence.
The usage contract is version 2. The shared transport checks the node’s advertised
usage version before sending a request; older connected nodes show an update
instruction instead of a decoding error. Update Ryco on both clients and nodes.

## Pricing and history coverage

Automatic prices preserve LiteLLM's full provider/model keys. Canonical model prices
cannot be overwritten by a gateway or regional entry; a bare alias is created only
when qualified entries agree. Explicit native `openai/` and `anthropic/` prefixes and
Claude context suffixes such as `[1m]` resolve to their model rates. Unknown model
generations remain unpriced rather than being guessed.

Recorded Codex `priority` / `ultrafast` settings and Claude fast usage select their
published billing rates, including cache rates. Without a separate cache price, the
input rate is used; cached tokens are never silently free. Cache savings measure the
discount on cache reads. Cache writes are charged, and a missing write rate cannot
hide known read savings. Provider-reported model cost still takes precedence.
This arithmetic is checked against [T3 Code's pricing implementation](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/usage/usagePricing.ts).

History includes disabled configured accounts. Codex and Claude instances resolve
stores with the same home and environment precedence as their runtime, including
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `HOME`; shared stores count once.

JSONL scans stream files up to 512 MiB with a 16 MiB line bound. Ordinary message
lines do not consume the 100,000 usage-record limit. A source can read up to 4 GiB
within five seconds; cached files do not spend its read budget. Budget-limited scans
continue looking for reusable/smaller files and report partial coverage. Refreshing
can finish remaining files instead of repeatedly stopping at the same cached prefix.
Old pricing caches and transcript caches that lost billing speed are invalidated and
rebuilt automatically. Updated pricing can be reused offline after a successful fetch.

Project/activity statistics use processed counters separately from context-window
gauges: Codex session totals are differenced, Claude completed-turn totals are retained,
and OpenCode request snapshots are deduplicated by message identity. Indexed durable
activity history recovers turns whose live projection was overwritten. New events
retain their provider/model attribution. Historical counters without a full split or
model attribution remain approximate; unavailable history cannot be reconstructed.
The provider-history cost view continues to include sessions outside Ryco and is not
attributed to projects.

## OpenCode

For a local configured OpenCode instance, Ryco reads that instance's `HOME` /
`USERPROFILE`, `XDG_DATA_HOME` and `OPENCODE_DB` path settings. The default is
`$XDG_DATA_HOME/opencode/opencode.db` (or `$HOME/.local/share/opencode/opencode.db`).
An explicit `OPENCODE_DB` is authoritative; there is no fallback to another account,
channel database or remote server. Remote OpenCode instances report unsupported
history. If the default database does not exist, the older `storage/message/<session>/msg_*.json`
layout is supported. A present database takes precedence over migrated JSON copies.

The reader supports the public v1 `message` and v2 `session_message` records verified
against OpenCode v1.18.29 and the installed public SDK. Default and explicit references to the same database share its physical identity.
It selects usage/model/time columns without loading message parts. Input excludes cached tokens; visible output
plus separately reported reasoning form output. Reported total counters are retained.
Unknown formats, missing counters, corrupt records and scan limits reduce coverage.
Only complete stable snapshots are cached; database and WAL changes invalidate them.

Sources: [OpenCode session SQL](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/session/sql.ts),
[public message schema](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/schema/src/session-message.ts),
[usage counter publication](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/session/runner/publish-llm-event.ts).

## Cursor: saved Admin API JSON exports

An authorized team admin can independently obtain the documented
[`/teams/filtered-usage-events` response](https://cursor.com/docs/account/teams/admin-api)
and save its JSON locally. Ryco never calls this endpoint, discovers authentication,
or requests credentials. Consumer CLI output and dashboard activity CSVs do not
provide a verified token ledger and are not imported.

In the enabled Cursor instance's provider settings on the node owning those files:

1. Set **Usage export path** to an absolute regular `.json` file or a dedicated local
   directory of response JSON files. A directory is flat; subdirectories are ignored.
2. Set **Usage export account key** to a non-secret team/account label. Use exactly
   the same key on every node importing the same account, and a different key for
   different accounts. This explicit declaration establishes account identity.
3. Set **Usage export user email** to the export user whose events should be included.
   Other users are filtered out. This setting is not an authentication credential.
4. Save all pages for each requested period and refresh Statistics. Leave the path
   blank to disable importing. Default consumer Cursor history shows unsupported
   coverage with instructions to configure exports.

The documented response contains `usageEvents`, `period` and `pagination`. Dates
come from epoch-millisecond string timestamps and use the selected Statistics time
zone. `isTokenBasedCall` events with all four token fields contribute tokens.
Request-priced or missing-token events contribute known event-count/billed metadata
only. No activity counter is converted into tokens. Reasoning is unavailable.
`tokenUsage.totalCents / 100` is model cost in USD; `chargedCents / 100` is billed USD
**including the Cursor fee**. Billed totals are shown separately, never added to
model cost. Missing billed values remain unavailable; unknown model prices remain
unpriced unless a model cost was reported.

Conversation IDs and user emails are hashed at ingestion. Only model, counters,
dates, costs and anonymous identity reach Statistics; transcripts and hidden fields
are not exposed or cached. The source identity hashes the account key and normalized
user email. Local paths and credentials are never included in summaries.

### Deduplication and daily charts

The public response does not document a stable event ID. Ryco fingerprints the
account/user scope, timestamp, conversation, model, event kind and usage/cost values.
Identical exports, copies and overlapping pages contribute once, including across
instances/environments. Unique events from partial exports are retained. Daily charts
sum those unique token events; billed/event-count metadata is a separate panel.

Two genuinely distinct events with identical documented fields cannot be distinguished
and may collapse. Changed usage/cost values produce a different fingerprint, so retaining
both an original export and a corrected export can count both. Replace corrected export
files rather than retaining both versions. Every Cursor source reports partial coverage
with `cursor-export-event-identity-ambiguous`; this is an explicit limitation, not a
claim of complete billing history. Missing/noncontiguous pages, inconsistent pagination,
missing counters/costs and invalid records have additional diagnostics. Gaps in partial
history are chart gaps, not asserted zero usage.

### Safety and bounds

Use a dedicated export directory, not an account/config directory. Known credential
filenames are rejected. Symlinks, FIFOs and nonregular files are rejected before opening;
reads are nonblocking, bounded, loop short reads and verify descriptor identity and
unchanged file metadata. A changed file contributes no replacement snapshot. Cursor
limits are 4 MiB/file, 32 MiB/scan, 100 files, 200 directory entries, 20,000 events and
5 seconds. OpenCode limits are 512 MiB/database, 1 MiB/record, 64 MiB projected scan,
50,000 entries and 5 seconds. A summary also bounds scanning to 128 sources and
30 seconds; sources beyond this budget receive a scan-limit notice. Cancellation stops work; reaching a limit is partial
coverage, never a complete empty result.

The scan cache is an optimization, not a saved-totals archive. A missing/failed/changed
scan must not be used to erase independently archived metrics. Any independent
archive must keep anonymous source/event identity. Cursor fingerprints do not
establish whether a changed export corrects an old event. No account data is needed for the regression tests: all fixtures are synthetic.

Reference reviewed: [t3code usage PR #10409](https://github.com/pingdotgg/t3code/pull/10409).
Its authenticated private account retrieval is not used by this implementation.
