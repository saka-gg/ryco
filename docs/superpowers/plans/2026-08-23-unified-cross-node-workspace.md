# Unified Cross-Node Workspace Implementation Plan

Six sequential pull requests. Every pull request starts from the then-current `main`, remains green
on its own, and is independently revertable. Do not stack the branches. Do not deploy or change
production while implementing this program.

## Objective

Implement the approved design in
`docs/superpowers/specs/2026-08-23-unified-cross-node-workspace-design.md`: Desktop, Mobile, and
eligible hosted Web sessions present one client-side workspace across enrolled machines, while
each project, thread, subscription, and mutation remains explicitly owned by one environment.

The user must not choose a machine before discovering or opening work. Machine choice remains
explicit only for administration, first-contact verification, filters, and the pre-send execution
target override for new work.

## Relationship to the provenance program

This plan extends, rather than replaces, the mobile provenance work in
`docs/superpowers/plans/2026-08-19-mobile-node-provenance-model.md`.

The following existing behavior is a required baseline and must not be reimplemented under new
names:

- cross-environment thread/project selectors in `packages/client-runtime/src/state/threads`;
- Mobile's versioned snapshot persistence in `apps/mobile/src/persistence`;
- the hosted connection retarget decision model and demand-driven connection coordinator in
  `apps/mobile/src/connection`;
- the three-connection ceiling established by `docs/relay-capacity-assessment-3b.md`;
- presence-sourced staleness, per-environment delivery state, and the existing degraded-reason
  vocabulary; and
- the adaptive, visibility-aware screenshot stream in
  `apps/web/src/components/device/useDeviceScreenshotStream.ts`.

Provider context handoff remains within a node-owned thread. This program does not transfer an
active thread between machines.

## Verified implementation baseline (2026-08-23)

- `packages/client-runtime/src/state/threads/store.ts` already exposes cross-environment project,
  worktree, thread, and cache-hydration selectors.
- Mobile already renders cross-environment Home data through `apps/mobile/src/state/homeData.ts`.
- Mobile already persists bounded, complete environment snapshots through
  `environmentSnapshotCodec.ts`, `environmentSnapshotPersistence.ts`, and `snapshotDb.ts`.
- Mobile already has refcounted hosted activity scopes and a five-node concurrency fixture in
  `hostedConnectionScopes.ts` and `hostedConnectionCoordinator.test.ts`.
- Mobile trust in `nodeTrustModel.ts` is currently a presentation projection; verification routes
  still depend on the singular E2EE session/current selection and therefore cannot authorize work.
- Logical-repository grouping is duplicated in `apps/mobile/src/lib/logicalProject.ts` and
  `apps/web/src/logicalProject.ts`.
- Web's saved/direct environment runtime is already multi-environment, but hosted Web still treats
  `hostedHub/state.ts::selectedNode` as the navigation and lifecycle owner.
- Web's current `Sidebar.tsx` consumes cross-environment thread selectors, and the complete Projects
  sidebar is factored under `apps/web/src/components/sidebar`.
- Desktop already has main-process-only Hub credentials, native E2EE trust/handshake primitives,
  local trusted introduction, bounded preload operations, and client persistence. Extend these
  boundaries; do not create a second credential or identity implementation.
- `apps/web/src/uiStateStore.ts` persists device-local UI state under `ryco:ui-state:v1`, but has no
  sidebar mode or way to distinguish a new document from a migrated pre-feature document.

Before the first implementation branch, update from `origin/main` and re-verify these facts. If
their shape has changed, adjust file names without weakening the invariants or acceptance tests.

## Program invariants

Every wave must preserve all of these rules:

1. The Hub never receives project/thread metadata and never becomes an aggregation service.
2. Every physical resource key and command includes `EnvironmentId`; identical resource ids on two
   nodes never collide.
3. Logical project ids and repository identities are presentation keys, never RPC targets.
4. Native trust is an asynchronous authoritative eligibility input. A synchronous display snapshot
   may explain trust but may not grant access or mutation authority.
5. Cache writes happen only after a complete projection settles. Partial refreshes never erase the
   last complete snapshot.
6. The cache contains metadata only: never messages, provider events, terminals, files,
   attachments, screenshots, detailed diffs, credentials, or secrets.
7. Cache namespaces include Hub origin, account id, and environment id. Revocation, removal,
   ineligibility, identity conflict, and sign-out apply their documented purge/lock behavior.
8. Mounted detail/status work creates refcounted scope leases; list rendering does not connect.
9. `UNIFIED_WORKSPACE_MAX_CONNECTIONS` (or the final equivalent named constant) is three and cites
   `docs/relay-capacity-assessment-3b.md`. A platform limit may be lower, never higher.
