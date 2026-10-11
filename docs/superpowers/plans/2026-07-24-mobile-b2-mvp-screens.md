# Mobile B2: MVP screens

**Goal:** Implement the spec's MVP screens on top of B1's runtime loop — Home, Thread
(composer/feed/approvals via the copied native modules + Liquid Glass), Review/diff (native
canvas), Connections/Settings — all on runtime A state. B2 replaces B1's minimal
`PairingScreen` surface with the full pruned navigation tree, and closes every stub B1
documented as "a B2 concern". No EAS/TestFlight work (B3), no hosted passkeys (workstream C),
no terminal (v1.1).

**Design spec:** `docs/superpowers/specs/2026-07-23-native-mobile-app-design.md` (the
§"Screens and navigation (MVP subset)" route table, §"Per-screen data", §"Styling",
§4 seams, and the §"Bundling" iOS-backgrounding finding are authoritative here; the route
table's inline §6/§7 quotes are the entire keyed-query-cache and linking requirement
surface).

## Execution rules

- Work only on `feat/mobile-b2-screens` in `sak0a/ryco`, cut from `main` after B1
  (`feat/mobile-scaffold`) merges. All changes under `apps/mobile` (plus `patches/` and the
  root `package.json`/`bun.lock` patch-and-pin wiring Task 1 requires).
- **Retain the T3 Tools MIT notice** on every newly copied upstream file; update the relevant
  `UPSTREAM.md`/LICENSE notices when new upstream directories are copied. No copied file
  loses its notice.
- **Strip on copy**: every screen file copied from `upstream/main` passes the strip list —
  no Clerk/cloud plane, no showcase rig, no agent-awareness push, no share/quick-actions,
  no T3 brand. `rg -i 't3tools|t3code|clerk|pingdotgg|ARK85ZXQ4Z|6787819824|d763fcb8|axiom'`
  over `apps/mobile/src` stays clean; additionally `rg '\bT3[A-Z]|@t3tools'` over
  `apps/mobile/src` must return nothing. Outside `src/`, B1's MIT attribution files
  (`NOTICE.md`, `modules/*/UPSTREAM.md`, `modules/*/LICENSE`) intentionally contain upstream
  names — that intentional, documented residue is the only allowed exception (B1's rule);
  repo-wide sweeps exclude those files rather than strip them. B1 renamed the native
  modules' registered view names to `RycoComposerEditor` / `RycoReviewDiffSurface` (upstream
  `T3ReviewDiffSurface`) / `RycoNativeControls` / `RycoKeyboardCommands` — every ported
  `requireNativeView` call site must use the registered Ryco names exactly.
- **No forked runtime logic**: screens read runtime A through B1's bindings
  (`src/state/threadsRuntime.ts`, `src/state/composerDraftStore.ts`, `src/rpc/*`,
  `registry.driver.supervisor`). Timeline/session/composer/send/queue/user-input logic comes
  from `@ryco/client-runtime`; the app adds presentation and thin wiring only.
- **No atom-runtime port** (standing architectural decision): upstream's
  `connectionAtomRuntime` layer stack (`src/connection/runtime.ts`, atom-based
  `state/threads.ts`/`state/session.ts`/`state/entities.ts`) is NOT ported. Copied screens'
  data hooks are rewritten over B1's zustand `useStore` selectors and the catalog
  `StoreApi`s (via `useSyncExternalStore`); `appAtomRegistry` atoms are used only for the
  keyed-query diff cache and ws/server state, matching B1's Task-4 wiring. Do not import
  upstream's `@t3tools/client-runtime/state/connections` or `state/shell` shapes — the
  equivalents are `useStore` selectors and the catalog runtime store.
- **Close B1's documented B2 stubs — do not work around them**:
  `src/connection/environmentDriver.ts` `isThreadDetailSubscriptionNonIdle: () => false` and
  `applyThreadDetailEvent: () => undefined` (Task 4); `src/connection/environmentStateSink.ts`
  `prepareShellEvent`/`afterShellEventApplied`/`reconcileSnapshotDerivedState` no-ops
  (Task 4) and the provider-invalidation no-ops
  `markProviderInvalidationNeeded`/`flushProviderInvalidation` (Task 5);
  `src/state/composerDraftStore.ts` `hydrateImages: () => []` /
  `readPersistedAttachmentIds: () => []` (Task 4). The sink's `syncProjects`/`syncThreads`
  remain intentional no-ops — mobile has no UI store to sync — a recorded decision, not a
  gap.
- **Bound wrappers** for every new timer/lifecycle seam (the invalidation throttle, the
  outbox drain, server-state sync); **no import-time side effects** in wiring modules;
  singletons single-homed.
- Styling: copied screens keep upstream's uniwind `className` idiom — the token set already
  exists in B1's `global.css`, which also already ships the renamed `font-ryco-*` utilities.
  Update the copied `lib/typography.ts` (and any copied screen using `font-t3-*`
  classNames) to the existing `font-ryco-*` names — do not re-touch `global.css`. Liquid
  Glass stays gated on the single `NATIVE_LIQUID_GLASS_SUPPORTED` predicate; dark mode via
  the existing `userInterfaceStyle: automatic`; no manual insets (transparent headers +
  `contentInsetAdjustmentBehavior: automatic`).
