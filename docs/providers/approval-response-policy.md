# Approval response ownership

Approval responses are owned by server orchestration. The client guard prevents
same-render reentrancy; it is not an authorization, retry, or settlement authority.

## Identity and durable claim

`ApprovalResponseIdentity` identifies the request activity and its runtime session.
New callbacks require a live, non-stopped session with a nonempty runtime identity.
The source runtime is preserved and checked again by the serialized writer, after
provider ingestion, so a queued old callback cannot bind to a new session.

The pending-approval repository is keyed by `(threadId, requestId)`. Its identity,
response attempt (command ID), submitted decision, and response state are persisted
with the orchestration event in one SQLite transaction. `requireApprovalClaim` runs
inside that transaction. Exact-command retries return the existing command receipt;
a different command cannot claim a submitting, uncertain, or settled callback.
Claims survive database close/reopen. There is no timeout-based reclaim or automatic
replay after an unknown outcome.

A claim leaves the approval pending. A successful provider response or a matching
provider settlement resolves it. The first authoritative settlement wins, including
when the provider reports a different decision before a local acknowledgement.
A stale callback is invalidated with no approval decision fabricated.

## Retry

An arbitrary provider error leaves the attempt `uncertain`. Only an adapter error
explicitly carrying `approvalResponseNotSent: true` permits `retryable` state. An
adapter may set that flag only when it can prove no decision was sent. Late outcomes
must match both callback identity and response attempt. They cannot reopen a settled
callback or affect a later attempt.

## Provider request ID reuse

A provider may reuse an ID after its previous callback has settled, using a distinct
request activity ID. That produces a new approval identity. Two simultaneous pending
callbacks with the same provider ID within one runtime are unsupported and rejected
explicitly: the provider response API could not distinguish them.

After same-runtime ID reuse, unqualified provider settlement is ambiguous and is
rejected. A settlement must identify the callback; local response acknowledgements
carry both callback and attempt identity. A late qualified settlement can complete
a stopped runtime, but cannot cross into a newer runtime. Duplicate source request
activities and settlements cannot reopen or overwrite the current callback.

## Lifecycle integration boundary

`apps/server/src/orchestration/approvalResponses.ts` owns `requireApprovalClaim`,
`requireApprovalSource`, `sameApprovalIdentity`, and `matchesApprovalAttempt`.
Lifecycle recovery must use this boundary and the existing orchestration writer,
not a separate response registry or retry policy.

To invalidate a callback, dispatch the existing internal `thread.activity.append`
command with kind `provider.approval.respond.failed`, the exact `requestId`,
`approvalIdentity`, current `responseAttemptId` (when claimed), and
`responseState: "invalidated"`. Include an honest stale-callback explanation.
The writer and projection reject stale attempts and protect terminal settlement.
Session recovery must never recreate provider callbacks merely to answer them.

Migration 055 invalidates pre-identity pending callbacks, preserves previously
settled decisions, updates shell counts, and records an explanatory failure activity.
Users must restart those turns; the migration does not claim they approved anything.
Older clients that omit callback identity must refresh/update before answering.