10. The established presence, trust, role, delivery-unknown, stale, and degraded-reason vocabularies
    are reused. No parallel status vocabulary is introduced.
11. Desktop node identity and Desktop client identity remain separate security principals.
12. The production service worker stays a static-shell mechanism and never caches authenticated or
    node-owned workspace data.

## Branch and merge policy

| Wave | Branch                                     | Base                        | Product exposure                   |
| ---- | ------------------------------------------ | --------------------------- | ---------------------------------- |
| 1    | `codex/unified-workspace-1-shared-runtime` | current `main`              | no intended UI change              |
| 2    | `codex/unified-workspace-2-native-trust`   | current `main` after wave 1 | Mobile verification and trust gate |
| 3    | `codex/unified-workspace-3-desktop-client` | current `main` after wave 2 | Desktop unified workspace          |
| 4    | `codex/unified-workspace-4-hosted-web`     | current `main` after wave 3 | hosted Web unified workspace       |
| 5    | `codex/unified-workspace-5-sidebar-modes`  | current `main` after wave 4 | Inbox/Projects sidebar switch      |
| 6    | `codex/unified-workspace-6-convergence`    | current `main` after wave 5 | cleanup and final qualification    |

For each wave:

1. fetch and branch from current `origin/main` after the predecessor merges;
2. install with the Bun version pinned in `package.json` using
   `bun install --frozen-lockfile`;
3. keep generated evidence and private Hub details out of the public repository;
4. open one reviewable PR describing changed invariants and evidence;
5. require its CI workflow to pass before merging; and
6. delete the branch only after merge and confirmation that `main` remains green.

## Wave 1: Shared workspace model

Branch `codex/unified-workspace-1-shared-runtime`, based on current `main`.

### Goal

Create one pure, platform-neutral domain for catalog, cache reconciliation, logical projects,
connection demand, and execution targets. Existing Mobile/Web rendering remains behaviorally
unchanged in this wave.

### Files

- `packages/client-runtime/package.json`
- new `packages/client-runtime/src/state/workspace/types.ts`
- new `packages/client-runtime/src/state/workspace/machineCatalog.ts`
- new `packages/client-runtime/src/state/workspace/metadataSnapshot.ts`
- new `packages/client-runtime/src/state/workspace/logicalProjects.ts`
- new `packages/client-runtime/src/state/workspace/connectionDemand.ts`
- new `packages/client-runtime/src/state/workspace/executionTarget.ts`
- new `packages/client-runtime/src/state/workspace/workspaceIndex.ts`
- new `packages/client-runtime/src/state/workspace/index.ts`
- colocated `*.test.ts` files under `packages/client-runtime/src/state/workspace`
- `apps/mobile/src/lib/logicalProject.ts`
- `apps/mobile/src/features/projects/projectsModel.ts`
- `apps/mobile/src/persistence/environmentSnapshotCodec.ts`
- `apps/mobile/src/persistence/environmentSnapshotPersistence.ts`
- `apps/web/src/logicalProject.ts`
- affected existing tests for the adapters above

### Tasks

1. Define scoped domain types:
   - machine catalog entry and client tier;
   - authoritative eligibility and native trust states;
   - metadata-only physical project, worktree, thread, and provider summaries;
   - locked-stale snapshot state for identity conflict;
   - logical project/physical variant references; and
   - physical execution targets and disabled-target reasons.
2. Keep `EnvironmentId` on every physical type. Add constructors/helpers that require both
   environment and resource id so consumers cannot accidentally create an unscoped reference.
3. Implement machine-catalog reconciliation from directory records, local trust evidence,
   effective role, presence, revocation, capability, connection, and delivery inputs. Preserve
   `unknown`, `unverified`, `offline`, and `revoked` as distinct states.
4. Define a platform cache port for load, replace, purge-environment, purge-account, and bounded
   eviction. Keep serialization and storage out of the shared runtime.
5. Implement snapshot validation/reconciliation:
   - accept only supported versions and complete snapshots;
   - atomically replace the prior complete snapshot;
   - retain the prior snapshot during a partial/failed refresh;
   - enforce per-environment and total bounds through deterministic eviction;
   - purge on revocation, removal, or client-tier ineligibility; and
   - lock, rather than expose, stale metadata after a native identity conflict until explicit
     purge/re-verification policy resolves it.
6. Move the algorithmically identical canonical-repository grouping into
   `logicalProjects.ts`. Leave thin compatibility adapters/re-exports in Mobile and Web for this
   wave so no UI behavior changes. Ambiguous repository identities remain separate.
