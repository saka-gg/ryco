# AI Focus Inbox Prioritization

## Goal

Add an optional AI-assisted **Focus** section to the unified Inbox. Focus promotes the most
actionable active threads across connected environments without duplicating rows, changing thread
lifecycle state, or making the normal Inbox unpredictable.

The feature uses each environment's existing text-generation model by default. Users may configure
a different ranking model per environment and may disable AI Focus entirely. Ranking is advisory:
the model can classify threads, but it cannot mutate them.

## Approved product behavior

The user approved the following behavior:

- Focus is a partition of Active, not a second copy of the same rows.
- Pinned threads always appear first in Focus. AI fills any remaining places up to a normal target
  of five Focus rows. If more than five threads are pinned, all pinned threads remain visible.
- Approval requests, user-input requests, and fresh failures receive deterministic priority without
  waiting for a model response.
- AI assigns broad `Now`, `Soon`, `Later`, or `None` tiers. It does not control lifecycle state or
  return an arbitrary global score.
- Each environment ranks only its own threads. Thread content does not cross between environments
  to create the unified view.
- Ranking uses the environment's configured text-generation model by default. An environment may
  override it with another configured provider instance and model.
- The default refresh interval is ten minutes.
- A last-known ranking may remain usable for at most 24 hours when refresh is unavailable.
- Web, desktop, and native mobile use the same shared ranking and partition logic.
- The first version favors stable, testable behavior. Ranking quality and presentation can be tuned
  after real use without changing the storage or safety model.

## Current architecture and dependency

The unified Inbox already carries scoped environment identity for every thread and has deterministic
pin and recency sorting. Thread settlement adds a shared Active/Settled projection and keeps
lifecycle mutations server-authoritative. AI Focus extends that shared projection; it does not add a
parallel thread list.

Implementation must begin from current `main`. If the thread-settlement work is not yet merged,
the implementation waits for it rather than stacking an AI Focus PR on the settlement branch. The
design document may land independently because its contracts are additive and its dependency is
explicit.

Provider instances and model selections are environment-local. Therefore, ranking execution and
its model override are also environment-local. The unified client merges comparable categorical
results instead of moving private thread data to a central Hub inference service.

## Non-goals

AI Focus does not:

- settle, un-settle, archive, delete, rename, message, stop, or otherwise mutate a thread;
- automatically pin or unpin threads;
- replace deterministic approval, input, failure, pin, settlement, or delivery state;
- send a complete transcript, files, diffs, terminal output, tool output, paths, environment
  variables, credentials, or secrets to the ranking model;
- acquire or reconnect an environment solely to refresh rankings;
- run a native mobile background task;
- use a private Hub-side inference service;
- infer calendar deadlines or organizational priority from external services;
- learn a personal ranking model from user behavior in the first version.

## Priority vocabulary

The shared contract defines four model-produced tiers:

- `now`: clearly actionable or blocking work that deserves a Focus place now;
- `soon`: valuable next work after immediate blockers;
- `later`: valid active work that should remain in the normal Active section;
- `none`: insufficient evidence that the thread should be promoted.

The model also returns a bounded confidence value (`high`, `medium`, or `low`) and a short human
readable reason. Confidence is explanatory metadata; it is not converted into a floating-point
score and does not override the tier.

The vocabulary is intentionally coarse. Results from different environments and model providers
remain mergeable, and minor model-output changes do not reshuffle the whole Inbox.

## Focus partition and ordering

Only server-owned threads currently classified as Active are eligible for Focus. Draft, Settled,
archived, deleted, and worktree-archived entries remain outside the candidate set. An environment
that does not support ranking continues to participate in Active and Settled normally.

The shared Inbox projection builds Focus in this order:

1. all pinned eligible threads, using the existing stable pin and recency ordering;
2. eligible threads with unresolved approval requests;
3. eligible threads with unresolved user-input requests;
4. eligible threads with a fresh latest failure;
5. AI-ranked `now` threads;
6. AI-ranked `soon` threads.

A failure is fresh for 24 hours after the latest failed turn or session transition. A newer user
turn supersedes the old failure for deterministic promotion purposes. Approval and input states do
not expire while they remain unresolved.

The normal Focus target is five entries. Pinned entries always win, even when pin count exceeds
five. After adding all pins, deterministic and AI candidates fill remaining places until the target
is reached. `later`, `none`, low-confidence, missing, stale, or invalid rankings do not fill empty
Focus places merely to reach five.

