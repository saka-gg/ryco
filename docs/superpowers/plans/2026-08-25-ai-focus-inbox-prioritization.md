# AI Focus Inbox Prioritization Implementation Plan

> Source of truth: `docs/superpowers/specs/2026-08-25-ai-focus-inbox-prioritization-design.md`

## Objective

Implement the optional AI-assisted Focus partition across server, shared client runtime, web,
desktop, and native mobile. The feature must preserve deterministic Inbox behavior, keep ranking
data environment-local, avoid duplicate inference, and never mutate thread lifecycle state.

## Delivery strategy

This work lands as three sequential, non-stacked PRs. Each implementation branch starts from the
then-current `main` after its prerequisite PR has merged.

1. **Ranking foundation:** contracts, settings, provider text-generation support, derived cache,
   server coordinator, capability, and RPC.
2. **Shared runtime and web/desktop:** Focus partition, refresh coordinator, settings, Inbox UI, and
   browser coverage.
3. **Native mobile:** shared coordinator adapter, settings, Focus UI, explanations, and pure-model
   coverage.

The implementation does not begin until PR #440 is merged because its shared Active/Settled Inbox
projection is the approved extension point. Do not stack any AI Focus PR on #440.

## Global implementation rules

- Use Bun 1.4.0 as pinned in `package.json`.
- Install dependencies with `bun install --frozen-lockfile` in each fresh implementation worktree.
- Never run `bun test`; use package scripts backed by Vitest.
- Keep contracts schema-only and runtime logic in shared/server packages.
- Keep environment IDs in every client-side key and request route.
- Do not acquire a connection or lease solely to refresh ranking.
- Do not add native imports at module scope; dynamically import native modules inside functions.
- Do not add React component tests for `apps/mobile`; put behavior in pure model modules.
- Make each commit independently testable and omit `Co-Authored-By` trailers.

## PR 1: Ranking foundation

### Task 1: Add priority contracts and backward-compatible settings

**Files**

- Create `packages/contracts/src/threadPriority.ts`.
- Update `packages/contracts/src/index.ts`.
- Update `packages/contracts/src/settings.ts`.
- Update `packages/contracts/src/settings.test.ts`.
- Update `packages/contracts/src/environment.ts`.
- Update `packages/contracts/src/environment.test.ts`.
- Update `packages/contracts/src/rpc.ts`.
- Update `packages/contracts/src/rpc.test.ts`.

**Test first**

Add contract tests that prove:

- the only tiers are `now`, `soon`, `later`, and `none`;
- confidence is `high`, `medium`, or `low`;
- reasons are trimmed, non-empty, and bounded to 160 characters;
- malformed, duplicate, and unknown candidate IDs are representable as RPC failures rather than
  silently trusted client data;
- historical client settings decode with `aiFocusEnabled: false` and a ten-minute interval;
- interval `0` and the approved literal intervals decode, while arbitrary values fail;
- historical server settings decode `inboxPriorityModelSelection` as `null`;
- historical environment descriptors decode `threadPriorityRanking: false`;
- the ensure-current RPC supports normal and forced refresh and returns structured cache metadata.

**Implementation**

Define schemas for:

- `ThreadPriorityTier`;
- `ThreadPriorityConfidence`;
- a bounded `ThreadPriorityReason`;
- batch-local candidate IDs;
- ranked entry, batch snapshot, freshness metadata, and structured failure;
- `ThreadPriorityEnsureCurrentInput` with `force` defaulting to false;
- `ThreadPriorityEnsureCurrentResult` containing the published batch identity and cache/inference
  disposition.

Add client settings:

- `aiFocusEnabled`, default false;
- `aiFocusRefreshIntervalMs`, default 600,000 and literals `0`, `300000`, `600000`, `1800000`, and
  `3600000`.

Add nullable server setting `inboxPriorityModelSelection`; `null` inherits
`textGenerationModelSelection`. Add `threadPriorityRanking` to environment capabilities with a false
decoding default.

**Focused validation**