7. Extract the policy of Mobile's existing retarget/scopes coordinator into a pure connection
   demand model without changing Mobile behavior yet. Define the refcounted lease, TTL renewal,
   retained-scope priority, non-retained LRU displacement, queued/cancellable demand, background
   release, and staggered foreground-reconnect decisions. Define
   `UNIFIED_WORKSPACE_MAX_CONNECTIONS = 3` with a comment citing
   `docs/relay-capacity-assessment-3b.md`; accept a platform ceiling constrained to `1..3`.
8. Implement the deterministic target resolver: explicit override, recent eligible use, local
   Desktop tie-break, then stable environment-id ordering. Require online, authorized, tier-eligible
   physical variants. Return `No verified machine available` rather than assigning an offline or
   unrelated copy.
9. Build `workspaceIndex.ts` as a pure projection of catalog plus last-complete snapshots. It must
   retain provenance/freshness and never make a logical project a mutation target.
10. Adapt Mobile's existing snapshot codec/persistence to the shared metadata schema without
    changing its database key compatibility or expanding the persisted payload.
11. Export the domain only through `@ryco/client-runtime/state/workspace`.

### Required tests

- Five catalog entries spanning verified, unverified, unknown, offline, and revoked states.
- Two environments with identical project/thread ids remain separately addressable.
- Canonical repository matches group; path/name similarity and ambiguous identities do not.
- A partial refresh retains the prior complete snapshot; a complete refresh replaces it atomically.
- Bounds and deterministic eviction operate per environment and in total.
- Revocation, removal, ineligibility, account sign-out, and identity conflict take the required
  purge/lock action.
- A five-node demand fixture proves the limit, retained-scope priority, queued fourth demand,
  cancellation, LRU displacement, background release, and staggered foreground decisions at
  platform ceilings one through three.
- Target selection covers override, recent use, Desktop-local tie, stable final ordering, roles,
  trust, offline state, and the no-target copy.
- Existing Mobile and Web logical-project fixtures produce the same output through the adapters.

### Validation

```sh
bun run --cwd packages/client-runtime test
bun run --cwd apps/mobile test
bun run --cwd apps/web test
bun run fmt:check
bun typecheck
```

### Exit evidence

The PR links the collision, cache, logical-project, and resolver tests, and explicitly states that
there is no intended product/UI behavior change.

## Wave 2: Per-machine native trust and Mobile eligibility

Branch `codex/unified-workspace-2-native-trust`, based on current `main` after wave 1.

### Goal

Let Mobile request and complete approval independently for every machine, and make verified trust
an actual workspace eligibility gate rather than presentation-only status.

### Files

- `apps/mobile/src/Stack.tsx`
- `apps/mobile/src/navigation/mvpRouteConfig.ts`
- `apps/mobile/src/features/e2ee/useMobileE2eeSession.ts`
- `apps/mobile/src/features/e2ee/E2eeNodeSecurityRouteScreen.tsx`
- `apps/mobile/src/features/e2ee/E2eeNodeVerificationRouteScreen.tsx`
- `apps/mobile/src/features/e2ee/e2eeTrustUiModel.ts`
- `apps/mobile/src/features/home/useNodeTrust.ts`
- `apps/mobile/src/features/home/nodeTrustModel.ts`
- `apps/mobile/src/features/home/useHomeEnvironments.ts`
- `apps/mobile/src/features/home/homeEnvironmentModel.ts`
- `apps/mobile/src/features/home/HomeScreen.tsx`
- `apps/mobile/src/features/nodes/NodesScreen.tsx`
- `apps/mobile/src/features/newTask/NewTaskRouteScreen.tsx`
- `apps/mobile/src/features/newTask/NewTaskComposer.tsx`
- `apps/mobile/src/features/newTask/NewTaskContextSheet.tsx`
- `apps/mobile/src/features/newTask/newTaskController.ts`
- `apps/mobile/src/connection/hostedConnectionCoordinator.ts`
- `apps/mobile/src/connection/hostedConnectionScopes.ts`
- `apps/mobile/src/state/homeData.ts`
- affected colocated tests

No React component tests are introduced. Put route decisions, eligibility, grouping, and approval
state in pure modules and test those modules. Native modules remain dynamically imported inside
functions.

### Tasks

1. Change Security and Verification navigation params to carry the exact `(nodeId,
   environmentId)` pair. Reject a route whose node cannot be matched to the expected environment;
   never fall back to the current/first selected node.
2. Refactor `useMobileE2eeSession` or add an environment-scoped accessor so trust, fingerprint,
   pending request, and authorization state are resolved for the route's exact environment.