- Persisted local prefs (appearance, client settings) use the injected KV storage
  (`mobileKV`, expo-sqlite) — never `localStorage`, never a second storage path.
- Toolchain: repo Bun, effect pinned via catalog `4.0.0-beta.59`; `apps/mobile` tests run
  with `vp` (vite-plus). **Never `bun test`.** Do not upgrade the workspace toolchain.
- No private detail anywhere (public repo); conventional per-task commits;
  `git diff --check` before each commit; stage only named paths.

## Non-goals (B2)

- **B3**: EAS profiles, ASC app record, TestFlight, OTA channels, launch runbook.
- **Hosted passkeys / hosted-Hub mode**: blocked on workstream C. `mobilePasskeyCeremony`
  stays a stub that throws "hosted mode not available"; hosted surfaces render only behind
  the (off) hosted-mode switch.
- **Terminal** (`ryco-terminal` module does not exist in B1) and the file browser — v1.1.
  `ThreadTerminal`/`ThreadFiles`/`ThreadFile` routes are not registered.
- **Git action sheets** (`Git*` routes): "MVP shows diffs, not the full git action set."
- **Push / agent-awareness / widgets / share / quick actions / showcase** — omitted per the
  spec strip list (the `expo-notifications` config plugin stays; no JS notification wiring).
- **Android tuning**: cross-platform code and the spec-named Android divergences
  (fullScreenModal review-comment sheet, markdown JS fallback, expo-blur backdrops) are
  implemented, but no Android QA — iOS ships first.
- Routes absent from the spec's MVP table (upstream `NewTaskSheet` stack, `SettingsLegal`,
  `ConnectOnboarding`/waitlist, `SettingsArchive`) are omitted from the tree — with one
  sanctioned exception, the `NotFound` `"*"` linking catch-all (Task 2).

## Task 1 — Screen-critical patches + native JS wrappers + shared primitives

- Port the screen-critical upstream `patches/` into the repo root patch set and wire them in
  `package.json`: `@legendapp__list@3.2.0.patch` (ThreadFeed's
  `contentInsetEndStaticAdjustment`), `@react-navigation%2Fnative-stack@7.17.6.patch`
  (`unstable_header*Items`, `unstable_navigationItemStyle`, glass headers),
  `react-native-screens@4.25.2.patch`, `react-native-keyboard-controller@1.21.13.patch`,
  `react-native-gesture-handler@2.31.2.patch`, `@react-native-menu__menu@2.0.0.patch`,
  `@pierre%2Fdiffs@1.3.0-beta.5.patch`, `expo-modules-jsi@56.0.10.patch`,
  `react-native-nitro-modules@0.35.9.patch`. **Do not** port upstream's
  `effect@4.0.0-beta.78` / `@effect__vitest` patches — the workspace pins catalog
  `4.0.0-beta.59`.
- **`@pierre/diffs` decision (deliberate divergence)**: the workspace catalog pins `1.1.20`
  (shared with `apps/web`), but the upstream patch — and the review/diff code Tasks 4–5
  copy — were written against `1.3.0-beta.5`. Pin `apps/mobile/package.json` to
  `1.3.0-beta.5` directly (replacing `catalog:`), leaving `apps/web` on the catalog's
  `1.1.20` untouched; port upstream's `"@pierre/diffs>@shikijs/transformers": ^4.2.0`
  override alongside it; the patch entry is keyed `@pierre/diffs@1.3.0-beta.5` and applies
  to mobile's resolution. Document the divergence in the mobile `UPSTREAM.md` notes and
  commit the resulting `bun.lock` update in this task. This is a version divergence inside
  the existing dependency set — no new npm packages are added for the MVP screens.
- **`expo-modules-jsi`**: the upstream patch is keyed `56.0.10` (upstream pins that version
  exactly via a pnpm override), but B1's lock resolves `56.0.12` — rebase the patch onto
  `56.0.12`; if it does not rebase cleanly, port the exact-pin override instead and document
  it. All other listed patch versions match B1's lock exactly (legendapp list 3.2.0,
  native-stack 7.17.6, screens 4.25.2, keyboard-controller 1.21.13, gesture-handler 2.31.2,
  menu 2.0.0, nitro-modules 0.35.9) — the gesture-handler patch applies as-is, no rebase.
  Verify every patch applies against the resolved version before committing.