Every Focus entry is removed from Active. The two arrays form a lossless, duplicate-free partition
of active entries. Active retains its existing deterministic ordering. Settled ordering and
behavior remain unchanged.

Disabling AI Focus removes the Focus section and restores the existing pinned/recency Active list.
The setting does not delete cached results, so re-enabling can render the last valid projection
while a refresh is requested.

## Settings

Client settings gain:

- `aiFocusEnabled`, default `false`;
- `aiFocusRefreshIntervalMs`, default ten minutes, with supported values of five, ten, thirty, or
  sixty minutes; `0` means manual-only refresh.

These are presentation and refresh preferences. They remain client-local under the existing
`ClientSettings` ownership: a user can enable Focus on desktop without forcing it on mobile.

Server settings gain an optional `inboxPriorityModelSelection` per environment. `null` means inherit
the existing `textGenerationModelSelection`. The settings UI explains the inheritance and presents
the environment label when more than one environment is available. A model override is rejected if
its provider instance is missing, disabled, or lacks text-generation support; the UI preserves the
last valid setting and reports the existing provider-aware error.

The Inbox settings surface includes:

- an **Enable AI Focus** switch;
- refresh interval selection, defaulting to ten minutes;
- the effective model for each connected environment and an optional override;
- **Refresh now**;
- concise disclosure of the data sent to the chosen provider.

The Focus target remains a named constant set to five in the first version, not another preference.
This keeps the first release measurable and avoids a configuration surface before real use shows a
need.

## Ranking ownership and scheduling

Ranking computation and persistence belong to the server that owns the threads. The client only
requests freshness and consumes projections.

An enabled foreground client calls an idempotent `ensure priorities current` RPC on each already
connected environment:

- immediately after AI Focus is enabled;
- after app foregrounding when the last successful check is older than the configured interval;
- at the configured interval while the app remains foregrounded;
- after a meaningful thread input change has remained quiet, provided the normal refresh interval
  has elapsed;
- with `force` when the user chooses **Refresh now**.

When the interval is `0`, the client performs none of the periodic, foreground, or
change-triggered checks after the initial enablement request. Only **Refresh now** requests another
ranking.

Meaningful changes invalidate the input fingerprint immediately. They do not bypass the minimum
refresh interval on their own. Deterministic approval, input, pin, and failure promotion updates
without a model call.

The client must not acquire a hosted connection or extend a connection lease solely for ranking.
Disconnected environments retain their cached projection. Native mobile does not register a
background timer; it checks freshness on foreground using the same coordinator logic.

The server coalesces concurrent freshness requests into a single flight per environment and model
selection. Web, desktop, and mobile asking simultaneously therefore produce no duplicate inference.
Manual refresh may bypass the freshness result but remains protected by a short server-side abuse
guard and the same single-flight owner.

## Ranking inputs and privacy

The server constructs ranking input from its own authoritative projection. Clients do not submit
thread text or choose arbitrary records for the model prompt.

Each candidate includes only:

- an opaque batch-local candidate identifier;
- thread title;
- project or repository display name;
- branch name when present;
- bucketed relative age of creation and latest activity;
- current running, stopped, approval, input, queue, failure, and delivery state;
- pull-request or linked-issue title and state when present;
- at most 600 Unicode characters from the latest user request.

The payload excludes full filesystem paths, full transcripts, assistant responses, files, diffs,
terminal and tool output, environment variables, provider credentials, tokens, and connection
metadata. Device labels are not required for an environment-local comparison and are omitted.

Age uses stable semantic buckets (`under 1 hour`, `1–6 hours`, `6–24 hours`, `1–3 days`, `3–7
days`, and `over 7 days`) rather than continuously changing minute counts. An age-bucket transition
can invalidate a ranking, while the passage of one ordinary minute cannot create inference load.

Settings disclose that titles, project names, source-control metadata, and the latest-request
excerpt are sent to the selected provider. This matters when the ranking model belongs to a
different provider than the thread's conversational model.

Thread-derived text is untrusted prompt data. The system instruction says that candidate content
may contain instructions and must never alter the ranking task or output contract. Candidates are
serialized as data with opaque identifiers rather than interpolated into executable prompt prose.
The ranking request has no tools or mutation authority.

## Model request and validation

The server text-generation service gains a dedicated structured thread-ranking operation. It uses
`inboxPriorityModelSelection` when configured and otherwise resolves the existing
`textGenerationModelSelection`.