```sh
bun run --cwd packages/contracts test
bun typecheck --filter=@ryco/contracts
```

**Commit**

```text
feat(contracts): define AI Focus ranking protocol
```

### Task 2: Build bounded prompt input and strict output decoding

**Files**

- Create `apps/server/src/threadPriority/threadPriorityPolicy.ts`.
- Create `apps/server/src/threadPriority/threadPriorityPolicy.test.ts`.
- Update `apps/server/src/textGeneration/TextGenerationPrompts.ts`.
- Update `apps/server/src/textGeneration/TextGenerationPrompts.test.ts`.
- Update `apps/server/src/textGeneration/TextGenerationUtils.ts`.

**Test first**

Use hostile fixtures containing instruction-like thread titles and messages. Prove:

- only approved fields enter the serialized candidate payload;
- latest-user-request excerpts are Unicode-safe and at most 600 characters;
- paths, assistant messages, file content, diffs, terminals, tools, environment variables, secrets,
  credentials, and device labels have no input slot and do not appear in captured prompts;
- ages map to the six approved stable buckets;
- one chunk contains at most 40 candidates and enforces the total prompt budget;
- candidate IDs are opaque and do not expose raw thread IDs;
- missing results are allowed, but duplicate/unknown IDs, invalid tiers/confidence, and overlong
  reasons reject the chunk;
- the prompt treats candidate text as data and grants no tools or mutations.

**Implementation**

Keep pure policy functions independent of SQL and provider adapters:

- normalize approved candidate metadata;
- compute age buckets from an injected clock;
- create opaque batch-local IDs;
- chunk deterministically;
- serialize the untrusted data envelope;
- decode and map validated results back to raw thread IDs only after validation.

Version the prompt policy with a named constant included in cache fingerprints.

**Focused validation**

```sh
bun run --cwd apps/server test -- threadPriorityPolicy TextGenerationPrompts
bun typecheck --filter=@ryco/server
```

**Commit**

```text
feat(server): define bounded inbox ranking policy
```

### Task 3: Add ranking to every text-generation provider

**Files**

- Update `apps/server/src/textGeneration/TextGeneration.ts`.
- Update `apps/server/src/textGeneration/TextGeneration.test.ts`.
- Update `apps/server/src/textGeneration/CodexTextGeneration.ts` and its test.
- Update `apps/server/src/textGeneration/ClaudeTextGeneration.ts` and its test.
- Update `apps/server/src/textGeneration/CopilotTextGeneration.ts` and add or update focused tests.
- Update `apps/server/src/textGeneration/CursorTextGeneration.ts` and its test.
- Update `apps/server/src/textGeneration/GrokTextGeneration.ts` and its test.
- Update `apps/server/src/textGeneration/OpenCodeTextGeneration.ts` and its test.
- Update any provider test fixtures that construct `TextGenerationShape` exhaustively.

**Test first**

For the registry and each provider adapter, prove:

- the configured `ModelSelection` routes to the correct provider instance;
- a valid structured response becomes the shared ranking result;
- provider prose, malformed JSON, unknown IDs, and transport failures become `TextGenerationError`;
- no adapter enables tools for ranking;
- model options are preserved exactly;
- unavailable provider instances fail without fallback to a different provider.

**Implementation**

Add `rankInboxThreads` to `TextGenerationShape` and the provider-instance registry router. Reuse the
shared prompt/policy module while adapting only provider-specific invocation and output extraction.
Do not implement six different ranking prompts or parsers.

**Focused validation**

```sh
bun run --cwd apps/server test -- TextGeneration CodexTextGeneration ClaudeTextGeneration CursorTextGeneration GrokTextGeneration OpenCodeTextGeneration
bun typecheck --filter=@ryco/server
```

**Commit**

```text
feat(server): rank inbox threads with configured providers
```

### Task 4: Persist the derived ranking cache

**Files**

- Create the next numbered migration after current `main` under
  `apps/server/src/persistence/Migrations/`.