- Copy `apps/mobile/src/native/` from upstream, renamed to Ryco view names:
  `StackHeader.tsx` (`NativeHeaderToolbar` — requires the patched native-stack),
  `ComposerEditor.{tsx,ios.tsx,native.tsx,android.tsx,types.ts}` (from `T3ComposerEditor.*`;
  `requireNativeView("RycoComposerEditor")`; TextInput/expo-paste-input fallback),
  `composerEditorRevision.ts` (native echo suppression), `HeaderButton.android.tsx` (from
  `T3HeaderButton.android.tsx`; `requireNativeView("RycoNativeControls")`),
  `KeyboardCommands.{tsx,ios.tsx}` (`requireNativeView("RycoKeyboardCommands")`),
  `SelectableMarkdownText.{tsx,ios.tsx}` (wraps `@ryco/mobile-markdown-text/renderer`,
  injecting the shiki `highlightCodeSnippet`; base file stays the null/nitro-markdown
  fallback), `native-glass.ts` (`NATIVE_LIQUID_GLASS_SUPPORTED`), `scrollEdgeEffects.ts`,
  `nativeViewResolutionError.ts`.
- Copy `src/components/` primitives: `AppText`, `AppSymbol`, `AndroidScreenHeader`,
  `AndroidAnchoredMenu`, `ComposerAttachmentStrip`, `ComposerToolbarTrigger`,
  `ConfirmDialogHost`, `ControlPill`, `CopyTextButton`, `EmptyState`, `ErrorBanner`,
  `GlassSafeAreaView`, `GlassSurface`, `LoadingScreen`, `LoadingStrip`, `OverlayPortal`,
  `ProjectFavicon`, `ProviderIcon`, `SourceControlIcon`, `StatusPill`, and the
  `ComposerEditor.tsx` re-export. Drop `BrandMark`/`T3Wordmark` (brand); replace usages with
  a Ryco wordmark placeholder.
