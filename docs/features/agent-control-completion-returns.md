# Delegated completion returns

Private provider-session callers can set `returnToOrigin: true` on an entry in
`ryco_create_threads`. The default is false. Existing proposal authorization,
project scope, worktree isolation and runtime privilege checks still apply. The
option grants no approval capability and cannot be used by external integrations
or scheduled automation owners.

A completed control-request receipt still means **dispatch completed**, not that
an agent task finished. `ryco_read_control_request` exposes a separate
`receipt.completionReturns` array. The Agent Control proposal card shows the same
status, child/origin links and recovery guidance; native cards show the same shared
status and navigation actions. Expand the proposal to review the return opt-in.

Each return binds to the exact originating thread, project, provider instance,
runtime epoch and turn, plus the child's initial user-message identity. Ingestion
acknowledges only an accepted terminal event after buffered output and activities
have been finalized. A completed assistant message or checkpoint is insufficient.
Known background work, including monitoring, delays capture. The canonical final
assistant message is bounded to 8,000 UTF-16 code units, JSON escaped and clearly
labelled as untrusted child output. Links open the child and originating chat in
the environment currently being viewed. Attachments and credentials are not copied.

Results use **queue** semantics: wait for the parent to finish, then start a normal
turn through the existing command application. They never automatically steer an
active turn. An atomic identity/message fence prevents a concurrently started
user turn, changed model, scope or runtime from being overwritten. Delivery also
requires the original live provider session; its expected epoch is carried through
the accepted event to provider submission with runtime recovery disabled. A stale
idle projection cannot restart or target a replacement runtime. Sibling
results may continue through a turn proven to originate from another accepted
return to the same exact origin, including after restart. Arbitrary later turns
and goals do not become return targets. A frozen result always describes the
initial child run, never a later child run or goal completion.

## Status and recovery

- `waiting`: initial run/output/background work has not settled.
- `ready`: bounded initial result saved; waiting for the exact parent or a proven
  sibling-return continuation to become idle.
- `dispatching`: the frozen command has been durably claimed.
- `delivered`: the engine accepted the queued result. This is **not** proof of
  provider processing or exactly-once task execution.
- `uncertain`: dispatch may have happened, but no confirming receipt was found.
  Check the parent before manually sending a result. There is no blind resend.
- `blocked`: origin changed, was archived/deleted, or Agent Control was disabled.
  Open the child and decide whether to send its result manually.
- `cancelled`: dispatch or parent/child run was cancelled, stopped or archived.
- `failed`: safe completion could not be established (including expiry after
  24 hours). Inspect the child; no future child turn is substituted.

Transient read/storage failures are retried in bounded batches. Deterministic
command receipts resolve restart/ambiguous dispatch when available. A crash after
claim but before submission without a receipt remains uncertain; it is deliberately
not described as exactly-once delivery. Pending background work survives restart
as pending: a fresh empty in-memory registry cannot erase it. If no authoritative
settlement arrives, the return expires with manual recovery guidance. Corrupt
ledger rows are quarantined so other returns can proceed; restore a damaged local
database from backup or inspect the affected tasks manually.

Migration **063** adds the return ledger. Provider deltas do not query it; only
terminal/background lifecycle transitions observe ownership. Existing contracts
remain compatible through optional fields. No provider-specific send path, hosted
authority policy, or web phone presentation policy is added.

## References

Reviewed Synara [v0.9.0](https://github.com/Emanuele-web04/synara/tree/v0.9.0/apps/server/src/agentGateway)
and [v0.9.2](https://github.com/Emanuele-web04/synara/tree/v0.9.2/apps/server/src/agentGateway)
completion delivery/repository and [changelog](https://www.trysynara.com/changelog).
This implementation is original; no upstream source was copied. Ryco lacks
Synara's durable provider-event acknowledgement table, so it writes its own
post-ingestion acknowledgement instead of assuming equivalent projections.
The current [official Codex app-server documentation](https://developers.openai.com/codex/app-server/)
distinguishes turn completion from item completion. This feature uses Ryco's
shared normalized lifecycle across providers and does not call new provider APIs.