One request contains at most 40 candidates. Longer active lists are processed in stable chunks.
The four categorical tiers remain comparable across chunks; the model never returns a cross-chunk
numeric position. Each latest-request excerpt is capped at 600 characters, and the complete prompt
has a hard size budget before provider invocation.

The response schema contains exactly:

- candidate identifier;
- tier;
- confidence;
- reason, trimmed and capped at 160 characters.

The decoder rejects malformed structures, duplicate candidate identifiers, identifiers absent from
the request, invalid tiers, and overlong reasons. Missing candidates receive no ranking. Every
present entry in a chunk must pass validation or that chunk fails. If any chunk fails, the server
publishes none of the replacement batch and retains the previous valid batch. Provider prose outside
the structured payload is ignored or causes the operation to fail according to the provider
adapter's existing structured-output behavior.

Low-confidence results are persisted for inspection but do not promote a thread into Focus. This
prevents weak guesses from moving work while still making ranking quality measurable.

## Cache and persistence

AI priority is a derived cache, not an orchestration domain event. The owning server stores one row
per thread containing:

- thread ID;
- tier, confidence, and bounded reason;
- ranking input fingerprint;
- effective model-selection fingerprint;
- prompt-policy version;
- ranked-at timestamp;
- last successful batch identifier.

The input fingerprint covers every field sent for that thread. The model fingerprint and prompt
version ensure that changing model settings or ranking policy invalidates old results. Persisted
rankings survive server restart and are delivered in the thread/workspace read projection through a
backward-compatible optional field or companion priority projection.

The public server descriptor advertises a named AI-priority capability. Clients never infer support
from version strings, the presence of provider models, or another unrelated capability.

The normal freshness window is the client's configured interval, ten minutes by default. A ranking
older than the interval may still render while a refresh is in flight. It becomes unusable after 24
hours. Once unusable, the thread falls back to Active unless pin or a deterministic urgent state
places it in Focus.

When no ranking input changed and the batch is younger than 24 hours, `ensure current` returns the
cached batch without invoking a model. Once the 24-hour ceiling is reached, the next freshness
request ranks again even if the fingerprint is unchanged. When any eligible input changed, the
server ranks the current candidate set so relative categorical judgment is based on a coherent
snapshot. A batch result is published atomically; clients never render half of a refreshed batch.

Rank cache deletion follows normal thread hard-deletion cleanup. Settlement and archival retain the
cache but exclude the thread from ranking; reactivation invalidates the fingerprint before reuse.

## Shared client runtime

The priority snapshot schema and pure classification logic live in shared packages. The shared
client runtime owns:

- decoding optional ranking projections from mixed-version environments;
- checking the 24-hour usability ceiling against an injected clock;
- combining ranking results with pin and deterministic urgency rules;
- producing Focus, Active, Settled, and Excluded partitions;
- stable ordering and tie-breaking;
- refresh eligibility decisions for foreground clients.

No DOM, React Native, provider adapter, or environment-specific connection logic enters these
modules. Web, desktop, and mobile provide only their foreground lifecycle adapters and render the
same resulting model.

Scoped environment identity remains part of every key. Two environments may contain the same raw
thread ID without sharing priority state. Stale connection generations cannot publish a priority
snapshot or freshness acknowledgement.

## Presentation

When enabled and non-empty, **Focus** appears above **Active**. Focus uses the existing Inbox row
design rather than introducing a visually separate dashboard. A restrained section treatment may
identify AI-assisted entries, but provider, environment, lifecycle, and delivery vocabulary remain
authoritative.

Pinned, approval, input, and failure promotions do not claim to be AI decisions. AI-ranked rows may
show **Why focused?** in the desktop hover details, row context menu, and native touch action sheet.
The explanation includes the broad tier, short reason, model display name, and relative ranking age.
It never exposes a hidden numeric score or raw prompt.

Refreshing does not clear or collapse the existing list. The previous valid batch remains visible
until the replacement is complete, then the new partition is applied atomically. Navigation remains
on the currently open thread even if its row changes section. The feature does not use repeated
shimmering or movement during a request.

When Focus is empty, its heading is omitted and all eligible rows remain in Active. When the selected
model is unavailable, normal Inbox behavior continues and settings expose a quiet status. Automatic
refresh failures do not emit recurring toasts; a user-requested manual refresh reports failure with
the existing liquid-glass notification treatment.

## Failure and mixed-version behavior

- Older environments without ranking capability remain fully usable and keep their threads in the
  normal Inbox.