- Copy `src/lib/`: `cn.ts`, `layout.ts`, `adaptive-navigation.ts`, `time.ts`,
  `typography.ts` + `useFontFamily.ts` (class references updated to the `font-ryco-*`
  utilities already in B1's `global.css`), `useThemeColor.ts`, `useNativePaste.ts`,
  `copyTextWithHaptic.ts`, `modelOptions.ts`, `providerOptions.ts`, `repositoryGroups.ts`,
  `uuid.ts`; `scopedEntities.ts` becomes a re-export of `@ryco/client-runtime/scoped`. Drop
  `lib/runtime.ts` and `authClientMetadata.ts` (cloud).
- **Acceptance:** `bun install --frozen-lockfile` applies all patches cleanly against the
  committed lock (including the `@pierre/diffs` pin update); `bun typecheck` clean;
  `vp test run` green; both strip greps clean per the execution-rule scoping (attribution
  files excluded); `rg 'requireNativeView' apps/mobile/src` shows only Ryco module names.

## Task 2 — Navigation shell (Stack, App root, linking, adaptive layout)

- Copy upstream `src/Stack.tsx` and prune the static tree to the spec's MVP route table plus
  the `NotFound` catch-all (`createNativeStackNavigator({screens})` +
  `createNativeStackScreen` + `createStaticNavigation`): **Home** (linking `""`, card,
  `GLASS_HEADER_OPTIONS`), **Thread** (linking `"threads/:environmentId/:threadId"`, **flat
  in the root stack** — required for the iOS-26 shared-header morph; card, glass header),
  **ThreadReview** (`…/review`, card, `SOLID_HEADER_OPTIONS`), **ThreadReviewComment**
  (`…/review-comment`, formSheet `sheetAllowedDetents [0.55, 0.92]` on iOS /
  `fullScreenModal` on Android, `sheetGrabberVisible` non-Android), **Connections**
  (formSheet; Android card + `headerShown: false`), **ConnectionsNew** (card, per the spec
  table — a deliberate divergence from upstream's formSheet), **SettingsSheet** → nested
  `SettingsSheetStack` (iOS formSheet `[0.7, 0.92]`, Android card) with `Settings`,
  `SettingsEnvironments`, `SettingsEnvironmentNew` (reuses `ConnectionsNewRouteScreen`),
  `SettingsAppearance`, `SettingsClientStorage`, **Onboarding/SignIn** (formSheet; Task 6
  screen), **NotFound** (linking `"*"` — not in the spec's route table; retained
  deliberately as the required deep-link catch-all, the one sanctioned exception to the
  omit-if-not-in-table rule). Keep the `GLASS_HEADER_OPTIONS`/`SOLID_HEADER_OPTIONS`/
  `SHEET_SOLID_HEADER_OPTIONS` presets and the `WORKSPACE_OVERLAY_ROUTES` filter so sheet
  routes never enter the adaptive-layout pathname (spec: opening a sheet never disturbs the
  active thread). Drop all deferred routes (Non-goals).
- `RootStackLayout`: keep `HardwareKeyboardCommandProvider` (prune commands to
  back/review + the dynamic registry — no terminal/files/newTask), keep the thread-outbox
  drain mount point (hook lands in Task 4). Strip `ShowcaseCaptureCoordinator`,
  `ClerkSettingsSheetDetentProvider`, `useConnectOnboardingNavigation`,
  `useAgentNotificationNavigation` (push — deferred), `useAppShortcuts`, incoming-share.
- Copy `src/features/layout/` (`AdaptiveWorkspaceLayout.tsx`, `workspace-*`,
  `native-glass-header-items.ts`, `native-mail-search-toolbar.ts`) plus
  `src/features/threads/ThreadNavigationSidebar.tsx` for the tablet split view (upstream
  keeps it under `features/threads/`, not `layout/`), and `src/features/keyboard/`.
- Rewrite `src/App.tsx`: `AppProviders` (B1) + `AppearancePreferencesProvider` (copied from
  `features/settings/appearance/`, storage on `mobileKV`) + `BlurTargetView` +
  `Navigation = createStaticNavigation(RootStack)` with `appLinking.prefixes =
  [Linking.createURL("/"), "ryco://", "ryco-dev://", "ryco-preview://"]` (matching the
  per-variant `scheme`; keep the expo-development-client URL filter). Note: the plain
  `ryco*` schemes are B1's shipped per-variant schemes from `app.config.ts` and deliberately
  supersede the spec's "reverse-DNS schemes" wording in §7. Theme DarkTheme/DefaultTheme,
  `ConfirmDialogHost`, `OverlayPortalHost`, SplashScreen coordination. Strip
  `CloudAuthProvider` and `IncomingShareProvider`. Deep links carry
  `environmentId`/`threadId` params only — never credentials.
- Fill B1's `setActiveEnvironmentId` gap: the Thread route (on focus/param change) and
  environment selection call `useStore.getState().setActiveEnvironmentId(environmentId)`.
- Until Tasks 3–7 land, register thin placeholder route screens (`EmptyState`) so the tree
  compiles; keep B1's `PairingScreen` reachable behind ConnectionsNew's placeholder until
  Task 6 replaces it.
- **Acceptance:** typecheck clean; a `vp` unit test over the exported static config asserts
  the exact route set (the MVP table plus NotFound), the linking path strings, and per-route
  presentation/detents (flat Thread route, review-comment detents `[0.55, 0.92]`, Android
  `fullScreenModal`, sheets excluded from `WORKSPACE_OVERLAY_ROUTES`-filtered pathname);
  strip greps clean. Header morph/glass rendering is owner-Simulator-only.

## Task 3 — Home / thread list

- Copy `src/features/home/`: `HomeRouteScreen.tsx`, `HomeScreen.tsx` (LegendList,
  `ESTIMATED_THREAD_ROW_HEIGHT = 72`, no sticky headers, group collapse reducer),
  `HomeHeader.tsx` (strip `T3Wordmark`; keep `createNativeMailSearchToolbarItem` +
  `NativeHeaderToolbar`), `homeThreadList.ts`, `homeListItems.ts`, `home-list-options.ts`,
  `home-list-filter-menu.ts`, `workspace-connection-status.ts`,
  `WorkspaceConnectionStatus.tsx`, `thread-swipe-actions.tsx`, `useThreadListActions.ts`,
  `AndroidHomeFab.tsx` — plus `src/features/threads/thread-list-items.tsx`,
  `thread-list-v2-items.tsx`, `threadListV2.ts`, `threadPresentation.ts`, and every
  colocated upstream test.
- Rewire the data hooks (no atom runtime): author `src/state/homeData.ts` replacing
  upstream's `useProjects`/`useThreadShells`/`useWorkspaceState`/
  `useSavedRemoteConnections` with `useStore(selectSidebarThreadsAcrossEnvironments)`,
  `selectProjectsAcrossEnvironments`, `selectSidebarWorktreesForProjectRef(s)`,
  `selectProjectByRef`, `selectBootstrapCompleteForActiveEnvironment`, and
  `useSyncExternalStore` over `registry.catalog.registryStore`/`runtimeStore` (they are
  plain `StoreApi`s, not hooks). Stub `usePendingNewTasks` to an empty list (NewTask routes
  are not in the MVP table). Thread actions get their api via
  `registry.driver.supervisor.read(environmentId)?.client`.
- Connection-status obligation (spec §"Bundling" finding: "the connection UI must present
  reconnecting state clearly"): drive `WorkspaceConnectionStatus` from
  `useWsConnectionStatus()` + `getWsConnectionUiState` and the catalog runtime store's
  `connectionState`, with a visible `reconnecting`/`connecting` presentation on Home.
- **Acceptance:** copied `homeThreadList`/`homeListItems` tests green under `vp test run`;
  a new unit test seeds `useStore` with two environments + catalog records and asserts
  grouped rows and a `reconnecting` status row; typecheck clean; strip greps clean. Scroll
  feel and glass header are owner-Simulator-only.

## Task 4 — Thread detail: subscription wiring, timeline, composer, send

- **Close the driver stubs** in `src/connection/environmentDriver.ts`:
  - `isThreadDetailSubscriptionNonIdle` → copy the web predicate verbatim
    (`apps/web/src/environments/runtime/service.ts:231–277`
    `isNonIdleThreadDetailSubscription`) over `useStore` +
    `selectSidebarThreadSummaryByRef`/`selectThreadByRef` (pending
    approvals/user-input/actionable plan, non-idle `orchestrationStatus`, running
    `latestTurn`).
  - `applyThreadDetailEvent` → new `src/connection/threadDetailEvents.ts` mirroring web
    `applyRecoveredEventBatch` (`service.ts:611–662`): `deriveOrchestrationBatchEffects`
    from `@ryco/client-runtime/state/orchestration`, a copied
    `coalesceOrchestrationUiEvents` (`service.ts:563–598` — web-local today; copy and flag
    as a hoist candidate to client-runtime, do not fork the effects derivation),
    `environmentStateSink.applyOrchestrationEvents`, `markPromotedDraftThreadByRef`,
    `clearThreadDraft`/`clearTerminalState`, then
    `supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment`.
- **Close the sink stubs** in `src/connection/environmentStateSink.ts` on the web template
  (`apps/web/src/environments/runtime/environmentStateSink.ts`): implement
  `prepareShellEvent` and `afterShellEventApplied` (draft promotion via
  `markPromotedDraftThreadByRef` on `thread-upserted`; `disposeThreadDetailSubscription` +
  draft/terminal cleanup on `thread-removed`) and `reconcileSnapshotDerivedState`
  (terminal-state reconciliation), wired to the supervisor through the same
  `input.supervisor` seam as the invalidation throttle — live shell events must get the
  same promotion/cleanup/eviction treatment as the recovered-batch path above.
  `syncProjects`/`syncThreads` stay intentional no-ops (no mobile UI store — a decision,
  not a gap).
- `src/connection/environmentApi.ts`: `readEnvironmentApi`/`ensureEnvironmentApi` via
  `createEnvironmentApi(supervisor.read(environmentId)?.client)`
  (`apps/web/src/environmentApi.ts` template).
- Copy the screens (with tests): `ThreadRouteScreen.tsx` (strip the terminal menu and
  files/git header items), `ThreadDetailScreen.tsx`, `ThreadFeed.tsx`
  (`KeyboardAwareLegendList` with the patched `contentInsetEndStaticAdjustment` and iOS-26
  content-inset math, fresh-timestamp animation guard, renderItem-closure invalidation
  workaround), `ThreadComposer.tsx` (strip the single
  `armAgentAwarenessLiveActivityForLocalWork` import; keep the `LiquidGlassView` pill),
  `PendingApprovalCard.tsx`, `PendingUserInputCard.tsx`, `ComposerCommandPopover.tsx`,
  `thread-work-log.tsx`, `threadContentPresentation.ts`, `markdownCodeHighlightState.ts`,
  `lib/threadActivity.ts` + its test, `lib/composerImages.ts` (expo-image-picker →
  `mobileAttachmentCodec` inputs). Also copy `src/features/diffs/`
  (`nativeReviewDiffSurface.ts` — retarget to `requireNativeView("RycoReviewDiffSurface")`,
  B1's registered name for upstream's `T3ReviewDiffSurface` —
  `nativeReviewDiffHighlighter.ts`, `nativeReviewDiffTypes.ts`): ThreadFeed's inline diff
  previews consume them. Also copy — moved forward from Task 5 so this task typechecks
  (ThreadFeed imports them directly) — the pure review modules
  `features/review/reviewModel.ts`, `reviewCommentSelection.ts`,
  `nativeReviewDiffAdapter.ts`, `shikiReviewHighlighter.ts`, and their direct pure deps
  (`diffParser.ts`), with colocated tests.
- The Thread screen retains the supervisor subscription while mounted (spec Thread-row
  requirement): `useEffect(() => retainThreadDetailSubscription(environmentId, threadId),
  [environmentId, threadId])` per `apps/web/src/components/ChatView.tsx:843–848`, via a thin
  `src/connection/threadDetail.ts` wrapper over `registry.driver.supervisor`.
- Timeline: `deriveThreadActivityViewModel` + `deriveTimelineEntries` from
  `@ryco/client-runtime/state/session` (ChatView ~1349–1500 consumption template); this
  covers the spec's plan derivation — `ActivePlanState`/`LatestProposedPlanState` and
  `"proposed-plan"` timeline entries flow through the view model into the copied feed
  presentation; feed presentation stays upstream's `threadActivity.ts`.
- Composer: adapt upstream `state/use-thread-composer-state.ts` + `use-composer-drafts.ts`
  onto B1's `useComposerDraftStore`. **Close the image-hydration stub** in
  `src/state/composerDraftStore.ts`: `hydrateImages` decodes
  `PersistedComposerImageAttachment.dataUrl` into `MobileComposerImageAttachment`
  (`previewUrl` = dataUrl, no `File`); implement `readPersistedAttachmentIds`.
- Send: `src/features/threads/executeSendTurn.ts` mirroring
  `apps/web/src/hooks/executeChatSendTurn.ts` — snapshot → `newMessageId` →
  `mobileAttachmentCodec.encode` → `buildSendTurnDispatchAttachment` → optimistic user
  message → clear draft → `resolveThreadCreateModelSelection` + `buildSendTurnBootstrap` →
  `commitSendTurnDispatch(api)` → rollback + `setThreadError` on failure. Omit web-only
  pieces (blob revocation, undo window, `ChatComposerHandle` cursor, toasts).
- Queue/outbox: port `state/thread-outbox{,-manager,-model,-storage}.ts` +
  `use-thread-outbox-drain.ts` onto `useMessageQueueStore`; drain on reconnect via
  `mobileAppLifecycle`/`wsConnectionStatusAtom` (spec: "offline outbox drains on reconnect
  via `AppLifecycle`"); mount the drain hook in `RootStackLayout`.
- Approvals/user-input: copy web `apps/web/src/hooks/chatSessionActions.ts` (pure) →
  `src/features/threads/sessionActions.ts` (`interruptThreadTurn`,
  `respondToThreadApproval`, `respondToThreadUserInput`, `revertThreadToTurnCount` with the
  guard adapted to `ConfirmDialogHost`); question progress from
  `@ryco/client-runtime/state/user-input`.
- **Acceptance:** typecheck clean; `vp test run` green including: the copied
  `threadActivity` test; the moved `reviewModel`/`reviewCommentSelection`/`diffParser`
  tests; a driver test (extending `environmentDriver.test.ts`) where a fake
  `subscribeThread` emits snapshot + events and asserts messages land in `useStore` and the
  non-idle predicate holds a running thread at refCount 0; a sink test asserting
  `afterShellEventApplied` promotes a draft on `thread-upserted` and disposes the detail
  subscription + clears draft/terminal state on `thread-removed`; a timeline test covering
  a `proposed-plan` entry flowing through the view model; a send test with a fake api
  asserting dispatch order (`thread.meta.update` on first server-thread message →
  `thread.turn.start`) and that rollback restores prompt/images; an image-hydration
  round-trip test. Additionally, the names at `rg 'requireNativeView' apps/mobile/src` call
  sites must match the `Name("…")` strings registered in `modules/*/ios` one-for-one.
  Composer feel, keyboard, streaming, and the glass pill are owner-Simulator-only.

## Task 5 — Review/diff: native canvas, keyed-query cache, comment sheet

- **The §6 cache**: `src/rpc/checkpointDiffAtoms.ts` mirroring
  `apps/web/src/rpc/providerAtoms.ts` (the exact diff template): `checkpointDiffCacheKey`,
  `decodeCheckpointDiffRequest` (`fromTurnCount === 0` → `getFullThreadDiff`, else
  `getTurnDiff`), `Atom.family` keepAlive state atoms registered in `appAtomRegistry` (B1's
  `RegistryContext` is already mounted), ref-counted `watchCheckpointDiff` with
  generation-fenced fetch, staleTime-Infinity semantics (background refetch keeps previous
  data), the checkpoint retry policy (12 retries when checkpoint-not-ready, else 3; backoff
  cap 5s), `invalidateCheckpointDiff`/`invalidateAllCheckpointDiffs`/
  `clearCheckpointDiffState`; requests via `ensureEnvironmentApi`.
- **Close the invalidation no-ops**: `src/connection/environmentStateSink.ts`
  `markProviderInvalidationNeeded`/`flushProviderInvalidation` →
  `invalidateAllCheckpointDiffs`; replace the driver's `createNoopThrottle` with a real
  setTimeout-based invalidation throttle (bound wrapper, no import-time side effects).
- Copy the rest of `src/features/review/` (with all colocated tests) — `reviewModel`,
  `reviewCommentSelection`, `nativeReviewDiffAdapter`, `shikiReviewHighlighter`, and
  `diffParser` already landed in Task 4 (ThreadFeed imports them): `ReviewSheet.tsx` (strip
  `markNativeShowcaseReady` + the `SHOWCASE_ENABLED` gate), `useReviewDiffData.ts`,
  `useReviewSections.ts`, `useNativeReviewDiffBridge.ts`,
  `useNativeReviewDiffHighlighting.ts`, `useReviewDiffPrewarming.ts`,
  `useReviewCommentSelectionController.ts`, `reviewState.ts`, `reviewWordDiffs.ts`,
  `reviewFileVisibility.ts`, `reviewHighlighterEngine.ts`/`reviewHighlighterState.ts`,
  `reviewDiffBridgeKeys.ts`, `reviewPaneSelection.ts`, `review-section-menu.ts`,
  `reviewAvailability.ts`, `reviewDiffRendering.tsx`, `reviewPerf.ts`,
  `ReviewHighlighterProvider.tsx`.
- Data path per spec: `TurnDiffSummary` from `thread.turnDiffSummaries` +
  `inferCheckpointTurnCountByTurnId` (state/session); rows from the `@pierre/diffs` parser
  (patched, at the Task-1 pinned `1.3.0-beta.5` the copied code was written against); shiki
  tokens patched into the visible range; the native surface receives large JSON via the
  view AsyncFunctions `setRowsJson`/`setTokensJson`/`setTokensPatchJson` — never as props.
- `ReviewCommentComposerSheet.tsx`: copy as-is (plain `AppTextInput` in the expo-paste-input
  wrapper — not the native composer); `useReviewCommentTarget`/`clearReviewCommentTarget`;
  `appendReviewCommentToDraft` adapted onto Task 4's composer state (spec: "Comment composer
  appends to the thread draft").
- **Acceptance:** typecheck clean; `vp test run` green including the copied review tests
  for this task's modules (highlighter state, `reviewWordDiffs`, visibility — the
  `reviewModel`/`reviewCommentSelection`/`diffParser` tests ran in Task 4) and a new cache
  test: `watchCheckpointDiff` with a fake api caches by key, routes `fromTurnCount 0` to
  `getFullThreadDiff`, and invalidation refetches while retaining previous data;
  `rg 'T3ReviewDiffSurface|SHOWCASE'` over `apps/mobile/src` returns nothing
  (`T3ReviewDiffSurface` is upstream's name for the view B1 registers as
  `RycoReviewDiffSurface` — this grep enforces that rename on every copied call site).
  Canvas scroll/pull-to-refresh feel is owner-Simulator-only.

## Task 6 — Connections management + Onboarding/SignIn

- Author `src/connection/environmentActions.ts` mirroring
  `apps/web/src/environments/runtime/service.ts`: `addSavedEnvironment`
  (`resolveRemotePairingTarget` → `fetchRemoteEnvironmentDescriptor` pre-auth → registry
  snapshot → `bootstrapRemoteBearerSession` → persist record → `writeBearerToken`; on write
  failure roll the registry back and throw `"Unable to persist saved environment
  credentials."` → upsert → `ensureSavedEnvironmentConnection`),
  `reconnectSavedEnvironment`, `disconnectSavedEnvironment`, `removeSavedEnvironment`
  (disconnect + `disposeThreadDetailSubscriptionsForEnvironment` + registry.remove +
  runtime.clear + `useStore.getState().removeEnvironmentState` + `removeBearerToken`),
  rename + `refreshSavedEnvironmentMetadata` (`client.server.getConfig` +
  `fetchRemoteSessionState` → `registry.rename(envId, serverConfig.environment.label)` +
  runtime patch), and the web error surfaces verbatim (missing credential →
  `requires-auth` patch + `"Saved environment is missing its saved credential. Pair it
  again."`; 401 on refresh → drop token + `"Saved environment credential expired. Pair it
  again."`). Note: the route table's `createPrimaryAuth` pairing cell is superseded by the
  spec's own auth-story section ("direct-node bearer … the MVP's primary connection path")
  and B1's shipped bearer pairing — mobile has no primary-origin environment, so
  `createPrimaryAuth` is deliberately not used.
- Copy `src/features/connection/`: `ConnectionsRouteScreen.tsx`,
  `ConnectionsNewRouteScreen.tsx` (`CameraView` + `useCameraPermissions` QR scan — the
  expo-camera plugin with `barcodeScannerEnabled` is already configured — plus host+code
  inputs), `pairing.ts` (rename the `t3code:` QR scheme to `ryco`/`ryco-dev`/`ryco-preview`
  — B1's shipped per-variant plain schemes, deliberately superseding the spec's
  "reverse-DNS" §7 wording, matching Task 2's linking prefixes; bind
  `readHostedPairingRequest: () => null` — hosted pairing is C-gated),
  `ConnectionEnvironmentRow.tsx`, `ConnectionStatusDot.tsx`, `ConnectionSheetButton.tsx`,
  `EnvironmentConnectionNotice.tsx`, `connectionTone.ts`, `environmentSections.ts`;
  `useConnectionController.ts` stripped of `relayEnvironmentDiscovery`/relay-contract
  imports. Drop `CloudEnvironmentRows.tsx`. Adapt
  `state/use-remote-environment-registry.ts` onto the catalog `StoreApi`s
  (`useSyncExternalStore`) + `environmentActions`.
- Onboarding/SignIn (spec route): author
  `src/features/onboarding/OnboardingRouteScreen.tsx` (formSheet) — presented on first run
  when the catalog has no saved environments; direct-node pairing reuses the ConnectionsNew
  flow; the hosted passkey SignIn surface renders only behind the hosted-mode switch and is
  inert (`mobilePasskeyCeremony` throws "hosted mode not available") — it activates with C,
  with no dead Clerk code.
  **[stale, 2026-07-26 — the first-run presentation never shipped and will not from this
  route. L3 repurposed `Onboarding` as the hosted sign-in sheet (`HostedSignIn`), reached on
  demand from `HubNodeSection.tsx:328` and `HostedAccountRouteScreen.tsx:88`. A new
  direct-plane user gets Home's empty state → "Pair a device" → `ConnectionsNew`; there is no
  first-run welcome. The passkey ceremony is no longer inert.]**
- Take-once invariant: an initial-URL pairing token is consumed once via
  `mobilePairingCredentialSource` and cleared; deep links never carry credentials.
- Call `useStore.getState().setActiveEnvironmentId` after successful pair/selection. Delete
  `src/features/pairing/PairingScreen.tsx` and its placeholder mount (fully replaced).
- **Acceptance:** typecheck clean; `vp test run` green including `environmentActions` tests
  with fake remoteApi/catalog (pairing persists record + token and upserts; token-write
  failure rolls back and throws the exact message; remove clears store/runtime/token) and a
  QR-payload test accepting `ryco*` schemes and extracting tokens take-once; `rg 't3code'`
  over `apps/mobile/src` clean. Camera QR cannot be proven on the Simulator — owner
  validates on device; the URL/host+code path is owner-Simulator-only.

## Task 7 — SettingsSheet + appearance

- Copy `src/features/settings/`: `SettingsRouteScreen.tsx` **stripped heavily** (remove
  Clerk `useAuth`/`useUser`, push registration, `managedRelayState`,
  `ClerkSettingsSheetDetent`, cloud `publicConfig`; keep the SettingsRow/Section skeleton +
  environments/appearance/client-storage rows; the hosted account surface renders only when
  hosted mode is enabled — inert until C), `SettingsEnvironmentsRouteScreen.tsx` (strip
  `CloudEnvironmentRows`/`hasCloudPublicConfig`/showcase rows; keep the local
  `ConnectionEnvironmentRow` path), `SettingsAppearanceRouteScreen.tsx` + `appearance/*`
  (`FontSizeSliderRow`, `AppearancePreviews`, the three sections, `useScaledTextRole`,
  `useAppearanceCodeSurface`; the provider itself landed in Task 2),
  `SettingsClientStorageRouteScreen.tsx`, `components/SettingsRow.tsx`,
  `SettingsSection.tsx`, `SettingsSwitchRow.tsx`, `settings-sheet-targets.ts`. Drop
  `SettingsAuth`/`SettingsWaitlist`/`SettingsLegal`.
- Server settings data (per-environment caveat — web's `serverConfigAtom` is
  primary-scoped): run `startServerStateSync(connection.client.server)` for the single
  active environment with start/stop bound to the connection lifecycle (bound wrapper, no
  import-time side effects), or read `catalog.runtimeStore.byId[envId].serverConfig`/
  `descriptor` for saved-environment rows. Writes via `client.server.updateSettings` with
  optimistic `applySettingsUpdated` per the web `useSettings.ts` split-patch template;
  client-side settings keys persist to `mobileKV` (no `ensureLocalApi`, no localStorage).
- Local appearance prefs persist through the injected KV storage; applying them touches RN
  styles only (no DOM/CSS-var machinery from the web implementation).
- **Acceptance:** typecheck clean; `vp test run` green including a settings patch-routing
  test (server keys → `updateSettings` + optimistic apply; client keys → `mobileKV`) and an
  appearance-preference persistence round-trip through a fake KV; strip greps clean. Live
  appearance changes and sheet detents are owner-Simulator-only.

## Task 8 — Agent gates, evidence, PR (orchestrator)

- Agent-runnable gates: `bun install --frozen-lockfile` (all ported patches apply),
  `bun typecheck` (mobile included), `bun run --cwd apps/mobile test` (`vp test run`), the
  `expo prebuild`/EAS `--local` config-and-native-resolution check, and the sweeps:
  `rg -i 't3tools|t3code|clerk|pingdotgg|ARK85ZXQ4Z|6787819824|d763fcb8|axiom'` and
  `rg '\bT3[A-Z]|@t3tools'` clean over `apps/mobile/src`; over the rest of `apps/mobile`
  the only allowed matches are the MIT attribution files (`NOTICE.md`,
  `modules/*/UPSTREAM.md`, `modules/*/LICENSE`) — B1's intentional, documented residue,
  which must not be stripped. Review the full diff for MIT notices on every newly copied
  file, unrelated changes, the deliberate `@pierre/diffs` pin divergence (and nothing else
  touching `apps/web`), and boundary violations.
- **Owner Simulator acceptance for B2 as a whole** (interactive QA is the owner's; agents
  must not fabricate device evidence): on a dev-client build against a local node — pair via
  URL and via host+code; Home lists projects/threads with live connection status; open a
  Thread (shared-header morph), watch a streaming turn, send a message with an image
  attachment, answer an approval and a user-input card; open Review, scroll the native diff
  canvas, add a review comment and see it appended to the thread draft; change appearance
  prefs in Settings; background/foreground the app and see a clearly presented reconnecting
  state followed by recovery, with a queued offline message draining on reconnect.
- State in the report: the web parity moment — the frozen Liquid Glass web phone tier
  becomes a candidate for retirement only **after** B2 ships (owner QA passed, PR merged);
  B2 notes this, it does not act on it.
- PR `feat/mobile-b2-screens` → `main` in `sak0a/ryco`; conventional commits; wait for CI
  and review; no private detail in the PR body.