3. Add an exact-environment pairing scope to the existing coordinator. Requesting approval may
   acquire/retry that node, but must not retarget or disconnect an unrelated primary environment.
   Adapt the coordinator to the shared demand decisions from wave 1 while preserving its existing
   connection driver and lease-report mechanism.
4. Replace verification flows that call `disconnectPrimaryEnvironment()` or
   `connectPrimaryEnvironment()` with scoped release/reacquire operations for the target
   environment. Pairing scopes are refcounted and released on cancellation/unmount.
5. Promote trust evaluation into the shared workspace catalog input. The async durable trust check
   is authoritative; `nodeTrustModel.ts` becomes presentation of that result, not an authorization
   source.
6. Exclude native-unverified node metadata from the normal workspace projection. The directory
   entry remains visible in a new **Needs verification** group containing exact-machine actions.
7. Add the group to Home and reuse the same action from each row in Machines. Multiple pending nodes
   remain independently actionable; completing one removes only that row.
8. On identity conflict, close/release that environment, stop mutations, and render any retained
   prior snapshot only as locked stale history. Require explicit re-verification before reopening
   workspace data.
9. Preserve role and presence as independent gates. Verification does not make an offline node
   online or grant an operator role.
10. Integrate the shared execution-target resolver into Mobile new-task state. Show the chosen
    machine beside provider/model, permit a pre-send override, and retain prompt, attachments,
    provider, model, and effort while retargeting. Once created, keep the thread on the selected
    physical environment.

### Required tests

- Two enrolled nodes can have concurrent independent approval states and exact navigation targets.
- Approving/retrying node B does not alter node A's connection or trust state.
- An unverified node appears in **Needs verification** but contributes no workspace rows.
- A verified node becomes eligible without selecting it globally.
- Identity change releases only that environment and makes its old metadata locked/unactionable.
- Revoked, offline, viewer, unknown-trust, and verified-operator cases remain distinct.
- Route and action helpers fail closed when `(nodeId, environmentId)` do not match.
- New work selects the eligible physical copy deterministically, preserves draft state on override,
  and disables send with **No verified machine available** when no candidate qualifies.

### Validation

```sh
bun run --cwd packages/client-runtime test
bun run --cwd apps/mobile test
bun run fmt:check
bun typecheck
```

### Device evidence

Using two independently enrolled CLI nodes, demonstrate from native Mobile that each can be opened,
requested, approved, and verified without making either a global selection. Record that unverified
workspace data is absent before approval and appears after durable verification. If the simulator
cannot exercise a physical-device security boundary, state that limitation plainly and attach the
pure/integration test evidence instead.

## Wave 3: Desktop dual-role native Hub client

Branch `codex/unified-workspace-3-desktop-client`, based on current `main` after wave 2.

### Goal

Make the Desktop renderer a native Hub client that can aggregate its local node and remote nodes,
without merging the UI client's account/security principal into the existing node process.

### Existing foundations to extend

- `apps/desktop/src/hostedCredentials.ts`
- `apps/desktop/src/desktopHostedIdentity.ts`
- `apps/desktop/src/desktopE2eeTrust.ts`
- `apps/desktop/src/desktopNativeE2eeHandshake.ts`
- `apps/desktop/src/nativeAuthorization.ts`
- `apps/desktop/src/nativeSecretStore.ts`
- `apps/desktop/src/localTrustedIntroduction.ts`
- `apps/desktop/src/automaticNodeClaim.ts`
- `apps/desktop/src/desktopHubControl.ts`
- `apps/desktop/src/desktopE2eePrekey.ts`
- `apps/desktop/src/clientPersistence.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/desktopControlBoundary.test.ts`

### New or expanded modules

- new `apps/desktop/src/desktopWorkspaceClient.ts`
- new `apps/desktop/src/desktopWorkspaceCache.ts`
- new `apps/desktop/src/desktopWorkspaceIpc.ts`
- corresponding `*.test.ts` files
- Desktop typings for the bounded preload surface
- renderer platform adapter/call sites under `apps/web/src/platform` or the existing Desktop-aware
  web adapter selected by the current architecture
- `apps/web/src/components/hostedHub/HostedNodeDirectory.tsx`
- `apps/web/src/components/hostedHub/HostedNodeDetail.tsx`
- `apps/web/src/components/hostedHub/HostedE2eeVerification.tsx`
- `apps/web/src/components/settings/AccountSettings.tsx`
- `apps/web/src/components/settings/NodeSecuritySettings.tsx`
- `apps/web/src/hooks/useHandleNewThread.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`
- relevant Desktop/hosted-client documentation whose old UI-shell decision is superseded