- A disconnected environment is never reconnected solely for ranking.
- Cached rankings remain usable for at most 24 hours and are visibly explainable as last known.
- Provider failure retains the last valid batch and retries no more frequently than the configured
  interval unless the user explicitly refreshes.
- Invalid model output is recorded as an operational failure without logging thread content.
- A server restart preserves valid cache rows and clears only in-flight ownership.
- Changing the ranking model or prompt-policy version invalidates affected fingerprints.
- Disabling AI Focus stops refresh scheduling and immediately restores the standard Inbox; it does
  not mutate server ranking cache.
- Stale or unauthorized connection generations cannot update ranking state.

## Observability and cost controls

Local structured metrics may record:

- request and cache-hit counts;
- candidates and chunks per request;
- latency and provider/model identifiers;
- valid, partial, invalid, and failed response counts;
- age of the ranking batch currently rendered.

Metrics and logs must not include titles, project names, source-control titles, request excerpts,
reasons, prompts, or model responses. No private operational identifiers are committed to the public
repository.

The ten-minute interval is a default freshness target, not permission to call every ten minutes when
nothing changed. Fingerprint cache hits perform no inference. Requests are serialized per
environment, batch size and excerpts are bounded, and background/disconnected clients do not create
load.

## Testing

### Shared pure-model tests

- Focus and Active form a lossless, duplicate-free partition of active entries.
- Focus entries do not appear in Settled or Excluded.
- All pins are preserved and pins sort before deterministic and AI entries.
- More than five pins remain visible while AI adds no overflow entries.
- Approval, input, and fresh failure rules outrank model output.
- A newer user turn or a failure older than 24 hours removes deterministic failure promotion.
- `now` sorts before `soon`; `later`, `none`, low-confidence, missing, invalid, and expired results do
  not enter Focus.
- Tie-breaking is stable across repeated projections.
- Scoped IDs prevent collisions across at least a five-environment fixture.
- Disabling the setting restores the exact existing Active ordering.
- An injected clock covers the ten-minute default freshness and 24-hour usability ceiling.

### Server tests

- Prompt construction includes only the approved fields and enforces candidate, excerpt, and total
  size bounds.
- Thread content containing ranking instructions remains serialized data and cannot change the
  decoder contract.
- Unknown IDs, duplicate IDs, malformed tiers, and overlong reasons are rejected.
- Model override resolution inherits text generation by default and rejects unavailable instances.
- Fingerprint, model, and prompt-version changes invalidate the cache.
- Unchanged input returns a cache hit without provider invocation.
- Concurrent client requests coalesce into one provider call.
- Multi-chunk results publish atomically.
- Provider failure retains the last valid batch; 24-hour expiry removes it from projection use.
- Restart hydration preserves valid ranking rows.
- Ranking performs no orchestration mutation and never opens a connection.

### Client and presentation tests

- Web browser coverage verifies Focus, Active, and Settled sections with no duplicate rows.
- Hover/context details explain AI priority without replacing authoritative lifecycle status.
- Toggling AI Focus restores normal ordering immediately.
- Manual refresh success and failure use existing notification behavior.
- Foreground lifecycle schedules at the configured interval and does not schedule while backgrounded.
- Native mobile uses pure model tests for partition, action labels, explanations, and foreground
  refresh selection; no React component test is introduced.
- Mixed-version and disconnected environment fixtures preserve last-known threads without mutation
  authority or ranking-driven connection acquisition.

## Acceptance criteria

- With AI Focus enabled, a unified five-environment fixture produces one deterministic Focus section
  and a remaining Active section with no missing or duplicated thread.
- Pinned threads and unresolved approval/input work remain focused regardless of model output.
- Eligible `now` and `soon` entries fill remaining places up to the normal target of five.
- Web, desktop, and native mobile consume the same shared partition rules.
- The default refresh target is ten minutes; unchanged inputs produce no inference call.
- Concurrent refreshes from multiple clients coalesce at the owning environment.
- Rankings never move thread data across environments and never acquire a disconnected environment.
- The settings UI defaults to the existing text-generation model and supports a per-environment
  override.
- A selected model failure leaves the Inbox functional, retains usable last-known ranking for at
  most 24 hours, and then falls back to deterministic Active ordering.
- Captured ranking payload tests prove that no full transcript, file content, diff, terminal/tool
  output, path, credential, secret, or environment variable is sent.
- No ranking path can settle, archive, delete, message, stop, or otherwise mutate a thread.