- Add the migration to `apps/server/src/persistence/Migrations.ts`.
- Add a focused migration test.
- Create `apps/server/src/threadPriority/ThreadPriorityRepository.ts`.
- Create `apps/server/src/threadPriority/ThreadPriorityRepository.test.ts`.

**Test first**

Prove:

- migration creates the cache table idempotently without changing thread projection rows;
- ranking rows round-trip tier, confidence, reason, input/model fingerprints, prompt version,
  ranked time, and batch identity;
- replacing a batch is transactional;
- deleting a thread deletes its cache row;
- settlement/archive does not delete cache but the query excludes those rows;
- restart hydration preserves valid rows;
- expired rows remain auditable but are not returned as usable rankings.

**Implementation**

Create a dedicated `thread_priority_rankings` table keyed by thread ID, with an index supporting
batch and age reads. Keep the table outside orchestration event storage. Expose repository methods
for read-current, transactional replace, thread cleanup, and test-only inspection.

Choose the migration number only after rebasing on the latest `main`; do not preselect a number that
can collide with another merged branch.

**Focused validation**

```sh
bun run --cwd apps/server test -- Migrations ThreadPriorityRepository
bun typecheck --filter=@ryco/server
```

**Commit**

```text
feat(server): persist inbox priority snapshots
```

### Task 5: Implement candidate query, fingerprints, and single-flight coordinator

**Files**

- Create `apps/server/src/threadPriority/ThreadPriorityCandidateQuery.ts`.
- Create `apps/server/src/threadPriority/ThreadPriorityCandidateQuery.test.ts`.
- Create `apps/server/src/threadPriority/ThreadPriorityCoordinator.ts`.
- Create `apps/server/src/threadPriority/ThreadPriorityCoordinator.test.ts`.
- Wire the coordinator and repository layers in `apps/server/src/server.ts` beside the existing
  text-generation layer.

**Test first**

Build projection fixtures covering active, settled, archived, draft-equivalent, running, approval,
input, failed, PR, issue, and delivery-unknown threads. Prove:

- only server-owned Active candidates are sent to the model;
- candidate query selects only the approved latest-user-message excerpt and metadata;
- fingerprints cover every sent field, model selection, and prompt version;
- ordinary clock movement within an age bucket does not invalidate fingerprints;
- age-bucket, model, prompt, or thread-input changes do invalidate them;
- an unchanged batch younger than 24 hours returns a cache hit with zero provider calls;
- a batch at the 24-hour ceiling reranks even if inputs are unchanged;
- changed candidates rerank a coherent current set;
- concurrent normal/forced requests coalesce to one inference operation;
- one failed chunk publishes none of the replacement batch;
- provider failure retains the previous valid batch;
- automatic requests are rate-limited while manual refresh has a short abuse guard;
- coordinator code has no connection-catalog or lease-acquisition dependency.

**Implementation**

The coordinator resolves the effective model, loads candidates, computes stable fingerprints,
checks cache eligibility, runs bounded chunks through `TextGeneration`, validates all chunks, and
commits one atomic batch. Maintain one in-flight Effect per environment/model fingerprint and clear
it on success, failure, interruption, and restart.

Automatic error logging must contain only counts, timing, provider/model IDs, and failure tags—never
prompt or thread-derived content.

**Focused validation**

```sh
bun run --cwd apps/server test -- ThreadPriorityCandidateQuery ThreadPriorityCoordinator
bun typecheck --filter=@ryco/server
```

**Commit**

```text
feat(server): coordinate cached inbox ranking
```

### Task 6: Expose capability, RPC, and priority projection

**Files**

- Update `apps/server/src/environment/Layers/ServerEnvironment.ts` and its tests.
- Update `apps/server/src/ws.ts` and add a focused RPC test under `apps/server/src/ws/`.
- Extend the thread/workspace shell projection or add a companion priority query in the existing
  projection query layer.
- Update `apps/server/src/server.test.ts` fixtures.
- Update contract and mixed-version fixtures affected by the capability.

**Test first**

Prove:

- the descriptor advertises `threadPriorityRanking: true` only when the RPC is present;
- ensure-current requires normal environment authorization;
- the client cannot supply prompt text, raw candidate metadata, or another environment ID;
- force reaches the coordinator but does not bypass single-flight or the abuse guard;
- optional priority projection fields decode on new clients and remain absent on old fixtures;
- stale RPC connection generations cannot publish a batch or freshness acknowledgement;
- ranking RPC does not emit orchestration commands or acquire hosted connections.

**Implementation**

Register the typed RPC and route it to the coordinator. Publish priority snapshots through the
existing shell/read-model invalidation path, keeping ranking support independent from settlement
support. Use the capability bit instead of server-version checks.

**Focused validation**

```sh
bun run --cwd apps/server test -- threadPriority serverLifecycleEvents server
bun run --cwd packages/contracts test
bun typecheck --filter=@ryco/server --filter=@ryco/contracts
```

**PR 1 backstop**

```sh
bun run fmt:check
bun lint --filter=@ryco/contracts --filter=@ryco/server
bun typecheck --filter=@ryco/contracts --filter=@ryco/server
bun run test --filter=@ryco/contracts --filter=@ryco/server
```

Open the foundation PR, wait for CI success, merge it, then create PR 2 from updated `main`.

## PR 2: Shared runtime and web/desktop

### Task 7: Implement the shared Focus partition

**Files**

- Create `packages/shared/src/threadPriority.ts` with an explicit subpath export.
- Create `packages/shared/src/threadPriority.test.ts`.
- Update `packages/client-runtime/src/state/threads/threadInbox.ts`.
- Update `packages/client-runtime/src/state/threads/threadInbox.test.ts`.
- Update `packages/client-runtime/src/state/threads/types.ts` and store mapping as needed.

**Test first**

Use an injected clock and a five-environment fixture to prove every shared-model acceptance rule:

- Focus/Active is lossless and duplicate-free;
- Settled/Excluded never enter Focus;
- pins always lead and more than five pins are preserved;
- approval, input, and fresh failure precede AI;
- a newer user turn or 24-hour-old failure removes deterministic failure promotion;
- only high/medium-confidence `now` and `soon` rankings fill remaining slots;
- `later`, `none`, low-confidence, missing, malformed, and expired ranking remain Active;
- stable ties preserve existing recency behavior;
- raw thread-ID collisions across environments remain isolated;
- disabling AI Focus restores the exact pre-feature ordering.

**Implementation**

Keep urgency, ranking usability, and ordering as pure functions. Extend the Inbox model with `focus`
while preserving `active`, `settled`, and `excludedCount`. Attach a presentation-neutral focus source
(`pin`, `approval`, `input`, `failure`, or `ai`) and optional explanation metadata.

**Focused validation**

```sh
bun run --cwd packages/shared test -- threadPriority
bun run --cwd packages/client-runtime test -- threadInbox
bun typecheck --filter=@ryco/shared --filter=@ryco/client-runtime
```

**Commit**

```text
feat(runtime): derive stable AI Focus inbox partitions
```

### Task 8: Add a platform-neutral foreground refresh coordinator

**Files**

- Create `packages/client-runtime/src/state/threads/threadPriorityRefresh.ts`.
- Create `packages/client-runtime/src/state/threads/threadPriorityRefresh.test.ts`.
- Export it from the existing thread-state subpath.

**Test first**

Prove:

- enablement requests one refresh for already connected supported environments;
- default scheduling uses ten minutes;
- interval `0` schedules only manual refresh after initial enablement;
- foreground resumes request only stale environments;
- background cancels timers;
- disconnected or unsupported environments are skipped without acquiring them;
- relevant changes wait for quiet and respect the minimum interval;
- manual refresh uses force;
- generation replacement cancels or ignores stale completions;
- multiple UI consumers share one coordinator per runtime.

**Implementation**

Accept injected clock, timer, visibility, environment enumeration, capability, connection-state, and
RPC functions. Do not import DOM or React Native APIs. The web and mobile adapters own lifecycle
subscription only.

