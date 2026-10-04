# 03 · acp-message-ids: ACP assistant message ids collide after a restart (bug 6)

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `acp-message-ids`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| title            | Make ACP assistant item ids unique per runtime, quarantine startup history replay (this also fixes a session/load hang), and stop the message projection from moving a message between threads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| wave             | 1 (parallel, isolated worktree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| verdict          | **confirmed**, with two related defects found on the same path: (a) replayed `session/load` history is re-emitted as turn-less live events and lands on historical messages; (b) a long replay blocks `start()` forever for Cursor and Grok, and for 30 s for registry agents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| size             | M                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| touched files    | `apps/server/src/provider/acp/AcpSessionRuntime.ts` · `apps/server/scripts/acp-mock-agent.ts` · `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts` · `apps/server/src/persistence/Services/ProjectionThreadMessages.ts` (doc comments only) · tests: `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts`, `apps/server/src/provider/Layers/CursorAdapter.test.ts`, `apps/server/src/persistence/Layers/ProjectionThreadMessages.test.ts`, optional `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| migrations       | none. Migrations 071–075 belong to other packages, and this package needs no number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| contract changes | none in `packages/contracts`. `RuntimeItemId` and `MessageId` stay opaque strings. Internal format change: new ACP assistant item ids are `assistant:<sessionId>:runtime:<uuid>:segment:<n>`, so new ACP assistant message ids are `assistant:assistant:<sessionId>:runtime:<uuid>:segment:<n>[...]`. Existing rows keep their old ids. Repository semantics change: `ProjectionThreadMessageRepository.applyEvent` and `.upsert` become a logged no-op when the `message_id` already belongs to a different thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| overlaps         | **queue-hold-drain (W1):** possible same-function overlap in `ProjectionThreadMessages.ts` `applyEvent` (state SELECT and streaming UPDATE) and `upsert`/`upsertProjectionThreadMessageRow`, if it edits `dispatch_mode` handling. This package's edits stay at the head of each function. **delegation-guard-restart (W1, spec 04):** spec 04 lists this package for the `projector.ts` `thread.message-sent` case. That overlap is **resolved**, because this package does not edit `projector.ts`. Shared invariant: `message_id` is a global PK owned by exactly one thread. 04's anchor queries rely on it (04 Step 3), and this package's guard enforces it in SQL. **usage-limits (W2):** semantic only. ACP `UsageUpdated` events during startup are now coalesced to the latest one and emitted right after `start()`. **restart-continuation (W3):** semantic dependency. Resumed ACP sessions no longer surface replayed history, and every runtime mints fresh assistant ids, so continuation must not rely on `session/load` replay. No other W1 package edits `AcpSessionRuntime.ts`, `acp-mock-agent.ts` or `ProjectionThreadMessages.ts` as far as their briefs and specs show. |

---

## Review resolution

| #         | Critique item                                                                                                                                     | Decision                                | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (major) | A long `session/load` replay hangs `start()` (inline handlers + `Queue.bounded(2048)` + drain only after `start`)                                 | **Accepted**                            | Verified by reading the code (§1.5). The startup quarantine is now a hard, load-bearing requirement: no `Queue.offer` and no `ensureActiveAssistantSegment` before `start()` resolves. Startup metadata is coalesced to one event per kind. An `it.live` regression test with a 2500-chunk mock replay must time out on current code. One correction: registry runtimes do have a 30 s start timeout (`AcpRegistrySupport.ts:66-79`), so for them it is a 30 s failure rather than a hang. With `strictResume` that failure means the session cannot be resumed at all.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2 (minor) | The "residual race" and the effect-acp ordering barrier rest on a misreading; narrow the guard                                                    | **Accepted, with a different boundary** | Handlers run inline and in wire order (`protocol.ts:213-220`, `:456`; `client.ts:334-342`, `:359-366`), so there is no residual race and no barrier is needed. The residual-race risk and the effect-acp out-of-scope item are removed. `prompt` stays untouched and provider-compat is dropped from overlaps. The boundary is **"start state is not `Started`"** instead of "the `session/load` request is in flight", because that is the exact invariant that makes dropping safe: `prompt` requires `Started` (`AcpSessionRuntime.ts:578-604`), so nothing before it can belong to a Ryco turn. It needs no new flag; it reuses `startStateRef` and ends deterministically when `start` resolves. It also covers `session/resume` agents that replay against the spec, and it matches t3's startup quarantine (`t3:provider/acp/AcpSessionRuntime.ts:1812-1866`). For `session/new` it is behaviourally the same, because no shipped agent sends transcript output before the first prompt (see Risks). |
| 3 (minor) | Evidence under-describes the corruption: turn-less replay detaches the old message from its turn, and collisions happen at `k+1`, not only at `0` | **Accepted**                            | Added to §1.4. Test 1 asserts that no item events precede the prompt's own events and that the first post-prompt `AssistantItemStarted` ends in `:segment:0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4 (minor) | A skipped foreign write leaves sibling projectors with dangling references                                                                        | **Partially accepted**                  | Documented in Edge cases. The engine-level ownership check is recorded as a tracked follow-up (§9.1), not a footnote. Rejected sub-claim: `materializeAttachmentsForProjection` is a pure pass-through (`ProjectionPipeline.ts:198-201`, `Effect.succeed`) and writes no files. The test does not assert the dangling `projection_turns` reference, because that would cement a known limitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5 (minor) | The focused validation list misses suites                                                                                                         | **Accepted**                            | §6 adds `AcpRegistrySupport.test.ts`, `XAiAcpExtension.test.ts`, the Grok and registry adapter suites, and every suite that builds the real message projection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6 (minor) | The Overlaps section is inaccurate                                                                                                                | **Accepted**                            | 04 is named and resolved, the shared invariant is stated, queue-hold-drain is flagged at function level, and provider-compat is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Verdict check: the reviewer agreed the bug is **confirmed**. I re-verified every link (§1) and the per-provider survey (§1.6). The only disputed mechanics were the replay ordering and the hang, both resolved in item 2 and item 1.

---

## 1. Problem (verified against the code)

### 1.1 The item id restarts with every runtime

- `AcpSessionRuntime.ts:172` creates `assistantSegmentRef` as `Ref.make({ nextSegmentIndex: 0 })` inside `makeAcpSessionRuntime`, so every runtime starts at 0.
- `:780-781` builds the item id as `assistant:${sessionId}:segment:${segmentIndex}`.
- `:783-817` (`ensureActiveAssistantSegment`) allocates the next index when a `ContentDelta` arrives with no open segment.

### 1.2 The same ACP session id is reused

- `startOnce` (`:432-522`): when `options.resumeSessionId` is set (`:473`), it issues `session/load`, or `session/resume` under `strictResume` when the agent advertises it (`:474-495`). On success it sets `sessionId = options.resumeSessionId` (`:498`).
- **Cursor** (`CursorAcpSupport.ts`, used by `CursorAdapter.ts:571`) and **Grok** (`GrokAcpSupport.ts`, used by `GrokAdapter.ts` → `AcpAdapter.ts`) never set `strictResume`, so they **always use `session/load`**.
- **Registry agents** (`AcpRegistrySupport.ts:54`, `strictResume: true`) use `session/resume` when it is advertised, otherwise `session/load`.

### 1.3 Every restart creates a new runtime with the old session id

- **After a server restart.** `ProviderCommandReactor.ensureSessionForThread` finds no live adapter session and calls `startProviderSession(undefined)`. `ProviderService.startSession` then falls back to the persisted binding's resume cursor (`ProviderService.ts:970-975`) with a fresh `runtimeSessionId` (`:946-948`).
- **In-process restarts.** `ProviderCommandReactor.ts:681-745` restarts with `activeSession.resumeCursor` when runtime mode, token mode, cwd, instance or the computer catalog changes.
- **Recovery path.** `ProviderService.recoverSessionForThread` (`:701-790`) resumes from the binding and **reuses `binding.runtimeSessionId`** (`:714-716`), for example after `ProviderSessionReaper` stops an idle session.

### 1.4 Ingestion and projection merge the new reply into an old message

- **Ingestion.** It maps item ids to message ids: segment 0 of a turn becomes `assistant:<itemId>` (`ProviderRuntimeIngestion.ts:389-397`, `:1312-1335`). Turn-less deltas always become `assistant:<itemId>` (`:1318-1320`). Completions use `assistant:${itemId}` (`:2663-2670`).
- **In-memory projector.** For an id that already exists in the same thread, `projector.ts:672-690` appends streaming text and **overwrites `turnId`** (`:685`).
- **SQL projection.** `applyEvent` (`ProjectionThreadMessages.ts:187-245`) moves the settled body into chunk 0 (`:216-221`) and rewrites `thread_id` and `turn_id` (`:224-231`). It then appends the new chunk (`:233-235`). Appending to a completed message is designed behaviour, covered by the "resumed" case in `ProjectionThreadMessages.test.ts`, migration 060.
- **SQL upsert.** `upsertProjectionThreadMessageRow` sets `thread_id = excluded.thread_id` on conflict (`:90-92`). `upsert` then deletes the row's chunks (`:170`).

**Consequences**

- **`session/resume`, no replay (registry).** The first reply after every restart gets `…:segment:0`, which is the id of the first reply ever sent in the session. The new text is appended to the oldest assistant message near the top of the thread. The new turn appears to have no reply, and the old message's `turn_id` now points to the new turn. A later revert keeps the merged text through the old turn's `projection_turns.assistant_message_id` (`ProjectionPipeline.ts:329-341`). After each further restart, every reply overwrites the history again.
- **`session/load` with replay (Cursor, Grok, load-only registry agents).** The runtime processes the replay through `handleSessionUpdate` (`:675-743`):
  - The replay consumes segment indices 0..k, so the new reply takes `k+1`. That collides whenever the live history had more segments than the replay reproduces, for example thought or tool-call boundaries the replay omits.
  - The replayed `ContentDelta`s are queued. The adapter drains them after `start()` with `turnId: ctx.activeTurnId === undefined` (`AcpAdapter.ts:717-730`, `CursorAdapter.ts:926+`).
  - On the recovery path the events carry the thread's current runtime id, so ingestion's stale filter (`ProviderRuntimeIngestion.ts:2245-2272`) lets them through. On the other paths that is a race between ingestion and `bindSessionToThread` → `thread.session.set`.
  - Accepted turn-less deltas map onto live segment _j_. Each historical assistant message gets duplicate text, and its `turn_id` is set to **null** (`projector.ts:685`; SQL `:225`), which detaches it from its turn.

### 1.5 A long replay hangs session start

- **Handlers run inline.** effect-acp runs session/update handlers inline in the stdin read loop. `protocol.ts:413-457` is a `Stream.runForEach` over frames with a sequential `Effect.forEach(messages, routeDecodedMessage)` (`:456`). `dispatchNotification` (`:213-220`) calls `client.ts` `dispatchNotification` (`:359-366`), which calls `runNotificationHandlers` (`:334-342`). None of them has a timeout.
- **The offer can block.** `handleSessionUpdate` calls `Queue.offer` on `Queue.bounded(2_048)` (`AcpSessionRuntime.ts:169`), and `ensureActiveAssistantSegment` also offers. When the queue is full, the offer suspends.
- **Nothing drains the queue during start.** Draining starts only after `acp.start()` returns (`AcpAdapter.ts:656`, `CursorAdapter.ts:850`). The ACP spec requires the agent to replay the whole transcript _before_ it answers `session/load`.
- **Result.** Once a replay produces more than about 2048 parsed events (one per `agent_message_chunk`, plus item and tool events), the read loop blocks and the load response is never routed:
  - **Cursor and Grok** hang forever. There is no timeout in `CursorAdapter`, `AcpAdapter` or `ProviderService.withProviderStartupAdmission` (`:377-417`), and the hung start keeps a per-instance startup-admission permit and the thread's session-start lock.
  - **Registry runtimes** fail after 30 s (`AcpRegistrySupport.ts:66-79`). With `strictResume`, that means a long-history session can never be resumed.

### 1.6 Scope survey: the problem is ACP-only

- **ACP runtimes** cover Cursor, Grok and registry agents, which all share `AcpSessionRuntime`.
- **Other adapters do not have per-runtime counters:**
  - Claude uses `randomUUID` item ids (`ClaudeAdapter.ts:1866`).
  - Copilot uses SDK `messageId`s (`CopilotAdapter.mapEvent.ts:141`).
  - OpenCode uses its own part ids (`OpenCodeAdapter.ts:1355`).
  - Codex uses its provider item ids.
- **The only `:segment:` parser** is Codex-only `providerHistoryRecovery.ts:48`.
- **Text-generation runtimes** (`CursorTextGeneration.ts:93`, `GrokTextGeneration.ts:96`) use `session/new` and never feed threads.

### 1.7 Cross-thread moves are possible but hypothetical today

- Clients mint random UUID message ids (`apps/web/src/lib/utils.ts:41`, `apps/mobile/src/lib/ids.ts:8`).
- The server's deterministic ids are scoped by session, turn, operation or child thread (`attachmentTools.ts:99-102`, `CompletionReturnDelivery.ts:347`, `SessionImport.ts:987`).
- The upsert's `thread_id = excluded.thread_id` still lets any future collision silently move, and corrupt, another thread's message. The guard is defence in depth for the global-PK invariant that spec 04 relies on.

---

## 2. Approach

1. **Runtime-scoped ids.** Each `makeAcpSessionRuntime` mints one `assistantItemRuntimeId = crypto.randomUUID()`. Item ids become `assistant:<sessionId>:runtime:<uuid>:segment:<n>`. This is the scheme t3 uses (`t3:provider/acp/AcpSessionRuntime.ts:1396`, `:2967-2968`). Ids stay stable within a runtime, so segmentation and ingestion are unchanged, and they cannot collide across runtimes or with legacy ids, because legacy ids have no `:runtime:` part.
2. **Startup quarantine (hard requirement).** While the start state is not `Started`, `handleSessionUpdate`:
   - **never offers to `eventQueue`**;
   - **never touches `assistantSegmentRef` or `toolCallsRef`**;
   - drops transcript-shaped events (`ContentDelta`, `ThoughtDelta`, `ToolCallUpdated`, `PlanUpdated`);
   - keeps only the **latest** `CommandsUpdated`, `ModeChanged` and `UsageUpdated` in a bounded startup buffer (at most 3 events).

   The buffer is flushed into the queue atomically with the transition to `Started`. A one-permit semaphore serialises handler execution and that transition, so a live update can never overtake older buffered metadata. Because the quarantine path never offers, a replay of any length cannot block the read loop, which fixes §1.5.

3. **Ownership guard in the message repository.** `applyEvent` and `upsert` read the existing row's `thread_id` inside their transaction:
   - **If the row belongs to another thread:** they write nothing, delete no chunks, do not bump `text_event_sequence`, and log `projection.thread-message.foreign-thread-write-skipped`.
   - **Same-thread appends keep today's semantics**, because appending after completion is designed behaviour. They only get a log-only diagnostic when a completed message with a non-null turn receives a streaming delta from a different non-null turn.
   - **Ids are not minted at projection time.** Projections must stay a pure function of the event log, and every downstream reference (turn `assistant_message_id`, completion commands, client deltas) uses the event's id. Uniqueness belongs at the source (step 1). Rejection belongs in the engine (follow-up §9.1).

---

## 3. Step-by-step changes

### 3.1 `apps/server/src/provider/acp/AcpSessionRuntime.ts`

1. **Types and helpers** (module level, next to `AcpAssistantSegmentState`):

   ```ts
   type AcpStartupMetadataEvent = Extract<
     AcpParsedSessionEvent,
     { readonly _tag: "CommandsUpdated" | "ModeChanged" | "UsageUpdated" }
   >;

   const isStartupMetadataEvent = (
     event: AcpParsedSessionEvent,
   ): event is AcpStartupMetadataEvent =>
     event._tag === "CommandsUpdated" ||
     event._tag === "ModeChanged" ||
     event._tag === "UsageUpdated";

   /** Latest event per tag, ordered by latest arrival. Bounded to 3 entries. */
   const coalesceStartupMetadata = (
     current: ReadonlyArray<AcpStartupMetadataEvent>,
     next: AcpStartupMetadataEvent,
   ): ReadonlyArray<AcpStartupMetadataEvent> => [
     ...current.filter((event) => event._tag !== next._tag),
     next,
   ];
   ```

2. **New state in `makeAcpSessionRuntime`**, next to `:169-174`:

   ```ts
   // One id per runtime: the ACP session id is reused across resumes, so a
   // per-runtime segment counter alone would re-mint ids already in history.
   const assistantItemRuntimeId = yield * Effect.sync(() => crypto.randomUUID());
   const startupMetadataRef = yield * Ref.make<ReadonlyArray<AcpStartupMetadataEvent>>([]);
   // Serialises session/update handling with the Starting -> Started transition so
   // flushed startup metadata is always queued before any live update.
   const sessionUpdateLock = yield * Semaphore.make(1);
   const isStarted = Ref.get(startStateRef).pipe(Effect.map((state) => state._tag === "Started"));
   ```

   Import `Semaphore` from `effect` (or `effect/Semaphore`, as `AcpAdapter.ts:28` does).

3. **Handler registration** (`:253-262`). Wrap the call in `sessionUpdateLock.withPermit(...)` and pass `assistantItemRuntimeId`, `isStarted` and `startupMetadataRef` to `handleSessionUpdate`.

4. **`start` transition** (`:535-550`, `NotStarted` branch). Replace the plain `Ref.set(startStateRef, { _tag: "Started", result })` with:

   ```ts
   Effect.tap((result) =>
     sessionUpdateLock
       .withPermit(
         Ref.set(startStateRef, { _tag: "Started", result }).pipe(
           Effect.andThen(Ref.getAndSet(startupMetadataRef, [])),
           Effect.flatMap((metadata) =>
             Effect.forEach(metadata, (event) => Queue.offer(eventQueue, event), { discard: true }),
           ),
         ),
       )
       .pipe(Effect.andThen(Deferred.succeed(deferred, result))),
   ),
   ```

   In the existing `Effect.onError` branch, also `Ref.set(startupMetadataRef, [])`. Do not change `startOnce` or `prompt`.

   **Deadlock note:** the flush offers at most 3 events into a queue that is empty, because the quarantine never offers. After `Started`, a handler may block on a full queue while holding the permit. That is safe only because the transition is the sole other permit taker and runs once, before. Add a code comment forbidding new permit users that run after start.

5. **`handleSessionUpdate`** (`:675-743`). Add the parameters `assistantItemRuntimeId: string`, `isStarted: Effect.Effect<boolean>` and `startupMetadataRef`. After the existing `parsed.modeId` block, which is a no-op during start because `modeStateRef` is undefined until `startOnce` sets it at `:512`, insert:

   ```ts
   if (!(yield * isStarted)) {
     // Startup quarantine. `prompt` requires Started, so nothing that arrives before
     // start() resolves belongs to a Ryco turn: it is session/load history replay or
     // setup noise. HARD REQUIREMENT: never Queue.offer here and never touch segment
     // or tool-call state. The adapter drains `eventQueue` only after start() returns,
     // and effect-acp runs this handler inline in the stdin read loop, so a blocking
     // offer would stall the session/load response (unbounded replay => hung start).
     const metadata = parsed.events.filter(isStartupMetadataEvent);
     if (metadata.length > 0) {
       yield *
         Ref.update(startupMetadataRef, (current) =>
           metadata.reduce(coalesceStartupMetadata, current),
         );
     }
     return;
   }
   ```

   The rest of the loop is unchanged, except that `ensureActiveAssistantSegment` now receives `runtimeId: assistantItemRuntimeId`.

6. **`assistantItemId` and `ensureActiveAssistantSegment`** (`:780-817`):

   ```ts
   const assistantItemId = (sessionId: string, runtimeId: string, segmentIndex: number) =>
     `assistant:${sessionId}:runtime:${runtimeId}:segment:${segmentIndex}`;
   ```

   Thread `runtimeId` through `ensureActiveAssistantSegment`'s input. `closeActiveAssistantSegment` is unchanged.

### 3.2 `apps/server/scripts/acp-mock-agent.ts` (test fixture)

Add `const replayHistoryChunks = Number(readEnv("RYCO_ACP_REPLAY_HISTORY_CHUNKS") ?? "0");`. Turn the `handleLoadSession` handler (`:317-332`) into an `Effect.gen`. After the existing `user_message_chunk` replay:

- **Chunks.** For `index` in `0..replayHistoryChunks-1`, emit `agent_message_chunk` with text `` `replayed ${index} ` ``.
- **Tool calls.** Every 500 chunks (`index > 0 && index % 500 === 0`), first emit a completed `tool_call` / `tool_call_update` pair with ids `replay-tool-${index}`. Copy the shape from the `emitToolCalls` branch (`:509+`).
- **Usage.** When `index % 250 === 249`, emit `usage_update` with `used: index + 1, size: 128_000`.
- **Commands.** When `replayHistoryChunks > 0`, finish with one `available_commands_update` (`[{ name: "replayed-command", description: "from replay" }]`).

Then return the existing load response. With the flag unset, behaviour is identical to today.

### 3.3 `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`

1. **`applyEvent`** (`:187-245`). Extend the state SELECT (`:191-194`) to:

   ```sql
   SELECT thread_id AS "threadId", turn_id AS "turnId", is_streaming AS "isStreaming",
          text_event_sequence AS sequence, created_at AS "createdAt"
   FROM projection_thread_messages WHERE message_id = ${row.messageId}
   ```

   This is the same PK lookup with no extra query. **Before** the stale check at `:196`:

   ```ts
   if (state !== undefined && state.threadId !== row.threadId) {
     yield *
       Effect.logWarning("projection.thread-message.foreign-thread-write-skipped", {
         messageId: row.messageId,
         ownerThreadId: state.threadId,
         eventThreadId: row.threadId,
         sequence,
       });
     return; // no metadata write, no chunk insert/delete, no text_event_sequence bump
   }
   ```

   After the stale check, add the log-only diagnostic. It must not change behaviour:

   ```ts
   if (
     row.isStreaming &&
     state !== undefined &&
     state.isStreaming === 0 &&
     state.turnId !== null &&
     row.turnId !== null &&
     state.turnId !== row.turnId
   ) {
     yield *
       Effect.logWarning("projection.thread-message.cross-turn-append", {
         messageId: row.messageId,
         threadId: row.threadId,
         previousTurnId: state.turnId,
         turnId: row.turnId,
         sequence,
       });
   }
   ```

   Keep every other statement as it is. That limits the textual overlap with queue-hold-drain.

2. **`upsert`** (`:165-184`). Inside the transaction, run first:

   ```sql
   SELECT thread_id AS "threadId" FROM projection_thread_messages WHERE message_id = ${row.messageId}
   ```

   If the row exists with a different thread id, log the same `foreign-thread-write-skipped` warning (with `sequence: options?.eventSequence`) and return without upserting, deleting chunks or updating the sequence. Otherwise proceed as today.

3. Leave the `ON CONFLICT … thread_id = excluded.thread_id` SQL text as is. Within the guarded transaction it can only rewrite the same value. Not editing it avoids a conflict with queue-hold-drain. Add a comment at `:92` that ownership is enforced by the callers' guard.

### 3.4 `apps/server/src/persistence/Services/ProjectionThreadMessages.ts`

Update the doc comments on `applyEvent` and `upsert`: "A `message_id` is owned by the first thread that projected it; writes from another thread are skipped and logged." No type changes.

---

## 4. Contract / migration changes

- **Contracts:** none. `MessageId` and `RuntimeItemId` are `TrimmedNonEmptyString` brands with no length limit (`packages/contracts/src/baseSchemas.ts:15-47`). New ids are about 45 characters longer. Derived command ids (`providerCommandId(…, messageId)`) grow the same way.
- **Persisted data:** no migration. Legacy ACP rows keep `assistant:assistant:<sid>:segment:<n>` and stay readable. New rows use the `:runtime:` form. Rows that are already merged or corrupted are **not** repaired; see §9.2.
- **Clients:** no client parses assistant ids. I checked `apps/web`, `apps/mobile`, `packages/client-runtime` and `packages/shared`.

---

## 5. Tests (failing-first)

All runtime tests spawn the bun mock agent, as the existing suite does.

1. **`AcpJsonRpcConnection.test.ts`: "quarantines session/load history replay without blocking start" (`it.live`).**
   - **Setup:** layer with `resumeSessionId: "mock-session-1"` and `env: { RYCO_ACP_REPLAY_HISTORY_CHUNKS: "2500" }`.
   - **Start:** `runtime.start().pipe(Effect.timeout("10 seconds"))` must resolve, with `sessionId === "mock-session-1"`. **Fails on current code by timeout** (§1.5).
   - **Prompt:** `prompt("hi")`, then `Stream.take(runtime.getEvents(), 6)` with a 5 s timeout.
   - **Assert:**
     - The first two events are exactly `{CommandsUpdated, UsageUpdated}` in any order, one each. `UsageUpdated.usage.usedTokens === 2500` (coalesced to the latest).
     - Events 3–6 are `["PlanUpdated", "AssistantItemStarted", "ContentDelta", "AssistantItemCompleted"]`, so no replayed `ToolCallUpdated`, `ContentDelta` or `AssistantItem*` precedes the prompt.
     - The `AssistantItemStarted.itemId` matches `/^assistant:mock-session-1:runtime:[0-9a-f-]{36}:segment:0$/`, which proves the replay consumed no segment indices.
2. **`AcpJsonRpcConnection.test.ts`: "mints distinct assistant item ids for each runtime of the same session" (`it.effect`).**
   - **Setup:** a helper builds a scoped runtime, starts it, prompts it, and returns the first `AssistantItemStarted.itemId`. Run it twice:
     - runtime A uses `session/new` (the mock always returns `mock-session-1`);
     - runtime B uses `resumeSessionId: "mock-session-1"`, which goes through `session/load`.
   - **Assert:** both match the runtime-format regex and end in `:segment:0`, and `idA !== idB`. **Fails on current code**: both are `assistant:mock-session-1:segment:0`.
3. **`AcpJsonRpcConnection.test.ts`, existing "segments assistant text around ACP tool calls".** Strengthen it: both ids share the same `assistant:mock-session-1:runtime:<uuid>:` prefix and end in `:segment:0` and `:segment:1`.
4. **`CursorAdapter.test.ts`.**
   - **Update the literal ids** at `:212` and `:714` to the regex `/^assistant:mock-session-1:runtime:[0-9a-f-]{36}:segment:0$/`.
   - **Add "a resumed Cursor session does not re-emit replayed history and mints fresh assistant ids":**
     - Use a wrapper with `RYCO_ACP_REPLAY_HISTORY_CHUNKS: "3"`.
     - Start a session, `sendTurn`, and record the assistant `item.started` id A. Then `stopSession`.
     - `startSession` again with `resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" }`, `sendTurn`, and collect events through `turn.completed`.
     - **Assert:** no `content.delta`, no assistant-message `item.started`/`item.completed`, and no `item.*` events of the replayed tool calls occur before that session's `turn.started`. Every `content.delta` has the turn's `turnId`. The assistant item id B matches the format and differs from A.
     - **Fails on current code:** the three replayed chunks surface as a turn-less `content.delta` before `turn.started`.
5. **`ProjectionThreadMessages.test.ts`, new `layer("message ownership", …)`.**
   - **(a) Foreign streaming delta.** Thread A applies `M` streaming `"a"` (seq 1), then final (seq 2). Thread B applies `M` streaming `" b"` (seq 3).
     - **Assert:** `getByMessageId(M)` still has `threadId = A`, text `"a"`, and `isStreaming = false`. `listByThreadId(B)` is empty. The chunk count for `M` is unchanged (0). `text_event_sequence` is still 2.
     - **Fails on current code:** the row moves to B with text `"a b"`.
   - **(b) Foreign final.** Thread B applies `M` non-streaming `"replacement"`. Same assertions.
   - **(c) Foreign upsert.** `M` is owned by A and has live chunks: A applies two streaming deltas. Then `upsert({ ...M, threadId: B, text: "x" })`.
     - **Assert:** A's assembled text is intact, the chunks still exist, and B has no row.
     - **Fails on current code:** the row moves and the chunks are deleted.
   - **(d) Owner still writes after a skip.** After (a), A applies `M` streaming `" more"` at seq 4, which appends.
   - **(e) Cross-turn diagnostic is log-only.** Same thread: final with `turnId = T1`, then streaming with `turnId = T2`. The text is appended and `turnId` becomes T2, exactly as today.
6. **Optional, `ProjectionPipeline.test.ts`.** Two `thread.created` events (A, B), then `thread.message-sent` for A with id `M`, then for B with id `M`. `projection_thread_messages` keeps `M` in A with A's text. Do not assert B's `projection_turns.assistant_message_id`; it is a documented limitation (§7).

---

## 6. Focused validation

```sh
bun run --cwd apps/server test \
  src/provider/acp/AcpJsonRpcConnection.test.ts \
  src/provider/acp/AcpRegistrySupport.test.ts \
  src/provider/acp/XAiAcpExtension.test.ts \
  src/provider/acp/AcpCoreRuntimeEvents.test.ts \
  src/provider/Layers/CursorAdapter.test.ts \
  src/provider/Layers/GrokAdapter.test.ts \
  src/provider/Drivers/AcpRegistryDriver.test.ts \
  src/persistence/Layers/ProjectionThreadMessages.test.ts \
  src/persistence/Migrations/060_ProjectionMessageChunks.test.ts \
  src/orchestration/Layers/ProjectionPipeline.test.ts \
  src/orchestration/Layers/ProjectionPipeline.chunks.test.ts \
  src/orchestration/Layers/ProjectionPipeline.worktrees.test.ts \
  src/orchestration/Layers/ProviderRuntimeIngestion.test.ts \
  src/orchestration/Layers/OrchestrationEngine.test.ts \
  src/orchestration/Layers/CheckpointReactor.test.ts \
  src/orchestration/Layers/ProviderCommandReactor.test.ts
bun typecheck   # or the server package's typecheck only; trust the exit code
```

The suites that build the real message projection (`ProjectionThreadMessageRepositoryLive` / `ProjectionPipelineLive`) are listed so that any fixture reusing a message id across threads surfaces. With the guard, such a fixture would lose rows silently instead of failing. A quick scan found no cross-thread reuse. If a suite fails on a missing row, check for the new `foreign-thread-write-skipped` warning first. Never run `bun test`.

---

## 7. Edge cases

- **Legacy rows.** Old-format ids never collide with new ones, because new ids contain `:runtime:` right after the session id.
- **Within one runtime** segment indices still increase across prompts (`assistantSegmentRef` is not reset per prompt), so ids are unique per runtime and therefore globally.
- **Notifications before `start()` resolves:**
  - **Transcript-shaped output during `session/new`** (initialize, auth or new) is dropped. No prompt can be in flight, so it cannot belong to a turn.
  - **`current_mode_update`** still updates `modeStateRef` exactly as today. During startup that is a no-op until `startOnce` sets the setup-derived mode.
  - **`config_option_update`** is still not parsed. That is unchanged.
- **Failed start.** The state returns to `NotStarted` and the metadata buffer is cleared. The quarantine stays on until a later successful start, which is correct.
- **Failed `session/load` that falls back to `session/new`** (non-strict). All replay notifications of the failed load were processed, and quarantined, before its error frame was routed, because dispatch is inline and in wire order. The fallback is still inside startup.
- **Text-generation runtimes** (`CursorTextGeneration`, `GrokTextGeneration`) register their own raw `handleSessionUpdate` handler, which the internal quarantine does not affect. Their item ids change format, but they never surface.
- **Foreign-thread writes:**
  - **In memory vs SQL.** The in-memory projector is per-thread (`projector.ts:672`), so thread B still shows the message live while SQL skips it. After a restart B loses that message. This is strictly better than today, where A loses its message and B shows A's text plus B's.
  - **Sibling projectors still apply the event.** The thread shell (`ProjectionPipeline.ts:1017-1032`) bumps `latestUserMessageAt` for user-role events only. The turns projector (`:1797-1840`) sets B's turn `assistant_message_id` to the foreign id and may mark it completed. That reference dangles harmlessly: B's revert uses `listByThreadId(B)`, which excludes the foreign row. No attachment files are involved (`materializeAttachmentsForProjection` is a pass-through, `:198-201`).
  - **Rebuilds are deterministic.** A projector rebuild from the event log reaches the same decision, because ownership is the thread of the first projecting event.
  - **Soft-deleted threads keep their messages** (`ProjectionPipeline.chunks.test.ts:250-258`), so their ids stay owned. `thread.created` for an existing id clears that thread's rows first (`:1345-1348`).
- **Revert path.** `upsert` is fed only by `listByThreadId(threadId)` rows (`ProjectionPipeline.ts:1379-1406`), so the guard never fires there.

---

## 8. Risks

1. **Notifications arriving after the setup response but before `Started`** are quarantined. The window is the tail of `startOnce` (two `Ref.set`s) plus the permit acquisition, about microseconds. Such a notification cannot be part of a prompt. The only conceivable loss is agent-initiated output at exactly that moment, and no shipped agent is known to send any.
2. **Behaviour change.** Agent output that is not metadata and is emitted before the first prompt (for example a greeting during `session/new`) is no longer surfaced as a turn-less assistant message. This matches t3.
3. **The semaphore ordering is fragile against future edits.** Any new permit user that runs after start, while the queue can be full, could deadlock with a blocked handler. A code comment is required (§3.1 step 4).
4. **The hang fix depends on the invariant "no offers before `Started`".** Reintroducing an offer on the startup path reintroduces the hang. Test 1 guards it.
5. **A foreign-write skip loses a message in SQL.** That is logged at warn level. The engine-level rejection (§9.1) is the real fix.
6. **Hot path.** `applyEvent` runs per streamed delta. The change adds three columns to the existing PK lookup and one branch, with no extra statement. `upsert` (revert path only) gains one PK lookup.
7. **Merge conflicts with queue-hold-drain** in `applyEvent` and `upsert`. Edits are confined to the head of each function.

---

## 9. Out of scope / tracked follow-ups

1. **Engine-level message ownership (tracked follow-up).** The decider should reject `thread.message.assistant.delta` / `.complete` and `thread.turn.start` whose `messageId` belongs to another thread. That would also remove the sibling-projector dangling references in §7.
   - It needs an id → thread index or a projection lookup, because the command read model holds only anchor messages after a restart (spec 04 §1).
   - Scanning `readModel.threads[*].messages` per delta is too slow for the hot path.
2. **Repairing already-corrupted rows.** Merged texts and nulled `turn_id`s cannot be split back reliably. That needs a user-facing decision.
3. **ACP history recovery from `session/load` replay**, analogous to Codex `providerHistoryRecovery`. The quarantine discards the replay. Recovering lost output would need a replay → message mapping.
4. **Text-generation runtimes never drain `eventQueue`** (`CursorTextGeneration.ts:93-131`, `GrokTextGeneration.ts:96+`). More than about 2047 parsed events in one generation block the read loop until `CURSOR_TIMEOUT_MS` (180 s). This is a separate fix, for example a runtime option that disables event queueing.
5. **Thread-namespacing ingestion's assistant message ids.** This is rejected for now: it would change Codex history-recovery matching (`providerHistoryRecovery.ts:48`).
6. **A start timeout for Cursor and Grok `session/load`.** t3 uses `sessionLoadTimeout` plus a replay idle gap. This is no longer needed for the hang fixed here, but it remains a robustness gap for agents that never answer.