### Tasks

1. Define an explicit main-process Desktop client lifecycle separate from backend/node startup. It
   owns Hub account session, native client device identity, remote-node directory/trust, cache, and
   connection demand.
2. Reuse `hostedCredentials`, `desktopHostedIdentity`, `nativeSecretStore`, and the existing native
   handshake. Do not duplicate token storage, key generation, or E2EE protocol code.
3. Use `localTrustedIntroduction` to authorize the colocated node without a QR ceremony. This is a
   scoped local proof, not a reason to auto-trust remote nodes.
4. Expose only bounded IPC commands/projections: sign in/out, catalog snapshot, exact-machine
   verification operations, workspace snapshot events, scoped connection demand, and cache purge.
   Raw Hub credentials, node keys, client private keys, relay proofs, and E2EE secrets never cross
   preload.
5. Add a Desktop cache adapter using the shared cache contract and a client-only namespace. Keep it
   separate from the node/backend persistence namespace and enforce the metadata-only schema.
6. Compose the colocated environment and eligible remote environments into the shared workspace
   index. The local node participates as an ordinary physical variant with a local tie-break hint,
   not as an implicit mutation fallback.
7. Use the shared connection demand controller for thread detail, VCS status, and provider status.
   Preserve the named absolute ceiling of three; background/window lifecycle releases non-retained
   connections and stagger-reacquires retained demand.
8. Route renderer reads and commands through scoped references. Local-only behavior remains fast,
   but no API is allowed to infer local environment when a remote resource is rendered.
9. Expose exact-machine directory, detail, and verification actions through the existing Desktop
   Web UI components backed by the native preload boundary. The UI consumes projections and opaque
   operation handles only; it never receives native client secrets.
10. Integrate the execution-target resolver into Desktop new-thread handling. Display the automatic
    machine target beside provider/model and allow override before first send without changing an
    existing thread's owner.
11. Preserve independent lifecycle boundaries:

- signing the client out does not stop or unenroll the local node;
- disabling/leaving the local node connector does not sign the client out;
- restarting either plane does not adopt the other's credentials or authority; and
- failure of one plane has an environment-scoped presentation.

12. Amend older Desktop/Hub documentation only where it says the UI shell can never be a Hub client.
    Keep the node/account separation and all private operational details intact.

### Required tests

- Preload/main boundary tests prove no raw token, proof, or private key is exposed.
- Storage tests prove node and client namespaces cannot overwrite/read each other.
- Local introduction trusts only the colocated node; a remote node remains independently unverified.
- Sign-out, node leave/disable, client restart, and node restart are pairwise independent.
- A local and remote node with colliding resource ids route to their own environments.
- The five-node fixture never exceeds three connections; retained scopes, queued fourth demand,
  cancellation, LRU displacement, background release, and staggered foreground recovery hold.
- Cached lists do not acquire connections; opening a remote thread does.
- Desktop new work selects/overrides an eligible physical copy and disables send when none exists.

### Validation

```sh
bun run --cwd packages/client-runtime test
bun run --cwd apps/desktop test
bun run --cwd apps/web test
bun run build:desktop
bun run fmt:check
bun typecheck
```

### Device/application evidence

Demonstrate in Desktop that the local node and at least one remote verified node appear together,
opening either thread acquires the owning environment, and signing out the Desktop client leaves the
local node running. Capture boundary-test output rather than any credentials or private Hub details.

## Wave 4: Hosted Web convergence

Branch `codex/unified-workspace-4-hosted-web`, based on current `main` after wave 3.

### Goal

Make hosted Web consume the same unified workspace projections and scoped routing while preserving
its weaker unsigned-browser disclosure and native-only node policy.

### Files

