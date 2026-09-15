# Pending provider question recovery

Questions use the same serialized callback ownership boundary as
[approval responses](approval-response-policy.md). They extend the existing
`projection_thread_user_input_requests` projection; there is no separate callback
registry or client settlement authority.

A displayed question carries its request activity and runtime session identity.
The writer atomically claims that identity with the response command, and the
provider service checks the runtime again without recovering a lost session.
Reusing a provider request ID cannot route an old answer to a replacement callback.
Exact-command retries return the durable receipt; competing commands cannot send
another answer while delivery is submitting, uncertain, or settled.

A browser reconnect can redisplay a still-live callback and its durable claim.
An arbitrary provider error is not success and does not prove non-delivery: the
question remains uncertain and cannot be resent. A matching provider settlement
or successful response acknowledgement closes it. Cancellation is terminal and
identified separately from submitted answers. Stale outcomes cannot reopen a
settled question or settle a newer callback.

Provider callbacks are process-local. Server restart, lost runtime, or authoritative
turn completion invalidates them with an explanation; it cannot reconstruct their
closures from a transcript. Provider history never restores actionable callbacks.
There is no guessed expiry timeout, timeout-based reclaim, or automatic answer replay.
Users must restart the turn when its callback has been lost.

Migration 056 preserves settled rows and invalidates legacy pending rows without
callback identities. It persists question claims under `(threadId, requestId)`.
Older clients that omit identity must refresh/update before answering. Web and
native use the shared client state and response guard; the server remains the
claim and settlement authority.
