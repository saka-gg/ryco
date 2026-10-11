# Shared Client Runtime Extraction

**Status:** Draft for owner approval

**Date:** 2026-07-23

## Summary

Ryco's client behavior — RPC transport, environment connection supervision, the hosted
Hub lifecycle, relay framing, and domain state — lives entirely in `apps/web`, wired to the
browser through `window`, `document`, `navigator`, `fetch`, `localStorage`, and
`import.meta.env`. A planned native mobile app needs the same behavior with none of those
globals. This spec extracts that behavior into a platform-agnostic, Effect-based
`@ryco/client-runtime`, consumed by both the web app and the future React Native app, so
authentication, relay, synchronization, application state, and mutation-readiness policy stay
**shared and never forked** (AGENTS.md, "Hosted Hub and PWA Boundaries").

`@ryco/client-runtime` already exists as the seed: four platform-neutral modules
(`scoped`, `knownEnvironment`, `advertisedEndpoint`, `sourceControlDiscoveryState`), deps only
`@ryco/contracts` + `effect`, no DOM coupling. `sourceControlDiscoveryState.ts` was written for
this exact purpose — a keyed manager with injected registry/client/now — and is the
architectural template. This spec grows that seed into the runtime, moving each cluster behind a
small set of app-provided platform service contracts, one behavior-preserving slice at a time.

The extraction is a refactor, not a redesign. Web behavior is held constant and regression-gated
at every slice; the mobile app, any Hub-side auth change, and phone-tier presentation are out of
scope.

## Goals

- **One runtime, two apps.** A single `@ryco/client-runtime` package supplies the RPC transport,
  connection registry, hosted lifecycle, relay engine, and domain state to both the web app and
  the future native app. Platform differences enter only through injected service contracts.
- **Web behavior unchanged.** Each slice preserves observable web behavior byte-for-byte:
  reconnect semantics, hosted fail-closed gating, persisted shapes and migrations, error
  classifications. Existing suites keep passing unmodified; moved modules keep their tests.
- **Mobile-ready contracts.** The platform surface the runtime depends on is small, explicit, and
  implementable from React Native primitives (AppState, NetInfo, Keychain/SecureStore, native
  passkeys) exactly as the web adapter implements it from browser primitives.
- **Machine-checked platform neutrality.** The runtime carries no `react`, DOM, or `node`
  dependency; a lint/dep boundary enforces this so the invariant cannot silently regress.

## Non-goals

- **The mobile app itself.** No `apps/mobile`, no Metro/Expo scaffold, no native modules. This
  spec produces the package the app will consume; the app is workstream B.
- **Any Hub-side auth change.** The runtime's `authorization` surface defines _contracts_. Today's
  hosted session is an HttpOnly same-origin cookie plus an in-memory CSRF token
  (`hostedHub/api.ts:113,449`); React Native cookie behavior is unreliable, so a native client
  needs a bearer-style Hub session that **does not exist yet**. That is new Hub control-plane work
  and is an explicit external dependency of this program (see Decisions and Risks), not part of
  this extraction. Workstream B's passkey login depends on it.
- **Phone-tier changes.** The presentation tier, phone shell, and navigation model
  (`2026-07-20-focused-mobile-workspace-design.md`) are untouched. This is the layer beneath them.
- **Accelerating the AtomRpc migration or unifying the two reconnect stacks.** Those are orthogonal
  and stay as they are (Decisions b, and the generic-vs-hosted reconnect split).

## Package architecture

### Subpath map

Adopt `@ryco/shared`'s packaging exactly: explicit per-subpath `exports` entries, **no root
barrel**, each entry pointing at raw `./src` TypeScript (`packages/shared/package.json:6-57`). The
current `src/index.ts` barrel (`export * from "./advertisedEndpoint.ts"` …) is retired once the
existing four modules gain their own subpath entries; nothing is added to a barrel thereafter.