**Focused validation**

```sh
bun run --cwd packages/client-runtime test -- threadPriorityRefresh
bun typecheck --filter=@ryco/client-runtime
```

**Commit**

```text
feat(runtime): schedule foreground inbox ranking refreshes
```

### Task 9: Add web/desktop settings and model overrides

**Files**

- Update `apps/web/src/components/settings/SettingsDialog.tsx` and the existing settings section
  registry/search files.
- Create `apps/web/src/components/settings/AiFocusSettings.tsx`.
- Create `apps/web/src/components/settings/AiFocusSettings.logic.ts` and
  `apps/web/src/components/settings/AiFocusSettings.logic.test.ts`.
- Update settings editor/patch logic tests.
- Update environment settings routing so model overrides target the owning environment.

**Test first**

Prove:

- AI Focus defaults disabled and ten minutes;
- enabling and interval changes write only client settings;
- per-environment model rows inherit `textGenerationModelSelection` by default;
- override selection writes to the correct environment and rejects unavailable instances;
- mixed-version environments explain unsupported ranking without disabling other nodes;
- disclosure lists exactly the approved metadata;
- manual refresh targets only connected supported environments and reports user-triggered failures
  through the existing notification system.

**Implementation**

Add one Inbox/AI Focus settings section. Reuse the existing provider/model picker and environment
vocabulary. Do not build a ranking-specific provider registry or duplicate provider labels.

**Focused validation**

```sh
bun run --cwd apps/web test -- SettingsPanels AiFocusSettings
bun typecheck --filter=@ryco/web
```

**Commit**

```text
feat(web): configure AI Focus ranking
```

### Task 10: Render Focus in web and desktop Inbox

**Files**

- Update `apps/web/src/components/inboxSidebar/inboxSidebarModel.ts` and its tests.
- Update `apps/web/src/components/inboxSidebar/InboxSidebar.tsx`.
- Update `apps/web/src/components/inboxSidebar/InboxSidebar.browser.tsx`.
- Extend the existing hover details/context action model for **Why focused?**.
- Wire the web visibility adapter to the shared refresh coordinator.

**Test first**

Prove:

- Focus appears above Active only when enabled and non-empty;
- focused rows are absent from Active;
- pinned/deterministic focus does not claim to be AI-generated;
- AI explanations show tier, bounded reason, effective model, and relative age;
- refresh keeps the previous batch until one atomic replacement;
- the open route remains open when its row changes section;
- disable restores normal ordering immediately;
- automatic failures remain quiet and manual failures produce liquid-glass notifications;
- hosted/disconnected nodes are not connected solely by the refresh adapter.

**Implementation**

Reuse existing rows and section components. Avoid a dashboard/card redesign, repeated shimmer, or
new status vocabulary. Preserve keyboard navigation, context-menu access, reduced motion, and hover
card collision behavior.

**Focused validation**

```sh
bun run --cwd apps/web test -- inboxSidebarModel
bun run --cwd apps/web test:browser -- InboxSidebar
bun typecheck --filter=@ryco/web
```

**PR 2 backstop**

Because this changes hosted reconnect-adjacent web behavior, run:

```sh
bun run fmt:check
bun lint --filter=@ryco/shared --filter=@ryco/client-runtime --filter=@ryco/web
bun typecheck --filter=@ryco/shared --filter=@ryco/client-runtime --filter=@ryco/web
bun run test --filter=@ryco/shared --filter=@ryco/client-runtime --filter=@ryco/web
bun run build --filter=@ryco/web
bun run --cwd apps/web test:browser
```

Open the web/runtime PR, wait for CI success, merge it, then create PR 3 from updated `main`.

## PR 3: Native mobile

### Task 11: Add native settings and foreground scheduling

**Files**

- Add an AI Focus settings route or section under `apps/mobile/src/features/settings/` using existing
  settings rows.
- Update `apps/mobile/src/state/settingsRouting.ts` and its test if a new route is needed.
- Add `apps/mobile/src/features/inbox/useThreadPriorityRefresh.ts` with native lifecycle imports
  inside functions.