- `apps/web/src/hostedHub/state.ts`
- `apps/web/src/hostedHub/runtime.ts`
- `apps/web/src/hostedHub/e2eeAttempt.ts`
- `apps/web/src/hostedHub/nodeRouteOrchestrator.ts`
- `apps/web/src/hostedHub/nodeRoutes.ts`
- `apps/web/src/hostedHub/useHostedBrowserLifecycle.ts`
- new `apps/web/src/hostedHub/hostedConnectionCoordinator.ts`
- new `apps/web/src/hostedHub/hostedConnectionScopes.ts`
- `apps/web/src/environments/runtime/service.ts`
- `apps/web/src/environments/runtime/connection.ts`
- `apps/web/src/environments/runtime/environmentStateSink.ts`
- `apps/web/src/clientPersistenceStorage.ts`
- new `apps/web/src/persistence/workspaceMetadataCache.ts`
- `apps/web/src/components/RootAppShell.tsx`
- `apps/web/src/components/hostedHub/HostedHubRoot.tsx`
- `apps/web/src/components/hostedHub/HostedNodeDirectory.tsx`
- `apps/web/src/components/hostedHub/HostedNodeDetail.tsx`
- `apps/web/src/components/hostedHub/HostedRelayTrustNotice.logic.ts`
- `apps/web/src/hooks/useHandleNewThread.ts`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/device/useDeviceScreenshotStream.ts`
- affected unit, integration, and browser tests

### Tasks

1. Add a browser cache adapter outside the service worker. Namespace by normalized Hub origin,
   account id, and environment id; persist only the shared metadata schema; purge on sign-out,
   removal, revocation, and loss of browser-tier eligibility.
2. Replace singular hosted navigation ownership with an environment-keyed hosted connection
   registry. `selectedNode` may remain temporarily as directory UI compatibility state, but routes,
   subscriptions, and mutations must not derive their target or lifetime from it.
3. Reuse the existing environment runtime connection/state sink rather than building a parallel RPC
   stack. Accept environment-scoped complete snapshots into the shared workspace index.
4. Add refcounted Web scope leases for thread detail, VCS status, and provider status. Opening a
   scoped thread acquires its environment automatically; returning to a directory/list does not
   tear down retained work or connect every cached node.
5. Start hosted Web with a named platform ceiling of one. Keep the shared absolute ceiling of three.
   Increase the Web ceiling only in the same PR that contains measurement showing the new value fits
   the relay assessment under concurrent sustained streams.
6. Preserve the existing adaptive screenshot stream: 750 ms is a floor, payload bytes determine the
   next interval, and hidden panels/documents suspend streaming. Measure it with concurrent
   environment traffic; do not replace measured backpressure with a fixed interval.
7. Render nodes requiring native clients as locked directory/catalog entries with **Open in
   Desktop/Mobile**. Fetch and cache no private workspace metadata for them.
8. Keep unsigned-browser security disclosure and the existing trust/degraded copy. Web never labels
   itself verified and never silently downgrades native-only policy.
9. Move hosted routes to scoped environment/thread references. Back/directory navigation releases
   only its own non-retained demand and cannot globally disconnect unrelated active work.
10. Ensure one node's failed acquisition, stale snapshot, or delivery uncertainty stays local to its
    rows/thread and does not create a global disconnected banner.
11. Integrate the shared execution-target resolver into hosted Web new-thread handling for eligible
    browser-accessible variants. Show and allow override of the target before first send; when none
    qualifies, retain the draft and show **No verified machine available**.

### Capacity qualification

Record, for one, two, and three concurrent hosted environments:

- full-PNG payload bytes and effective screenshot interval;
- sustained screenshot bytes/second per visible stream and aggregate;
- relay bytes/second for thread, VCS, and provider scopes;
- connection/reconnect count during foreground restore; and
- peak concurrent relay connections.

Compare the aggregate to `docs/relay-capacity-assessment-3b.md`. If only one connection is
qualified, ship the unified cached workspace with Web bound to one. Do not infer that native's bound
of three is safe for a browser.

### Required tests

- Two hosted environments with colliding ids navigate and mutate only their scoped owner.
- Cached cross-node lists render without acquiring all nodes.
- Opening an uncached thread acquires it with no machine-selection step.
- Directory/back navigation does not disconnect an unrelated retained thread.
- Sign-out and revocation purge the correct cache namespace.
- Native-only nodes stay locked and contribute no private metadata.
- The unsigned-browser disclosure remains present through unified routes.
- The platform ceiling holds under a five-node fixture; a fourth retained demand waits/cancels.
- Background/foreground restores retained scopes only and is staggered.
- Screenshot-stream tests retain visibility suspension and payload-based adaptive delay.
- New-thread selection and override preserve draft/provider state and never target a locked,
  offline, unauthorized, or unrelated variant.

### Validation

```sh
bun run --cwd packages/client-runtime test
bun run --cwd apps/web test
bun run build --filter=@ryco/web
bun run --cwd apps/web test:browser:install
bun run --cwd apps/web test:browser
bun run fmt:check
bun typecheck
```

### Browser evidence

Use a five-node fixture to record the actual Web connection maximum and queued state. Demonstrate
two eligible nodes in one workspace, direct scoped opening, native-only locked treatment, cache
survival across a reload, and cache purge after sign-out. Attach the capacity table to the PR; do
not commit private endpoints or account identifiers.

## Wave 5: Full-height Inbox and Projects sidebar modes

Branch `codex/unified-workspace-5-sidebar-modes`, based on current `main` after wave 4.

### Goal

Add the approved Desktop/Web Inbox sidebar as a full replacement mode while preserving every
behavior of the current Projects sidebar. Both consume the same workspace projections and scoped
commands.

### Files

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/sidebar/SidebarChrome.tsx`
- new `apps/web/src/components/sidebar/SidebarModeSwitcher.tsx`
- new `apps/web/src/components/inboxSidebar/InboxSidebar.tsx`
- new `apps/web/src/components/inboxSidebar/inboxSidebarModel.ts`
- new `apps/web/src/components/inboxSidebar/InboxSidebarGroup.tsx`
- new `apps/web/src/components/inboxSidebar/InboxSidebarThreadRow.tsx`
- new colocated pure model/tests and browser fixtures
- `apps/web/src/uiStateStore.ts`
- UI-state persistence/migration tests
- relevant command palette/keybinding registry files discovered from current `main`
- existing Projects-sidebar tests under `apps/web/src/components/sidebar`