| Subpath                 | Responsibility                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./scoped`              | Pure environment-scoped project/thread ref key derivation (exists; ~40 web importers).                                                                                                      |
| `./knownEnvironment`    | `KnownEnvironment` model + http/ws base-URL derivation (exists).                                                                                                                            |
| `./platform`            | App-provided service contracts (Effect `Context` tags) + injected config — the entire platform surface below.                                                                               |
| `./errors`              | Shared error inspection: transport error classification, message normalization, bounded reasons.                                                                                            |
| `./pairing`             | Pairing-token URL codecs and hosted pairing parse/build, all URLs passed explicitly.                                                                                                        |
| `./rpc`                 | Effect RPC transport core: protocol layer, `WsTransport`, `WsRpcClient` facade, status atoms, `serverState`, `invalidation`, `keyedQuery`, atom registry, query client.                     |
| `./connection`          | Environment connection registry + supervision: `connection`, saved-env scheduler, catalog stores, `environmentApi`, primary/remote target+auth flows, the supervision half of `service.ts`. |
| `./authorization`       | Hosted account/lifecycle controller (single owner), capabilities, session/ticket policy, auth-gate + bearer flows.                                                                          |
| `./relay`               | Relay frame protocol engine (re-hosted on an injected socket), reconnect policy, connection-status derivation, attempt factory, WebAuthn option/response codecs, base64url.                 |
| `./state/threads`       | Thread/orchestration read-model reducers + selectors + view-model types.                                                                                                                    |
| `./state/orchestration` | Zero-dependency resync state machine + orchestration event-effect derivation.                                                                                                               |
| `./state/session`       | Pure thread-activity derivation (`session-logic`, workspace view model).                                                                                                                    |
| `./state/user-input`    | Pending user-input answer logic.                                                                                                                                                            |
| `./state/composer`      | Composer draft/model-selection/promotion logic + Schema migrations (v1–v7).                                                                                                                 |
| `./state/message-queue` | Follow-up send queue logic + store.                                                                                                                                                         |
| `./state/terminal`      | Terminal event folding + per-thread terminal domain state.                                                                                                                                  |
| `./state/settings`      | Client-settings + saved-environment token-lifetime policy.                                                                                                                                  |
| `./state/vcs`           | Git status + source-control discovery managers (the existing template).                                                                                                                     |

`./authorization` and `./relay` are introduced together as one indivisible unit (Decision c,
Slice 4). `./state/*` mirrors the reference implementation's per-domain state layout so the app
imports only the domains it renders.

### Packaging rules

- **Per-subpath exports, no barrel.** Each subpath is independently importable; consumers never
  transitively pull a sibling they did not name. This is what lets `apps/server` and
  `apps/desktop` bundle a single neutral helper without dragging in transport or state code.
- **Source-shipped TypeScript, no build step** — matching `contracts`/`shared`/`client-runtime`
  today. Consumers transpile workspace TS; the native bundler must resolve the `import` condition
  and transpile workspace sources (a known Metro requirement, out of scope here).
- **Effect catalog pinning.** The whole Effect stack is pinned via the Bun catalog at
  `4.0.0-beta.59` (`package.json:10-18`) with a patch (`patches/effect@4.0.0-beta.59.patch`). The
  runtime sits on `effect/unstable/{rpc,socket,reactivity}`; a single resolved `effect` instance is
  load-bearing (Atom registry identity and Schema brands depend on module identity). Any future
  mobile app must join the same catalog.
- **No `react`, DOM, or `node` deps in the runtime.** The runtime uses
  `effect/unstable/reactivity` `Atom` directly and exposes atom constructors + pure selectors; the
  `@effect/atom-react` binding (`RegistryContext`, `use*` hooks) lives in the apps, not the
  package. The web app's current colocated `use*.ts` hooks migrate to an app-side binding layer.
- **Machine-checked neutrality.** Dropping the current `types: ["node"]`
  (`packages/client-runtime/tsconfig.json`) is **not sufficient** — `tsconfig.base.json` sets no
  `lib`, so TypeScript defaults the lib set from `target: ESNext`, which **includes the DOM
  libraries**. The package tsconfig must therefore set an explicit non-DOM `lib` (e.g.
  `["ES2023"]`) and keep `types: []`, and a boundary import rule in the lint config (`vp lint`)
  must forbid `react`, `react-dom`, DOM-only, and `node:*` imports from the package. The two
  together make platform neutrality compiler- and lint-enforced rather than conventional.

### Dependency direction

Apps provide platform services → `./platform` contracts are satisfied → `./connection` composes
`./authorization`, `./relay`, and `./rpc` over those contracts → `./state/*` consumes the
connection registry and exposes atom/store constructors to app-owned runtimes. There is no broad
re-export; the subpath indices are the public boundary. This matches the reference
implementation's composition pyramid (app `runtime` builds one `ManagedRuntime`; app
`platform` implements every contract; `connection` layer merges them; state atoms run over the
connection layer).

### What lives where

- **`@ryco/contracts` (schema-only, unchanged).** `WsRpcGroup` (`rpc.ts`), relay frames
  (`relay.ts`), `auth.ts`, `environment.ts`, `remoteAccess.ts`, `settings.ts`, and the desktop IPC
  interfaces (`ipc.ts`). Nothing moves out; the runtime depends on contracts and never adds runtime
  logic to it. Hand-rolled hosted-Hub HTTP response validation stays in the runtime — do **not**
  promote it to public schema as a refactor side effect (canonical protocol changes are deliberate,
  public-first).
- **`@ryco/shared` (shared runtime utils, mostly unchanged).** `relayCodec` and `rpcAccessPolicy`
  stay here because both server and client consume them; the runtime depends on those subpaths
  rather than absorbing them. `advertisedEndpoint` **moves here** (Decision a). Transitive helpers
  the state modules need — `threadActivity`, `model`, `perf`, `sourceControl`, `searchRanking`,
  `qrCode` — stay in shared.
- **`@ryco/client-runtime` (grows).** Everything client transport, connection, hosted lifecycle,
  relay, and domain state, all behind the platform contracts.

## Platform contract surface

Every contract is an Effect `Context` service (tag) the app implements; the web adapter implements
each from a browser primitive, the future native adapter from an RN primitive. Each formalizes a
seam that already exists in the web code.

- **`Endpoint`** — origin/base-URL provider returning the primary target and resolving
  http/ws URLs. Formalizes `environments/primary/target.ts:95,158` (`window.location.origin`) and
  `service.ts:1247` (`new URL(wsBaseUrl, window.location.origin)`). The mobile client must never
  depend on an ambient origin; ws base URLs resolve fully from `KnownEnvironment` records.
- **`Socket`** — the WebSocket constructor seam. **Already exists** as
  `WsProtocolLifecycleHandlers.webSocketConstructor` (`rpc/protocol.ts:56-59`), fed into a
  `Socket.WebSocketConstructor` layer (`protocol.ts:199-205`) that defaults to
  `new globalThis.WebSocket(socketUrl, protocols)` at `:205`. The hosted relay already proves a
  nonstandard socket plugs into this seam (`hostedHub/transport.ts`).
- **`AppLifecycle`** — foreground/background, connectivity, and resume signals. Formalizes
  `hostedHub/useHostedBrowserLifecycle.ts` (the single suspend/resume driver),
  `service.ts:1643-1672` (`subscribeBrowserResumeReconnects`), `state.ts:729-751`
  (`#scheduleDirectory` visibility gating), and `wsConnectionState.ts:45` (`navigator.onLine`
  seed). Web: `visibilitychange`/`online`/`pageshow`. Native: `AppState` + NetInfo.
- **`KV`** — plain async key-value storage. The `StateStorage` interface in `lib/storage.ts` is
  already the right shape; formalizes `hooks/useLocalStorage.ts`, `uiStateStore`, and the terminal
  and composer persistence paths.
- **`SecretKV`** — a **separate** secure store for bearer tokens and secrets, deliberately distinct
  from `KV`. Formalizes `clientPersistenceStorage.ts` (bearer tokens in `localStorage` with a
  7-day client-enforced max age) and the `DesktopBridge` `getSavedEnvironmentSecret`/`set`/`remove`
  shape (`contracts/ipc.ts`). Web keeps localStorage-plus-expiry, desktop the bridge, native
  Keychain/SecureStore. **Do not standardize the weak web pattern** onto the shared contract; the
  contract exposes get/set/remove with each platform owning its own at-rest guarantee, and the
  7-day pruning policy travels as behavior, not as a storage assumption.
- **`PasskeyCeremony`** — `authenticate(options)` / `register(options)` returning today's
  `AuthenticationResponseJson`/`RegistrationResponseJson`. Formalizes the two
  `navigator.credentials` calls (`hostedHub/webauthn.ts:227,259`). The **fail-closed option
  validation** (`webauthn.ts:3-214`) stays shared and in front of the platform seam, so an RN
  passkey library cannot loosen it.
- **`SessionCredentials`** — declared credential mode (cookie vs bearer) plus the in-memory CSRF
  holder. Formalizes `hostedHub/api.ts:113,449` (same-origin cookie + `X-Ryco-CSRF`) and
  `primary/auth.ts` (`credentials: "include"`). Web declares cookie mode; the native Hub client
  will declare bearer mode — the variant that depends on new Hub work (Non-goals).
- **`PairingCredentialSource`** — **take-once**: read the pairing credential and destroy its source
  atomically. Formalizes `primary/auth.ts:78-85` (`takePairingTokenFromUrl` → strip via
  `window.history.replaceState` at `:75`). A source that does not preserve take-once-and-destroy
  leaks pairing credentials via history/referrer.
- **`AttachmentCodec`** — encode/decode a composer attachment as `{ id, mime, size, bytes | uri }`,
  replacing the DOM `File`. Formalizes `composerDraftStore.ts:67-70`
  (`ComposerImageAttachment.file: File` + blob preview URL), the `revokeObjectURL` lifecycle
  (`:519-527`), and dataURL rehydration (`composerDraftPersistence.ts:1160-1169`). Blob-URL
  lifecycle stays a web adapter concern (Decision e).
- **`Clock` + `FrameScheduler`** — `now()` and `scheduleFrame(cb)`. Already injectable via
  `ShellEventCoalescerDeps` — `store.ts:2676` (`defaultScheduleFrame`, `requestAnimationFrame`) and
  `:2684` (`defaultNow`, `performance.now`) are only the defaults. Web supplies rAF/perf; native
  supplies its own frame callback and clock.
- **`Observability`** — tracer + perf recorder with a **no-op default**. Formalizes
  `wsTransport.ts:299` (`ClientTracingLive` hard-wired into every transport session, pulling
  `FetchHttpClient`/OTLP/`isElectron`/`APP_VERSION`) and `:359` (`recordWebPerfPayload`, gated on
  `import.meta.env`). The transport core must have zero web imports; the web app layers its tracer
  back in, mobile defaults to no-op.
- **Injected config** — replaces `import.meta.env`. Most callers read `VITE_*` **inside
  functions** — `env.ts:12-14`, `environments/primary/target.ts:40-68`,
  `environments/runtime/catalog.ts:227-234`, `hostedPairing.ts:11-16` — so they are ambient reads,
  not import-time branching, and become injected-config lookups without changing init order. The
  genuine import-time cases are `perf/perfInstrumentation.ts:10` (a module-scope
  `const … = parsePerfProfileFlag(import.meta.env.VITE_RYCO_PERF_PROFILE)`) and
  `composerDraftPersistence.ts:53` (a module-scope `const` that calls `isHostedHubMode()` and a
  module-scope `window.addEventListener("beforeunload", …)`). A single config value
  (`{ clientMode, httpBaseUrl?, wsBaseUrl?, hostedAppUrl?, devServerUrl?, perfProfile? }`) is
  provided at bootstrap; the two import-time sites are inverted to read it lazily (Risk 5).

## Decisions

Each carries a recommendation and rationale; the owner may veto any.

**(a) `advertisedEndpoint`'s home → move to `@ryco/shared`.** _Correction to the discovery
synthesis:_ `apps/server` and `apps/desktop` do **not** production-depend on
`@ryco/client-runtime`. It is a **devDependency** in both (`apps/server/package.json:47`,
`apps/desktop/package.json:25`), bundled at build time by `tsdown`, and each imports **only**
`createAdvertisedEndpoint` (`AdvertisedEndpointRegistry.ts:3`, `serverExposure.ts:2`,
`tailscaleEndpointProvider.ts:5`). The function depends solely on `@ryco/contracts` and the WHATWG
`URL` global, so it fits `@ryco/shared` cleanly. Moving it there severs the build-time edge
entirely: as the runtime grows client transport and state code, the server/desktop bundlers never
resolve `@ryco/client-runtime` at all, and the platform-neutral invariant stays trivially true.
_Alternative (owner veto):_ keep it in the runtime under strict subpath discipline so the server
only ever imports `./advertisedEndpoint`; workable, but leaves the edge and relies on convention.

**(b) The two parallel RPC paths → extract the `WsRpcClient` facade as-is; keep the AtomRpc
migration orthogonal.** The promise facade dominates: `WsRpcClient`/`wsRpcClient` occurs on 62
lines across **18** `apps/web` files (measured at HEAD); the newer `AtomRpc`/`runRpc` path touches
only **3** files (`rpc/client.ts`, `rpc/invalidation.ts`, `rpc/registry.tsx`). Extract the
facade verbatim so the dominant, well-tested path moves without behavior change; the mobile app
consumes it. The `AtomRpc` client moves too, with its primary-environment URL binding replaced by
an injected `Endpoint` provider, but this program does **not** accelerate or complete the
documented facade-to-atom migration — that stays independent. Forcing the migration would expand
scope and risk and give mobile two sockets to the same server.

**(c) Singleton strategy → each singleton moves home atomically with all its importers, in one
slice; no dual-home window.** The load-bearing module-level singletons, with their moving slice:
`appAtomRegistry` (`rpc/atomRegistry.tsx:5`, its `AtomRegistry.make()`), `sharedReactivity`
(`rpc/invalidation.ts`), `keyedQueryEnvironmentCleanups` (`rpc/keyedQuery.ts`) → Slice 2; the
`service.ts` module-level state — `environmentConnections`, `pendingSavedEnvironmentConnections`,
`environmentConnectionListeners`, `threadDetailSubscriptions`,
`lastAppliedProjectionVersionByEnvironment` (maps/sets) and `activeService`,
`needsProviderInvalidation`, `lastBrowserHiddenAt`, `lastBrowserResumeReconnectAt` (mutable
scalars) at `environments/runtime/service.ts:106-142` → Slice 3; `hostedHubController`, the
`hostedHubApi` instance holding the only CSRF-token copy, `getHostedRelayAttemptFactory`, and the
memoized primary auth gate → Slice 4. Two singletons **stay app-side and must not be duplicated
into the package**: `cachedApi` (`localApi.ts:32`), because the `LocalApi` facade stays in
`apps/web` (Slice 3, Out), and `defaultQueryClient` (`rpc/queryClient.ts`), a React-bound legacy
query cache (Slice 2, split note). A dual-home window double-instantiates any of these: two
bootstraps racing, the CSRF token in the wrong instance, tickets issued by one factory and
consumed by another. Each slice moves a singleton's definition and every importer together; the
atom registry stays a single instance the app hands to React via `RegistryContext`.

**(d) zustand vs Atom per state domain → keep zustand where it is today.** Lowest risk. `store.ts`,
`uiStateStore`, `terminalStateStore`, `composerDraftStore`, and `messageQueueStore` are zustand
today, and zustand is RN-compatible. The domain store is written **imperatively** via
`useStore.getState()` from the runtime service (`service.ts:436,1037,1111`); converting it to Atoms
during extraction would rewrite a hot call path while also moving it — two risky changes at once.
The `rpc/` layer and `sourceControlDiscoveryState` stay Atom-based (they already are). Choose per
domain; do not convert opportunistically.

**(e) Attachment abstraction shape → a neutral value type plus the `AttachmentCodec` service.** A
`ComposerAttachment` carries `{ id, mime, size, bytes } | { id, mime, size, uri }` (the flat
discriminated union defined in the contract surface above) and flows through
composer → queue → send pipeline in place of `File`. The web adapter wraps `File`/blob-URL
lifecycle (`createObjectURL`/`revokeObjectURL` stay web-side); persistence encodes to
bytes/dataURL exactly as `composerDraftPersistence` does today. Because this type flows widely
(through the 577-line `executeChatSendTurn` pipeline and the message queue), it is a **prerequisite
ripple**, not a local fix, and it gates the composer/queue state slice.

## Delivery slices

Six slices, each a **separate PR that is independently green** against the full gate set below.
Web behavior is unchanged at every step; the web app is always releasable. The full public gate set
is `bun install --frozen-lockfile`, `bun fmt`, `bun run fmt:check`, `bun lint`, `bun typecheck`,
`bun run typecheck:effect`, `bun run test`, `bun run build` (AGENTS.md). For any slice touching
reconnect/lifecycle/PWA behavior, AGENTS.md **additionally** requires installing the pinned browser
runtime (`bun run --cwd apps/web test:browser:install`), building the web package
(`bun run build --filter=@ryco/web`), and running the browser suite
(`bun run --cwd apps/web test:browser`) **once**. Layered on top of that AGENTS requirement, this
program adopts a **project policy** of running the browser suite three times ("browser suite" in
the slices below) to bound flake on the reconnect/lifecycle-adjacent slices; the third run is
policy, not an AGENTS mandate.

**Slice 1 — Packaging + platform contracts.**
_In:_ per-subpath `exports` map, retire the barrel, tsconfig types discipline; define `./platform`
(all contracts above) and injected config; move `advertisedEndpoint` to `@ryco/shared` (Decision a)
and repoint the server/desktop imports; add `@ryco/shared` to the web install filter if absent;
wire `apps/web` as the first platform provider (a `connection/platform` adapter dir).
_Out:_ no behavior moves yet.
_Contracts introduced:_ the entire platform surface (as tags), plus injected config.
_Regression gate:_ full gate set; `bun run build:desktop` (the `advertisedEndpoint` move touches the
desktop pipeline); existing `client-runtime` tests.
_Exit:_ the package exposes contracts + config; `createAdvertisedEndpoint` imports from
`@ryco/shared`; server/desktop no longer resolve `@ryco/client-runtime`; web builds green.

**Slice 2 — RPC transport core (neutral atom state; React bindings stay app-side).**
The rpc modules are not uniformly neutral: `rpc/atomRegistry.tsx:1-8` imports React +
`@effect/atom-react`, `rpc/queryClient.ts:1-8` imports React hooks, `rpc/serverState.ts:1-15`
imports both, and `rpc/wsConnectionState.ts:1` and `rpc/requestLatencyState.ts:1` import
`useAtomValue`. So the slice **splits each mixed module** into a neutral core (moves) and an
app-side binding (stays), consistent with the no-React-in-runtime rule.
_Moves to `./rpc` (neutral):_ `protocol`, `wsTransport`, `wsRpcClient` (the facade — effect-only),
`invalidation`, `keyedQuery`; the **neutral halves** of the split modules —
`atomRegistry.tsx`'s `appAtomRegistry = AtomRegistry.make()` (an
`effect/unstable/reactivity` value), `wsConnectionState`'s atoms + backoff constants/math +
lifecycle **recorder functions**, `requestLatencyState`'s tracking atoms + timer recorders,
and `serverState`'s atoms + `applyServerConfigEvent` reducer +
`startServerStateSync`. `transportError` moves to `./errors`.
_Stays in `apps/web` (app-side bindings):_ `atomRegistry.tsx`'s `AppAtomRegistryProvider`/
`RegistryContext.Provider` JSX; the `use*` hooks split out of `wsConnectionState`
(`useWsConnectionStatus`), `requestLatencyState` (`useSlowRpcAckRequests`,
`requestLatencyState.ts:131`), and `serverState` (the `useAtomSubscribe`/`useAtomValue`
selectors); `queryClient.ts` in whole (a React-hook-based legacy query cache with direct
consumers across the app — `lib/sourceControlContextRpc`, `ChatView`, the hosted teardown's
`defaultQueryClient` reset, and the work-item/settings/source-control panels — being replaced
by atoms; it does not move).
_Deferred to Slice 3:_ `rpc/client.ts` (AtomRpc). Endpoint injection alone is insufficient — it
imports `ensurePrimaryEnvironmentReady`/`getPrimaryKnownEnvironment` from `~/environments/primary`
(`rpc/client.ts:6`) and `appAtomRegistry` from `./atomRegistry` (`:8`). It moves in Slice 3, once
`./connection` provides the primary target, behind an injected primary-target/readiness service
plus the (now in-package) registry.
_Out:_ domain atoms (they depend on `./connection`).
_Contracts introduced:_ `Socket`, `Observability` (no-op default), `AppLifecycle` (online). Web
adapters supply today's defaults verbatim (`globalThis.WebSocket`, `ClientTracingLive`,
`navigator.onLine`).
_Regression gate:_ full gate set; the string-classification pinning tests (below); browser suite
(status atoms are UI-adjacent — see gate policy).
_Exit:_ the web transport runs through the package rpc core with the app binding layer on top;
reconnect and heartbeat semantics identical.

**Slice 3 — Connection / environment registry.**
_In:_ `connection`, `savedEnvironmentConnectionScheduler`, catalog stores, `environmentApi`,
`primary/context` + auth flows, `remote/api` + `remote/target`, `rpc/client.ts` (deferred from
Slice 2, behind an injected primary-target/readiness service + the in-package registry), and the
**supervision half** of `service.ts` (connection registry, projection versioning, thread-detail
subscription cache, resume-reconnect policy) with its module-level singletons (Decision c). App
writes are inverted through an explicit **`EnvironmentStateSink`** and the existing handler
interfaces (`OrchestrationHandlers`, `createEnvironmentConnectionHandlers`); `pushSequenceMonitor`
injected.
_`EnvironmentStateSink` operations (grounded in `service.ts`'s actual writes at `:1037-1079` and
`:1153-1195`):_ `applyOrchestrationEvents(envId, events)` and `syncServerShellSnapshot(envId,
snapshot)` (thread store, `:1037,:1173`); `syncProjects(envId, …)` / `syncThreads(envId, …)`
driven off `selectProjectsAcrossEnvironments`/`selectThreadsAcrossEnvironments` (UI state,
`:1041-1055`); `clearThreadDraft(ref)` / `clearProjectDraftThread(ref)` (composer drafts,
`:1068-1075`); `clearTerminalState(ref)` (terminal state, `:1079`); and
`markProviderInvalidationNeeded()` / `flushProviderInvalidation()` (the `needsProviderInvalidation`
flag + `rpc/invalidation`). Hosted readiness (`markHostedSessionReady`/`Replaying`, `:1165,:1190`)
stays on the **separate** hosted handler interface, not the generic sink. The web adapter wires the
sink to today's zustand stores unchanged; when `./state/threads` moves (Slice 5a) the thread-store
operations are satisfied in-package while the UI/composer/terminal operations remain sink calls
into app-side presentation stores.
_Out:_ `primary/target` source resolution (becomes the web `Endpoint` impl),
`WebSocketConnectionSurface` + toasts, `localApi` browser/desktop impls (keeps `cachedApi`), the
store-clearing catalog.
_Contracts:_ `Endpoint`, `KV`, `SecretKV`, `SessionCredentials`, `PairingCredentialSource`, plus
the injected primary-target/readiness service for `rpc/client.ts`.
_Regression gate:_ full gate set; `authBootstrap.test.ts` behavior re-landed against platform fakes;
browser suite. This is the riskiest single edit — the sink inversion cuts through a hot path — so
it is isolated in its own slice.
_Exit:_ web supervision runs through the package with a state-sink adapter; hosted mode still NOOPs
the generic reconnect/sync paths (`service.ts:1921,1934`); behavior identical.

**Slice 4 — Hosted lifecycle unit (moved whole, single slice).**
The hosted unit **moves as one indivisible unit or not at all**. _In:_ `hostedHub/state.ts`
controller + `types` + `transport.ts` attempt factory + `reconnectPolicy` + `connectionStatus` +
`capabilities` + `logging`; the relay protocol state machine from `relaySocket.ts` **re-hosted on
an injected `Socket`** (drop the browser-`WebSocket`/`EventTarget`/`CloseEvent` facade —
inverting it, not porting it); the WebAuthn option/response codecs; a pure base64url; and
`api.ts` validation/error mapping behind `SessionCredentials` + `PasskeyCeremony`; and — required
because the controller **depends on** `environment.ts`, not merely on a clear hook — the
`environment.ts` **transition queue itself**. `state.ts` dynamically imports `./environment` for
`activateHostedNode`/`deactivateHostedNode` at six sites (`state.ts:273-275,359-360,483-485,
536-537,568-571,784`); a single `clearNodeScopedState` hook does not cover them. So the serialized
activate/suspend/deactivate transition queue moves into the unit as the **hosted-node lifecycle
contract** — the controller calls it in-package instead of importing a retained module, and the
core owns its ordering. Its in-package dependencies are satisfied by Slice 3/4 (`connect`/
`disconnect` primitives and `writePrimaryEnvironmentDescriptor` from `./connection`,
`resetHostedRelayAttemptFactory` from `./relay`, and the rpc/connection atom clears + thread-store
clear called in the core-owned teardown order). The unit moves **with its integration tests** —
`lifecycle.integration.test.ts`, `nodeRouteRestore.integration.test.ts`,
`returnToDirectory.integration.test.ts` — plus every unit test (`state`, `transport`, `relaySocket`,
`api`, `capabilities`, `connectionStatus`, `environment`, `logging`, `reconnectPolicy`, `webauthn`).
_Out:_ `useHostedBrowserLifecycle` (web `AppLifecycle` impl); `nodeRoutes` +
`nodeRouteOrchestrator` history wiring (extract only the fail-closed validation decision tree, keep
the TanStack history adapter web-side); and the **app-UI-store portion** of
`clearHostedNodeScopedState` — `commandPaletteStore`, `settingsDialogStore`, `modelPickerOpenState`,
`shortcutModifierState`, `threadSelectionStore`, `uiStateStore`, `composerDraftStore`,
`messageQueueStore`, `terminalStateStore` (`environment.ts:3-24`) — passed in as an injected
`clearNodeScopedState` hook whose **teardown order is owned by the core**, never forked.
_Contracts:_ `SessionCredentials`, `PasskeyCeremony`, `Socket` (relay), `AppLifecycle`,
hosted-node lifecycle (activate/suspend/deactivate) with `clearNodeScopedState`.
_Regression gate:_ full gate set; the three integration tests; browser suite (hosted reconnect).
_Exit:_ the hosted unit runs from the package; the controller no longer imports a retained module;
the invariants below all hold; integration tests green with unchanged behavior.

_Package-level invariants (restated from AGENTS.md, enforced here):_

- **Single authoritative owner.** The hosted lifecycle has exactly one owner. Generation fencing is
  cross-module — the counter is owned by `state.ts` (bumped in `selectNode`/`resume`/`retry`/
  deactivate) and threaded through `transport.ts` (`#activeGeneration`) and `service.ts` handlers
  (`createEnvironmentConnectionHandlers(hostedGeneration)`, `markHostedSessionReady/Replaying`),
  with `environment.ts` participating via the controller-stamped serialized transition queue. This
  is why the unit moves whole: any partial extraction reintroduces the stale-generation races the
  boundary forbids.
- **No second implementation.** No second authentication, transport, or mutation-readiness
  implementation is created for mobile; the mobile app provides platform adapters and consumes this
  one owner.
- **Hub session material, relay tickets, and proofs are never persisted.** This is scoped
  precisely: **saved-environment bearer tokens legitimately live in `SecretKV` by design** — the
  browser stores them with a 7-day client-enforced lifetime
  (`clientPersistenceStorage.ts:14,74-100`), and native uses Keychain/SecureStore. What must
  **never** be persisted anywhere (not `KV`, not `SecretKV`, not logs, URLs, or history) is the
  hosted Hub session (an HttpOnly cookie the runtime cannot read regardless), relay tickets, and
  node proofs. The install-before-bootstrap console boundary (`logging.ts`) travels with the unit.
- **Ticket zeroization preserved.** One-use tickets are enforced verbatim (`transport.ts`:
  `used` flag guard, per-attempt `issueRelayTicket`, 401 → `expireSession`) and the relay engine
  zeroizes ticket and payload buffers (`relaySocket.ts` `.fill(0)` on the decoded ticket and on
  frame payloads). The injected `Socket` must not copy, retain, or re-send buffers.
- **Generic reconnect never bypasses hosted ownership** (AGENTS.md). The direct/saved-environment
  reconnect helpers are NOOP in hosted mode (`service.ts:1921,1934`) and a stale generation cannot
  publish readiness, role, snapshots, or mutation authority. The state-sink and hosted handler
  interfaces preserve this; no generic path may race the owner.
- **Service worker stays a static-shell mechanism, not a data plane** (AGENTS.md). This extraction
  moves no caching into the runtime; the hosted service worker never caches authenticated APIs,
  RPC, relay traffic, tickets, proofs, credentials, node-owned content, request bodies, or live
  documents. Offline behavior is unchanged.

**Slice 5 — State domains (incremental).**
_5a (mobile MVP first):_ `orchestrationRecovery` + `orchestrationEventEffects`
(`./state/orchestration`); `store.ts` reducers + `threadDerivation` + `storeSelectors`
(`./state/threads`); `session-logic` + `threadWorkspaceViewModel` (`./state/session`);
`pendingUserInput` (`./state/user-input`). zustand kept (Decision d), written via the state-sink
adapter from Slice 3.
_Stranded dependencies assigned:_ the view-model `types.ts` and `lib/threadSort.ts` are shared
substrate — `threadDerivation.ts:2-11`, `session-logic.ts:1-23`, and `storeSelectors.ts:3-6`
import them — so both **move into `./state/threads`** with this slice. `store.ts:42-50` imports four
non-neutral things, each resolved by an earlier contract: `isHostedHubMode` (`./env`) → injected
config (Slice 1); `sanitizeThreadErrorMessage` (`./rpc/transportError`) → `./errors` (Slice 2);
the `perf/perfInstrumentation` reads → `Observability` (Slice 1/2); and `resolveEnvironmentHttpUrl`
(`./environments/runtime`, used only for attachment `previewUrl` at `store.ts:191-198`) → an
injected attachment-preview URL resolver on the `Endpoint`/`AttachmentCodec` surface.
_5b (after the attachment abstraction):_ the `composerDraftStore` draft/model-selection/promotion
logic + `composerDraftPersistence` **Schema migrations** (`./state/composer`), `messageQueue.logic`

- `messageQueueStore` (`./state/message-queue`), `terminalStateStore` folding (`./state/terminal`),
  and the `clientPersistenceStorage` token-lifetime policy (`./state/settings`), all behind
  `AttachmentCodec` + `KV` + `SecretKV`. Domain helpers `modelSelection`, `providerInstances`,
  `providerModels`, and `composer-logic` move alongside.
  _`executeChatSendTurn` is split, not moved whole._ It imports UI at `hooks/executeChatSendTurn.ts:
  20-40` — `ChatComposerHandle` (`components/chat/ChatComposer`), `toastManager`/`stackedThreadToast`
  (`components/ui/toast`), and `components/ChatView.logic`. The **pure send engine** (model/provider/
  runtime-mode resolution, worktree/branch naming, `EnvironmentApi` dispatch, `newCommandId`/
  `newMessageId`) moves into `./state/composer`; the **UI adapters** (composer focus/handle, toasts,
  `ChatView.logic`) stay app-side and are injected into or invoked around the engine by the caller.
  _Browser-persistence stays app-side._ `composerDraftPersistence.ts:29-62` binds `localStorage` and
  registers `window.beforeunload` at module scope; those bindings stay in `apps/web` as the web `KV`
  adapter and an `AppLifecycle` flush, while the Schema migrations and key builders move.
  _Out:_ `threadSelectionStore`, `threadWorkspaceTabs`, the `uiStateStore` presentation half, the
  `proposedPlan` download helper. `historyBootstrap` is **deferred** — it has no runtime consumer
  (verified: only its own test references it).
  _Contracts:_ `Clock` + `FrameScheduler`, `AttachmentCodec`, `KV`, `SecretKV`.
  _Regression gate:_ full gate set; every moved module keeps its tests; the composer Schema-migration
  v1–v7 pinning tests; 3× browser suite for composer/queue/terminal.
  _Exit:_ threads + orchestration state served from the package (5a), then composer/queue/terminal
  (5b); persisted shapes and migrations unchanged.

**Slice 6 — Cleanup and boundary lock.**
_In:_ retire the now-duplicated web paths; lock the boundary with lint/dep rules (no `react`/DOM/
`node` in the runtime; per-subpath imports only; forbid barrel additions; forbid the server
importing any non-neutral subpath). Delete the legacy RPC facade **only if** the AtomRpc migration
has independently completed — expected to remain, per Decision b, so this is a conditional no-op.
_Exit:_ the boundary is machine-enforced; no dual-home singletons remain; gates green.

Workstream B's mobile scaffold can consume the package from Slice 2 onward; the mobile MVP needs
Slices 1–5a, with 5b as the composer/terminal follow-up.

## Testing strategy

- **Behavior-preserving by construction.** Existing suites keep passing **unmodified** — same
  assertions, same fixtures. A slice that changes a web test's expectations is not a pure
  extraction and is rejected. Moved modules carry their tests with them into the package.
- **Contract-level tests replace global stubs.** Today's suites stub browser globals directly:
  `authBootstrap.test.ts` uses `vi.stubGlobal(window/document/fetch/desktopBridge)`; hosted tests
  stub `navigator.credentials`, `DOMException`, and `fetch`. After extraction, equivalent coverage
  runs against **platform fakes** — an `Endpoint`, `SessionCredentials`, `PairingCredentialSource`,
  `PasskeyCeremony`, `Socket`, and `KV`/`SecretKV` implemented for tests — asserting the same
  behaviors (silent desktop bootstrap, manual pairing, transient-retry timing, single-flight
  memoization, strip-before-use). This coverage lands **in the same PR** as the code it protects.
- **String-matched classifications pinned verbatim.** Reconnect/retry logic matches literal Effect
  error text; an effect bump silently changes reconnect semantics. Preserve and pin, with tests
  asserting exact strings: the transport patterns `/\bSocketCloseError\b/i`, `/\bSocketOpenError\b/i`,
  `/\bping timeout\b/i` (`transportError.ts:2-5`); the literal `"Unable to connect to the Ryco
  server WebSocket."` (`protocol.ts:217`); `THREAD_NOT_FOUND_ERROR_RE = /^Thread\s.+\swas not
  found$/u` (`wsTransport.ts:39`); and `isSubscriptionStreamDoneError` matching
  `"SchemaError(Expected array"` (`wsTransport.ts:66-72`). Effect stays pinned at catalog
  `4.0.0-beta.59` + patch; any future mobile app joins the same catalog (a duplicate `effect`
  instance fractures atoms and Schema brands).
- **Hosted unit integration tests are the single-owner gate.** `lifecycle.integration.test.ts`,
  `nodeRouteRestore.integration.test.ts`, and `returnToDirectory.integration.test.ts` move with the
  unit in Slice 4 and must stay green with unchanged behavior — they are the regression proof that
  generation fencing and fail-closed ordering survived the move.
- **Browser suite for UI-adjacent slices** (2, 3, 4, 5): the AGENTS.md web build + one
  browser-suite run, plus this program's ×3 policy run to bound flake, proving reconnect, hosted
  lifecycle, status vocabulary, and persisted state are unchanged at real viewports.

## Risks and mitigations

1. **Hosted single-owner invariant is cross-module** (verified: `state.ts` counter → `transport.ts`
   `#activeGeneration` → `service.ts` handlers, `environment.ts` via the controller transition).
   Partial extraction reintroduces the forbidden races. → Slice 4 moves the unit whole with its
   integration tests; no piece extracts alone.
2. **Mobile → Hub auth does not exist yet** — hosted sessions are HttpOnly same-origin cookies plus
   in-memory CSRF (`api.ts:113,449`); RN cookie behavior is unreliable. → The `authorization`
   subpath defines contracts only; the native bearer Hub session is new Hub-side work and an
   explicit external dependency (Non-goals). This is the program's most important cross-workstream
   dependency and workstream B's passkey login blocks on it.
3. **Load-bearing module-level singletons.** → Decision c: each moves home atomically with all
   importers; no dual-home window.
4. **String-based error classification.** → Preserve verbatim, pin effect, add the pinning tests
   above.
5. **`import.meta.env` — mostly ambient function reads, two genuine import-time sites.** `env.ts:
   12-14`, `target.ts:40-68`, `catalog.ts:227-234`, and `hostedPairing.ts:11-16` read `VITE_*`
   **inside functions**, so they become injected-config lookups without reordering init. The real
   import-time hazards are `perf/perfInstrumentation.ts:10` (module-scope `const`) and
   `composerDraftPersistence.ts:53` (module-scope `const` calling `isHostedHubMode()` plus a
   module-scope `beforeunload` listener). → Injected config supplied at bootstrap; the two
   import-time sites are inverted to read lazily; boot ordering preserved so the console boundary
   still installs before `controller.bootstrap`.
6. **`advertisedEndpoint` build edge** (corrected: devDependency bundled by `tsdown`, not a prod
   dep). → Decision a: move to `@ryco/shared` and sever it.
7. **Two RPC paths mid-migration.** → Decision b: extract the dominant facade; keep the AtomRpc
   migration orthogonal so mobile does not inherit two sockets.
8. **Packaging / native bundling.** Source-shipped TS + `exports` maps need workspace transpilation;
   Hermes needs a URL polyfill (`advertisedEndpoint`/`protocol` mutate `URL`); the relay facade
   relies on browser event classes RN lacks. → Per-subpath exports + catalog pin + explicit
   non-DOM `lib` and boundary lint; the relay engine is re-hosted on an injected `Socket`
   (Slice 4), never ported as a fake `WebSocket`.
9. **DOM `File` attachment ripple** across composer/queue/send. → Decision e: the attachment
   abstraction is a prerequisite that gates Slice 5b.
10. **Web regression concentrated in `service.ts`** (supervision interleaved with imperative zustand
    writes). → The state-sink inversion is isolated in Slice 3 with 3× browser coverage.