- Add pure scheduling-adapter tests.

**Test first**

Prove:

- mobile reads the shared client setting and defaults disabled/ten minutes;
- foreground requests stale connected supported environments;
- background cancels periodic work;
- there is no native background task registration;
- interval `0` remains manual after initial enablement;
- model override rows are explicitly environment-scoped;
- unsupported and disconnected environments remain visible but are skipped for refresh.

**Implementation**

Adapt React Native app-state events into the shared coordinator. Dynamically import any native-only
module inside the adapter function. Reuse the same disclosure and model-selection vocabulary as web.

**Focused validation**

```sh
bun run --cwd apps/mobile test -- settingsRouting threadPriorityRefresh
bun typecheck --filter=@ryco/mobile
```

**Commit**

```text
feat(mobile): configure AI Focus refresh
```

### Task 12: Render Focus and explanations on native mobile

**Files**

- Update `apps/mobile/src/features/inbox/inboxModel.ts`.
- Update `apps/mobile/src/features/inbox/inboxModel.test.ts`.
- Update the native Inbox screen and row action sheet.
- Reuse thread actions/settings components rather than adding a second modal system.

**Test first**

Pure model tests prove:

- Focus, Active, and Settled map from the shared partition without duplicates;
- Focus is hidden when empty or disabled;
- pinned and deterministic focus labels do not claim AI;
- AI **Why focused?** data contains tier, reason, model, and age;
- inaccessible/expired ranking returns the row to Active;
- touch actions never expose a ranking mutation.

**Implementation**

Render a compact Focus section above Active with existing native row primitives. Put explanations in
the established touch action sheet. Preserve accessibility labels and touch sizes. Do not replicate
desktop hover behavior.

**Focused validation**

```sh
bun run --cwd apps/mobile test -- inboxModel
bun typecheck --filter=@ryco/mobile
```

**Commit**

```text
feat(mobile): show AI Focus inbox priorities
```

### Task 13: Cross-client acceptance and cost/privacy evidence

**Files**

- Add or extend fixture helpers in the smallest relevant test packages.
- Update public documentation for AI Focus settings and privacy behavior.
- Do not include private Hub identifiers, production evidence, or infrastructure details.

**Verification**

Collect test evidence for:

- one unified five-environment Focus/Active partition with no duplicates;
- all pins and deterministic approval/input/failure promotion;
- one provider call under concurrent web/mobile refresh requests;
- zero provider calls for unchanged input younger than 24 hours;
- reranking at the 24-hour ceiling;
- captured ranking payload containing only the approved fields;
- zero ranking-driven connection acquisition;
- provider failure fallback;
- the same projected batch rendered on desktop/web and native mobile.

Run proportional final backstops:

```sh
bun run fmt:check
bun lint --filter=@ryco/mobile --filter=@ryco/client-runtime
bun typecheck --filter=@ryco/mobile --filter=@ryco/client-runtime
bun run test --filter=@ryco/mobile --filter=@ryco/client-runtime
```

If PR 3 changes shared web code while adding fixtures, also rerun the web package checks and browser
suite. Trust command exit codes; do not diagnose TypeScript success by grepping ANSI output.

**Commit**

```text
test: validate AI Focus across clients
```

## Final acceptance gate

The feature is complete only when:

- all three PRs have merged independently into `main`;
- the actual `ci.yml` workflow on `main` concludes successfully after the final merge;
- AI Focus is disabled by default and normal Inbox ordering is byte-for-byte equivalent at the pure
  model boundary when disabled;
- enabling it produces a non-duplicated Focus partition across supported connected environments;
- ranking uses the text-generation model by default and respects per-environment overrides;
- ten-minute scheduling, fingerprint cache hits, single-flight behavior, and 24-hour expiry are
  proven in tests;
- captured payload evidence proves the privacy exclusions;
- no production deployment, Coolify operation, secret change, or feature enablement has occurred.