### Tasks

1. Add `SidebarMode = "inbox" | "projects"` to persisted UI state with an explicit document-origin
   migration:
   - a successfully loaded pre-feature persisted document materializes `"projects"`;
   - creation with no persisted/legacy document materializes `"inbox"`; and
   - every later launch restores the saved choice.
     Do not implement this as one generic “missing field” fallback; that cannot distinguish migration
     from a fresh profile.
2. Add the title dropdown **Inbox ▾** / **Projects ▾** to the shared full-height sidebar chrome.
   Switching replaces the complete sidebar body; modes are never horizontally laid out or vertically
   combined.
3. Build a pure Inbox projection with **Active now**, **Needs input**, and **Recent** groups. Reuse
   existing thread urgency/activity, provider identity, machine provenance, role, stale,
   delivery-unknown, and degraded-reason data.
4. Put the provider mark at each thread row's lower trailing edge and keep machine/status metadata
   quiet unless relevant. A row click navigates directly with `(environmentId, threadId)`.
5. Add search and optional machine/status filtering as presentation scopes only. They do not acquire
   connections or alter mutation authority.
6. Keep the existing Projects tree structurally intact. Adapt only the input boundary necessary to
   receive logical projects and physical variants while preserving folders, ordering, expansion,
   drag behavior, shortcuts, actions, context menus, and responsive behavior.
7. Ensure new-thread actions resolve a physical execution target through the shared resolver and
   show the target beside provider/model before send. The user may override it without losing draft
   content. Existing threads never retarget to another repository copy.
8. Add command-palette actions and keyboard shortcuts for **Show Inbox sidebar** and **Show Projects
   sidebar**, following the repository's existing command/keybinding schemas.
9. Mount the unified workspace owner above the sidebar mode boundary. Switching modes must not
   reconnect, refetch, clear filters outside the sidebar, or remount environment runtimes.
10. Preserve Desktop and browser responsive layouts. This wave establishes the approved V1
    hierarchy; further visual refinement remains a later, presentation-only change.

### Required tests

- A real pre-feature persisted fixture migrates to Projects.
- No persisted or legacy document creates a fresh Inbox default.
- A stored user choice survives reload.
- Switching modes triggers no workspace fetch, lease acquisition, or connection churn.
- Identical fixtures in both modes navigate to the same scoped thread and execute the same scoped
  commands.
- Provider mark, machine provenance, stale/role/trust/delivery states use existing model values.
- Projects folders/order/expansion/drag/actions and responsive behavior remain covered.
- Inbox grouping and filters are deterministic and do not change target authority.
- Keyboard/command-palette actions switch the full-height mode.

### Validation

```sh
bun run --cwd apps/web test
bun run build --filter=@ryco/web
bun run --cwd apps/web test:browser
bun run build:desktop
bun run fmt:check
bun typecheck
```

### Visual evidence

Capture Desktop and hosted Web at representative narrow and wide widths in both modes. The evidence
must show a vertical full-height Inbox sidebar, the unbroken Projects sidebar, provider marks, quiet
machine provenance, and direct navigation to two different environments. Treat visual defects as
bugs, but do not broaden this V1 wave into an unrelated redesign.

## Wave 6: Convergence cleanup and final qualification

Branch `codex/unified-workspace-6-convergence`, based on current `main` after wave 5.

### Goal

Remove remaining global selected-machine assumptions from primary navigation/mutation paths,
complete all-client evidence, and leave one authoritative workspace/connection policy.

### Audit scope

- `packages/client-runtime/src`
- `apps/mobile/src`
- `apps/web/src`
- `apps/desktop/src`
- public documentation for hosted lifecycle, native trust, and workspace behavior

### Tasks

1. Search for `selectedNode`, `activeEnvironment`, `primaryEnvironment`, `disconnectPrimary`,
   `connectPrimary`, unscoped resource ids, process-global connection state, and mutation helpers
   that infer environment from rendered UI.
2. Classify every result:
   - explicit machine administration/filter state may remain;
   - compatibility state may remain only if no command, subscription, route, or lease depends on it;
   - primary-navigation and mutation inference must move to scoped shared APIs; and
   - dead compatibility paths are deleted with regression tests.
3. Confirm global connection/status slots cannot be clobbered by concurrent environments. Every
   row/thread consumes the owning environment's status.
4. Confirm list/cache hydration never acquires a scope. Only mounted thread detail, VCS status, and
   provider status retain live demand.
5. Run the shared five-node fixture on Mobile, Desktop, and hosted Web using each platform's
   qualified limit. Assert the absolute limit of three independently of observation/logging.
6. Measure traffic with and without mounted scopes. Report the actual reduction in sustained relay
   bytes/second and the screenshot-stream contribution; do not claim leases reduce traffic without
   numbers.
7. Exercise background/foreground on native clients and visibility restore on Web. Prove
   non-retained release and staggered retained reconnect without a reconnect-all path.
8. Exercise new work in a logical project with two eligible copies: automatic target, visible
   override, no prompt/attachment/provider/model loss, and physical ownership after first send.
9. Exercise failure isolation: offline node, failed acquisition, delivery-unknown, revoked node,
   identity conflict, ambiguous repository identity, and no eligible execution target.
10. Update public docs to describe the final user model and security tiers. Keep private endpoints,
    infrastructure, credentials, deployment identifiers, and qualification artifacts out of the
    repository.

### Required acceptance matrix

| Scenario                                        | Mobile   | Desktop  | Hosted Web                    |
| ----------------------------------------------- | -------- | -------- | ----------------------------- |
| All eligible machines visible without selection | required | required | required                      |
| Exact-machine verification                      | required | required | native-only/locked disclosure |
| Cached metadata without eager connect           | required | required | required                      |
| Scoped thread auto-connect                      | required | required | required                      |
| Five-node bound                                 | max 3    | max 3    | measured limit, max 3         |
| Background/visibility recovery without storm    | required | required | required                      |
| New-work target and override                    | required | required | required when eligible        |
| Offline/failure isolation                       | required | required | required                      |
| Sidebar Inbox/Projects parity                   | n/a      | required | required                      |

### Full validation backstop

This final wave is cross-cutting and high risk, so run the repository backstop and the browser and
Desktop pipelines:

```sh
bun fmt
bun run fmt:check
bun lint
bun typecheck
bun run test
bun run build
bun run build:desktop
bun run build --filter=@ryco/web
bun run --cwd apps/web test:browser:install
bun run --cwd apps/web test:browser
```

Trust exit codes. Never replace `bun typecheck` with grepping ANSI output, and never invoke
`bun test`.

### Final device evidence

Use two Hub-enrolled CLI nodes, including the established QA pair when available, plus the
five-node fixture for the synthetic bound:

1. request and verify each real node independently from native Machines;
2. show both nodes' projects/threads together on Mobile and Desktop;
3. open a thread on each and show both live simultaneously;
4. open work on a third environment without evicting either retained thread;
5. background the client and show non-retained release plus staggered retained recovery;
6. stop one node and show only its rows become stale/unavailable;
7. create new work with automatic node selection and a visible pre-send override;
8. switch Desktop/Web sidebar modes and prove navigation targets remain identical; and
9. record lease traffic with scopes mounted and unmounted.

If a device-only behavior cannot be demonstrated, say so explicitly in the PR and point to the
specific automated test that covers it. Do not substitute a claim for evidence.

## Program completion criteria

The program is complete only when all six PRs have merged and a `ci.yml` run on `main` concludes
`success`, with links to:

- the per-machine verification evidence;
- the scoped collision and logical-project tests;
- the five-node concurrency assertion for every platform limit;
- the measured lease traffic reduction and Web screenshot load table;
- the Mobile/Desktop multi-node device evidence;
- the Desktop credential/key isolation tests;
- the hosted Web disclosure/native-only/cache-purge tests; and
- the Inbox/Projects migration, parity, and visual evidence.

At completion, no Home, Inbox, Projects, search, new-thread, thread-open, or mutation path requires
or infers a global selected machine. Machines remain explicit provenance, execution locations, and
administration targets—not application modes.
