# Ryco performance re-check — implementation plan (2026-10-15)

Base: `ec250e386`. Source: `output/perf-recheck-2026-10-15/ryco-performance-recheck.html`.

Process per work package: isolated detached worktree → Opus implementer (tests included) → independent Opus adversarial verifier → fix round → merge onto one branch → full repository backstop (fmt, lint, typecheck, test, build, web browser suite, build:desktop). Nothing is pushed.

Rules: root-cause fixes in shared modules; hosted lifecycle ownership, E2EE and auth semantics unchanged; the frozen web phone tier is not extended; existing tests are never weakened.

## WP01 · Claude/provider session correctness

Area: apps/server/src/provider (Claude/Copilot/Cursor/Grok/OpenCode adapters, text generation, ProviderService skills cache, usage probes)

- **#140** Per-turn attachment-instructions prefix turns '/compact' and every Claude slash command into a plain prompt Restores native compaction — all
- **#143** ~230-token ASSISTANT_ATTACHMENT_INSTRUCTIONS is prepended to every user message -230 input tokens per turn and about -23k context tokens per — all, incl. fixing ClaudeAdapter.test.ts which asserts the wrong field; first-turn adapters re-delivering after provider auto-compaction only if cheap
- **#179** Skills and provider slash commands come from a global probe at the server's cwd, so project-level skills and commands for the active thread  — fix defect: never cache a failed/timed-out skills probe as an empty success; keep last good list
- **#20** Every boot runs cold capability probes for every enabled provider: 15 child processes, ~1.9 GB peak process-tree RSS, and Claude Code creden — Part A for Claude and OpenCode only: cheap usage-only refresh (no SDK session, no --version, no opencode serve) so adopted capability snapshots stay fresh for 6 h while usage keeps its 5-minute freshness. Codex behaviour unchanged. Must NOT make usage limits staler than today, and must keep CLIProxyAPI/per-subscription usage working
- **#138** Title and branch-name generation spawn full-config provider CLIs alongside the session boot Per first turn: -4 CPU-s and -1.1 to -1.2 GiB tr — bounded timeouts + abort for Copilot/Cursor/Grok/OpenCode title/branch generation; light mode where the provider supports it; Copilot honours includeBranch if simple
- **#149** Session-start hangs surface only after 120-300 s; Cursor's default binary name collides with another CLI Failure feedback in 15-30 s instead — item 2 only: Cursor maintenance update and user-facing hints must use the resolved Cursor binary, never a bare `agent` that may resolve to another tool

## WP02 · Turn start, prewarm, checkpoints and history recovery

Area: apps/server/src/orchestration (ProviderCommandReactor, CheckpointReactor, ProviderSessionPrewarm, historyRecoveryPolicy, ProviderRuntimeIngestion), apps/server/src/provider/Layers/ProviderSessionReaper.ts

- **#144** sendTurn does not wait for the pre-turn baseline — fix both defects: a Stop noted during joinPreTurnBaseline must cancel the start; the baseline-timeout activity must stay visible
- **#141** Pre-warm the provider session — Part A only (server-side computer-use turn must not claim a prewarmed session). Web/mobile client parts are in WP10/WP14A
- **#254** Each open thread subscription polls provider history every ~30 s forever; failures are logged without a cause — fix defect: a dropped turn.completed on a live runtime must be repaired again while the thread stays open (bounded, event-driven, no 30 s polling storm)
- **#145** CheckpointReactor loads the full thread detail 3x per turn start — do not decode checkpoint_files_json where no caller reads .files
- **#104** Every thread subscription polls Codex history every 30 s, spawning a codex app-server and loading the full unbounded thread detail before ch — interrupted history read should still honour spacing (minor)
- **R1** Reaper keep-alive for viewed threads — R1 (from theme 8, not a single finding): ProviderSessionReaper must not reap a session for a thread that currently has an active detail subscriber/viewer; keep the 5-minute reaper for unviewed threads and keep a hard cap so memory stays bounded

## WP03 · Server boot, startup attribution and shutdown

Area: apps/server/src (server.ts, bin.ts, cliMain, serverRuntimeStartup, startupStallMonitor, desktopLifecycle frames, os-jank, httpStartupGate, webSocketCompression, hubConnector service gating), patches/@effect%2Fplatform-node@4.0.2.patch, apps/desktop/scripts/boot-report.mjs (frame consumer only)

- **#5** Startup timing misses main-module load and time-to-usable-shell; proposed measurement plan Makes the three dominant costs — forward migration/ledger/repair, provider.instance.create and server.startup.* phases over fd 4 with durations; boot-report reads them
- **#2** Real-world boot is dominated by 3–15 s backend stalls before 'Listening'; the listener waits behind provider creation and migrations p90 tim — Part A (attribution of hydration/read-model/agent-control/auth layer builds) and Part D (async Cursor/Copilot maintenance-capability resolution) only. No upgrading-data UI, no migration reordering
- **#18** Synchronous interactive login shell blocks the event loop at every web/CLI boot, and its timeout cannot stop a hanging .zshrc Saves 160–200  — fix defects: negative cache + background retry for a login shell slower than 1.5 s (async refresh off the critical path may use a longer bound); avoid synchronous PowerShell before listen on win32
- **#25** In web/headless mode, provider driver construction blocks HTTP listen — the on-demand registry fallback must not build every driver on the listen path
- **#32** Graceful shutdown waits the full 20 s gracefulShutdownTimeout whenever a WebSocket — on graceful-shutdown timeout also destroy upgraded WebSocket sockets that never answered the 1001 close (Node drops them from closeAllConnections)
- **#117** WebSocket compression is off; large snapshots to remote and saved environments travel uncompressed — item 1 only: /ws/device-frames must never negotiate permessage-deflate; policy installed in all modes
- **#30** Hub connector identity runtime — Hub routes waiting on custody: bounded wait then 503 + Retry-After; fix the stale comment (also covers #40)
- **#38** With no clients, graceful shutdown still takes 1.0-1.5 s — stale comments about a 2 s SIGKILL (grace is 3 s)
- **#21** Enable the V8 compile cache for the backend — RYCO_COMPILE_CACHE_DIR must not leak into provider/agent/terminal child envs (also covers #3)
- **#24** Idle RSS of 340–360 MiB: V8 young generation grows to 128 MiB during boot and never shrinks About 50–60 MiB less steady idle RSS per backend — apply --max-semi-space-size=16 for CLI/serve/SSH-runner entries where it can be done safely (re-exec guard or NODE_OPTIONS for spawned long-lived servers); document it. Skip with a note if it cannot be done without a re-exec penalty
- **#28** About 4.7 MiB of the 8.1 MiB bin.mjs is feature or protocol code evaluated at boot — do not load the Hub/E2EE connector graph when hubConnector is disabled; lazy-load the cheap-to-split static serve-closure modules listed (device host, htmlRender, Atlassian/Jira, ExternalMcp, Forgejo) only where it is a mechanical dynamic import
- **#26** Server build: bundle effect and pure-JS deps, strip JSDoc/escape non-ASCII, stop emitting the unused CJS build Estimated 40–60 ms less modul — make the built-server bundle boundary suites actually run in CI (turbo/test dependency or a dedicated CI step)

## WP04 · Desktop main process

Area: apps/desktop/src (main.ts, backendPort.ts, backendStartup*, backendAppWindowLoad.ts, desktopHostedIdentity.ts), packages/shared/src/logging.ts (rotation pruning only)

- **#0** Deterministic backend start failures are retried forever while the window stays on the splash — missing server entry / missing bootstrap pipe must go through backendFailurePolicy, not retry forever
- **#4** Renderer origin follows the first free port from 3773, which T3 Code also uses; origin flips split caches and localStorage Avoids fully cold — Part A only: renderer-origin record in userData written right after port selection; no migration of existing installs
- **#7** Renderer cannot fetch or parse any app JS until the backend listens; the ryco:// origin with codeCache is registered but unused Overlaps ~0. — Step 1 only: no blank window on a pending early app load; age early loads from document commit
- **#9** Readiness depends on a stdout log substring plus a 100 ms HTTP poll that lands in the server's pre-listen dead window Removes 10–150 wasted  — no-tracker readiness path should not poll HTTP from t=0
- **#12** Sync main-thread work before the window and spawn: duplicate dock icon, LaunchServices write, PlistBuddy, sync log sink ~25–60 ms earlier fi — skip the synchronous dock.setIcon when the bundle icon already matches; do not await computer-use start before the envelope/window
- **#16** Hub/workspace resume waits for backend listening, runs sequential Hub RTTs, and spawns a helper process per signature Hub/device catalog rea — start the account-session-only parts of hosted identity resume (credentials flush, enrollment ensure, GitHub state) before backend readiness; only #setup waits
- **#39** After a backend crash-restart, desktop navigates the renderer back to the backend root — render-process-gone: drop the webContents from the usable set so a later crash-restart reloads it
- **#13** Main window uses the default v8CacheOptions; after each update, code cache kicks in only on the 3rd launch Code-cache hits one launch earlie — only if safe: keep V8 code cache for content-hashed chunks across version changes (filtered clearCodeCaches); otherwise leave and note
- **#258** Electron main writes backend stdout/stderr and its own console with synchronous appendFileSync — prune orphaned rotated log files beyond maxFiles (e.g. .7-.10 left by the old maxFiles=10)
- **#6** Electron main eagerly loads the whole Hub/E2EE/relay stack, the contracts barrel, effect and electron-updater before 'ready' −80–130 ms befo — desktop main bundle guard: also catch hoisted Hub/Computer-use schema bindings evaluated before ready (built-artifact check)

## WP05 · Persistence, projections and repository identity

Area: apps/server/src/persistence, apps/server/src/orchestration (projector, ProjectionSnapshotQuery, shellSnapshotPages), apps/server/src/project (RepositoryIdentityResolver, repositoryIdentitySync), apps/server/src/agentControl/AgentControlProjectPlans.ts, ws/context/worktreeOperations.ts (empty-list cache only), hubConnector/ThreadReadCachePublisher.ts

- **#49** The engine's in-memory read model holds text the decider never reads and grows with every message — command read model: retain only activity kinds the command model reads (plus required milestones); stop keeping checkpoint `files` in the live command model
- **#52** One synchronous connection on the main thread: heavy reads block the event loop and queue behind writes, and busy_timeout=5000 can freeze th — move clearly read-only heavy queries (getSnapshot for read RPCs, message search, history pages, event replay reads where safe) to the read-only worker connection; keep engine hydration and anything needing read-your-writes on the main connection; document the rule
- **#201** Repository identity is recomputed with 2 git spawns per project — fix defect: a transient identity probe failure (timeout/spawn error) must not be persisted as 'no repository'; keep the previous identity and retry soon (also covers #44)
- **#108** Every shell snapshot can wait on 2 git processes per project — AgentControlProjectPlans: use one identity source for expected vs revalidated keys
- **#43** The first subscribeShell after boot forks reconcileAllWorktrees, which builds 2×P+1 full shell snapshots — never cache an empty `git worktree list` answer under a valid fingerprint (also covers #106, #202)
- **#50** Per-thread correlated subqueries on every hydration and shell build — add a value-change WHEN guard to projection_turns_latest_completed_update (new migration, numbered after the highest existing one)
- **#54** SQLite runs with default page cache — set PRAGMA journal_size_limit (64 MiB) on the write connection
- **#56** The hub cloud thread index rebuilds the whole shell up to once per second while events flow, and throws once the shell exceeds about 2 MiB — ThreadReadCachePublisher: never upload thread bodies the bounded index does not list
- **#114** Shell snapshot is one unbounded JSON message — item (a) only: do not force archived threads into a separate snapshot message (extra ack RTT). Archived threads stay in the snapshot
- **#51** getShellSnapshot is used as a generic lookup by about 30 server-internal call sites, each paying the full build plus git probes 100-140 ms l — unscoped list_threads paging must not rebuild the whole shell per page

## WP06 · Statistics and usage

Area: apps/server/src/statistics, apps/server/src/usage, apps/web/src/components/statistics, apps/mobile/src/features/settings/statistics

- **#47** Statistics recompute everything — fix the stale-while-revalidate backgroundRefresh race
- **#184** getStatistics recomputes the whole history synchronously on the single SQLite connection, inside a transaction, on almost every open Removes — fix defect: scope the client statistics cache by environment; clear on hosted node switch/account teardown; show errors when a stale snapshot is displayed
- **#191** Dedicated pages use React.lazy inside the component: no intent/idle preload and no loader-started data, so the chunk and data load in sequen — prefetchStatisticsPage must not fetch activity statistics for the Limits view
- **#57** Usage scan cache is one JSON file — usage scan cache cap should count resident cost, not folded record counts
- **#93** Statistics summary blocks on an outbound 2.75 MB LiteLLM pricing fetch inside the scan lock, and retries it on every open after a failure — rates fetch: the 10 s timeout must not cover the background body read on slow links (separate connect/headers deadline, longer body budget)
- **#196** Transcript parser decodes and copies every line and lists files with serial lstat; 3.5x below the I/O floor Parsing changed or uncached tran — list transcript directories with bounded cross-directory concurrency
- **#190** Usage client: extra getConfig round trip per request, all-or-nothing Promise.all, no cross-mount cache, no cancellation -1 RTT — mobile usage: show partial results per node and cancel superseded range requests

## WP07A · Git status and VCS core

Area: apps/server/src/vcs (GitVcsDriverCore, GitVcsDriver, VcsProcess, VcsStatusBroadcaster, VcsDriverRegistry), apps/server/src/git (GitManager status paths, GitIndexReview), apps/server/src/workspace/WorkspaceChangeSummary.ts, packages/shared/src/logOnceEvery.ts

- **#199** Background git status reads run without GIT_OPTIONAL_LOCKS=0, so they rewrite .git/index and take index.lock while agents run git in the sam — status numstat diffs must not take .git/index.lock (e.g. -c diff.autoRefreshIndex=false / plumbing), incl. WorkspaceChangeSummary
- **#200** On Windows, the repository identity probe goes through shell: true with unquoted -C <workspaceRoot> , so roots containing spaces never get a — Windows: do not taskkill a git child that has already exited
- **#198** The first remote-status load per repo blocks on a network git fetch — first remote status with polling enabled must not block on the network fetch; no-fetch loads must not await an in-flight fetch
- **#204** Local status resolves the base branch twice and does one spawn per config/ref lookup; remote status recomputes the whole local status Featur — remote status after fetch: use rev-list ahead/behind instead of re-running the full local status; a failed fetch must not count as fetched
- **#159** Local-changes review runs 9 sequential git spawns plus one per untracked file — fix intent-to-add file/directory clash regression in the local-changes temp index
- **#207** VCS repository detection runs three sequential git rev-parse processes and caches the result for only 2 s -2 spawns and ≈20-25 ms per detect — fix the detection cache-defeating loop for subdirectories with an invalid .git
- **#253** Expected failures in hot retry loops are logged as full stack traces and dominate server-child.log and desktop-main.log About 85-90% less se — logOnceEvery window must cover the loop's max backoff (VCS remote status refresh)

## WP07B · Forge/PR lookups, worktree sweeps and project inspection

Area: apps/server/src/sourceControl (GitHubCli, GitHubSourceControlProvider, Forgejo*, refreshWorktreeSourceControlState), apps/server/src/git/GitManager.ts (ref summary / PR index fallback), apps/server/src/ws/context.ts (sweeps), apps/server/src/ws/sourceControlRpc.ts, apps/server/src/processGovernor.ts, apps/server/src/workspace/checkoutInspection.ts

- **#205** PR discovery runs one gh pr list per worktree branch with heavy GraphQL fields — Forgejo index listing honours lean fields (no per-row commit-status fan-out)
- **#206** No process-wide concurrency limit or priority for git/gh/glab child processes Peak concurrent children: hundreds → ≈8-12. Bounded spawn burs — inbox per-row PR detail goes through the forge lane with a short cache; export governor in-flight stats
- **#197** Sidebar thread rows run the full local+remote VCS status pipeline — badge path: bound/cache the per-branch gh fallback (negative cache, no fallback when the index listing itself failed)
- **#192** PR page lists: involvement lists wait for git status, each list makes 2 sequential gh calls, and full comment bodies are fetched only to cou — repository resolution cache keyed per repository (common dir), longer TTL with background refresh, so cold PR/issue lists are one gh wave
- **#178** Every issue/PR list or search read starts a project-wide linked-worktree sweep with unbounded detached gh calls Estimate for 10 linked workt — only run batched PR state reads when a swept worktree is due; batch/reuse linked issue states (also covers #183)
- **#261** Worktrees whose checkout directory was deleted outside Ryco are never marked removed, so every source-control refresh re-probes them and log — Parts A, C, D only: unavailable checkouts logged once without stacks and not re-probed for ~15 min; close lifecycle/relocation races; retry a failed record. No auto-archive policy change
- **#188** Workspace inspection repeats project-level git commands per worktree and never caches results ~400 → ~45 git spawns per ryco listWorkspaces — project inspection: batched ahead/behind; do not gate the settings list on lifecycle suggestions; Agent Control list reuses inspection results

## WP08 · Workspace index and composer pickers

Area: apps/server/src/workspace/Layers/WorkspaceEntries.ts, apps/server/src/vcs/GitVcsDriver.ts (ls-files listing only), apps/web/src/components/chat/ComposerAttachmentMenus.tsx, composerPathMenu, ContextPickerPopup

- **#167** @-mention index: a 15 s TTL plus a 4-key cache force blocking full rebuilds — markRootChanged must keep a stale index (serve stale, rebuild in background) instead of deleting a non-hot root's index
- **#171** Bare '@' sends nothing and says 'No matching files'; the cold build starts only after the first character plus 120 ms, and errors show as 'n — bare-listing stand-in check must compare against the live query, not the debounced one
- **#168** The '#' issue/PR picker loads the heaviest PR list — ContextPickerPopup uses the lean picker rows
- **#172** A cold index build runs about 100-130 ms of synchronous JS on the server event loop — chunk the over-cap selectShallowestFiles/entry build so it yields to the event loop
- **#173** A slow or failing git ls-files waits 20 s, then silently falls back to a whole-tree filesystem walk that runs check-ignore at every level Bo — the tracked stand-in listing should be index-only (ls-files -c) as documented

## WP09 · Terminal server and client

Area: apps/server/src/terminal, apps/server/src/ws/terminalRpc.ts, apps/web/src/components/terminalViewCache.ts

- **#162** Terminal server spawns ps over the whole system every second and rewrites the full history file every 40 ms under output −1 process spawn pe — foreground-process detection without spawning ps every second where the PTY can tell us (node-pty process / tcgetpgrp), ps only as fallback; append-only (or chunked) history persistence instead of rewriting up to 2 MiB per second
- **#103** Every orchestration stream sends one RPC Chunk per event and waits for an Ack round trip — item (1): subscribeTerminalEvents must be chunk-preserving (no per-element Stream.tap ack per event)
- **#158** Closing the drawer or switching panel tabs disposes xterm; every reopen re-downloads and re-parses the whole scrollback Per reopen or tab sw — terminal view cache must hold at least MAX_TERMINALS_PER_GROUP views; evict after mounts

## WP10 · Web chat and composer correctness

Area: apps/web/src/components/ChatView.tsx, chat/ComposerPromptEditor.tsx, send engine (sendEngine.ts, executeChatSendTurn.ts), hooks/useHandleNewThread.ts, hooks/newDraftDefaults.ts, packages/client-runtime/src/state/composer (draftSplitStorage, draftStore, sessionPrewarm)

- **#128** Every thread switch remounts the whole ChatView — fix both defects: per-thread undo history (no cross-thread Cmd+Z), and send continuations/local dispatch state bound to the originating thread
- **#88** Composer drafts persist images as data URLs in localStorage: boot hydration, full re-serialization on every debounced write, and full decode — fix multi-tab draft loss in split storage (merge foreign index writes, never sweep entries a live tab owns)
- **#124** 'New thread' waits for a full getConfig — defect fixes only (draftStore no-op guard, field-level untouched check, remembered-preferences invalidation). No hosted getConfig change
- **#129** A thread's history is requested only after ChatView mounts and paints; until it arrives the 'new thread' screen — fork gap: a fresh fork with inherited history must not render the new-thread hero
- **#141** Pre-warm the provider session — Part C client: extract the web prewarm gating into a shared client-runtime helper (used by WP14A for mobile) and add a short dwell before focus-triggered prewarm

## WP11 · Web streaming, thread data and rendering

Area: apps/web/src/environments/runtime/service.ts, packages/client-runtime/src/connection/supervision.ts, packages/client-runtime/src/state/threads/store.ts (selectors), apps/web/src/components/chat (codeHighlightQueue, useChatSessionTabsPrefetch), DiffPanel/diffParsing, sidebar/threadNavigationIntent, apps/web/src/rpc/queryClient.ts

- **#119** Shell re-syncs replace every thread object, and thread-detail events commit one zustand set per event Avoids full sidebar re-renders on ever — items (1) and (3): coalescing must never cut assistant text; delete the dead recovery coordinator. Mobile batching is in WP14A
- **#126** Sibling-tab prefetch starts up to 6 thread windows the moment ChatView mounts, competing with the active thread Active thread snapshot not q — sibling prefetch waits for the live active window, not cache-hydrated messages; spread sidebar prewarm retains
- **#127** The thread-detail cache's byte estimate adds up every live event forever, so one busy thread fills the 12 MiB budget and evicts every idle c — retained-bytes estimate respects the store trims (activities 500, messages 2000)
- **#85** Cross-environment and per-project sidebar selectors allocate O(N) arrays on every store commit −0.3–1 ms and ~4k short-lived allocations per — memoize selectDelegatedChildThreadsForThreadRef
- **#136** Code blocks are highlighted synchronously during render; the first block of each language blocks 50–70 ms Removes 50–70 ms per language — tokenizeMaxLineLength for highlighting; split very large blocks so one job is not a long task
- **#166** DiffPanel hashes, parses and indexes the whole patch for search synchronously in render, even when search is never opened −6-15 ms per diff  — reuse a server revision / stable key instead of hashing full patch text on every review open
- **#154** Client checkpoint-diff store keeps every viewed patch forever — web part: byte budget for DiffPanel renderablePatchCache. Mobile part is in WP14A
- **#102** The WS connection and thread-window subscription only start after React commits RootAppShell / ChatView WS and shell snapshot about -150-300 — navigation intent release must not drop the subscription when the route retain is already gone
- **#226** Unary read RPCs are held until the full shell snapshot is accepted, adding a node round trip to first-render reads Saves 1 RTT + 1 Hub↔node  — Part A only: QueryClient does not retry awaiting-admission errors; the post-ready refresh re-runs them
- **#109** Each thread event re-reads and re-sends a full thread shell to every subscriber, and the client pays O(N threads) per upsert ~8–30× fewer sh — avoid O(all threads) record spreads per coalesced upsert / detail event when only one thread changes

## WP12A · Web sidebar, settings, theme and project icons

Area: apps/web/src/components/Sidebar.tsx, hooks/useHandleNewThread.ts (handler identity only), hooks/useSettings, ProjectFavicon.tsx, themes/registry.ts, hooks/useTheme.ts, settings (McpServersSettings, DeviceIdentitySettings), automations hooks, apps/server/src/project/Layers/ProjectFaviconResolver.ts

- **#73** Sidebar re-renders and re-derives everything on every store commit — stable handleNewThread identity (fix the compiler bailout / inline selector)
- **#81** useSettings selectors do not narrow re-renders; every consumer re-renders on any server-config change Removes several full sidebar/inbox row — narrow Sidebar providers selection to driver+models; ProjectFavicon/DeviceIcon/ThreadPriorityRefreshBridge stop subscribing to the whole config
- **#75** The inactive sidebar mode — compute inactive-mode sidebar derivations lazily
- **#87** Root-level style invalidations are expensive with the 587 KiB stylesheet; avoid toggling root classes or variables at runtime Avoids ~100–25 — theme apply is a no-op when nothing changes (no style rewrite, no transition guard)
- **#245** Project icons are re-fetched over RPC after every — web part: ProjectFavicon latches resolved artwork and refetches after TTL/eviction. Mobile part in WP14B
- **#203** Project icons spawn one node/Electron child per project, per connection, with no server cache and a 5 s budget that includes queue time 30 p — distinguish 'unfinished read' from 'no icon' so the client retries instead of caching null for 5 min
- **#92** Each project icon spawns a new Node child process and is resolved twice per load — pass interruption to the favicon reader child
- **#187** MCP settings fetches workspaces and servers twice on open — MCP settings: refreshing flag can no longer stick when a mutation lands during a load
- **#101** agentControl.subscribeProposals and automationCentre are requested on every load even when Agent Control is disabled — gate all Agent Control subscriptions/list calls on Agent Control being enabled; reopen when it is turned on
- **#66** ~398 KiB of hosted-hub/relay/E2EE code is in the standard boot graph — DeviceIdentitySettings must not statically import hostedHub/api in standard builds (also covers #218)
- **#76** useTheme re-applies the theme — theme catch-up after lazy listener attach must re-apply when any applied input differs

## WP12B · Web boot, routes, lazy surfaces and hosted boot

Area: apps/web/src/routes/__root.tsx, RootAppShell.tsx, ServerStateBootstrap.tsx, lib/shellIdlePreload.ts, lib/preloadableLazy.ts callers, browser/LazyBrowserPanel.tsx, settings/IntegrationsSettingsPanel.tsx, chat right-panel preload, hostedHub/bootGate.ts, hostedHub/readCache.ts, packages/client-runtime/src/connection/savedEnvironmentSession.ts

- **#65** Shell code, WebSocket handshake and thread-route code load strictly one after another Remote/hosted-like profile: ~-0.5 to -0.8 s to compose — start welcome/config sync with the early primary connection, not in ServerStateBootstrap's effect (also covers #105)
- **#98** The idle SettingsPage prefetch has no measurable benefit and competes with the critical path on slow links About -200 KB of boot-time downlo — idle preloads wait for the first thread render and run one at a time; no unconditional 5 s cap before the shell snapshot
- **#59** React 19 Suspense reveal throttle adds ~250-300 ms idle to boot, the first thread and every first page open Local/desktop: ~-220 ms to usabl — convert the remaining non-phone React.lazy surfaces (LazyBrowserPanel, ComputerUseSettings, others listed) to preloadableLazy with intent preloads (also covers #89, #122, #194). Do not touch the frozen web phone tier
- **#60** Click-only dialogs/popovers drag ~600 KiB — lazy dialogs pass onLoadError so a failed chunk shows an error instead of throwing
- **#160** No intent or idle preload for panel chunks or data; with modulePreload off, the chunk graph is a 3-level waterfall Loopback: −40-100 ms — sheet layout gets the right-panel mode hint/idle preload; mod+d preloads review before navigate
- **#223** Remember-this-browser cache re-encrypts and writes on every hosted store patch and every 750 ms while an agent streams Opted-in users avoid  — hosted read cache: per-environment write skip must ignore scroll-only and unrelated draft changes during streaming
- **#213** Relay connect waits for the 570 KiB-gzip HostedHubRoot chunk graph, which starts loading only after bootstrap finishes Removes the HostedHub — hosted boot gate must not await HostedHubRoot/RootAppShell on /pair and /native/authorize
- **#107** ServerConfig is loaded and sent twice on every connect, the usage page adds a getConfig preflight per request, and each load runs a ~6 ms sy — item (2) only: web saved-environment connect must not send a full getConfig beside the config snapshot. Mobile part is in WP14A
- **#68** Hosted Hub boot: three sequential dynamic imports, then 2 Hub RTTs, then the 1.8 MiB HostedHubRoot download, then the reveal throttle Hosted — item (1): start loading the RootAppShell graph beside the session request instead of after it (preload only; no change to who decides access)
- **#186** Pull Requests page statically imports FilesTab, pulling @pierre/diffs + shiki into first open — FilesTab lazy load passes onLoadError (same pattern as #60)

## WP13 · Web build, workers and perf guards

Area: apps/web/vite.config.ts, apps/web/src/viteBuild/*, apps/web/src/lib/diffWorkerPool.ts, scripts/perf/*, apps/web/src/perf/*.test.ts, ChatView phone-tier imports (lazy only)

- **#153** Diff worker ships a 608 KiB inlined Oniguruma WASM it never uses, while running the 3.5-5x slower JS regex engine With — probe WebAssembly/CSP and fall back to the JS regex engine when wasm is blocked (hosted); guard that the built worker has no inlined Oniguruma WASM. No Hub CSP change
- **#61** modulePreload disabled: CSS→main serialization, 4-level module discovery per phase, 93 sub-2 KiB requests Remote: removes 3 serial discovery — merge tiny app-code chunks (entriesAware groups) to cut cold-path requests substantially; measure request count before/after with the existing perf scripts; keep only if it does not regress boot bytes or the boot graph budgets
- **#72** 'ChatRightPanel' 1.1 MiB chunk is really the whole ChatView plus conditional surfaces that load with every thread -300 to -450 KiB raw — chat chunk budgets and forbidden-module rules (overview/crown/diff renderer/shiki) for the route closures; make the existing lazy phone overview split real by lazy-loading the frozen phone-tier surfaces from the chat graph (no behaviour change) (also covers #130)
- **#97** Lazy chunk graphs load as 3-4 sequential import levels, and the thread route chunk only starts after the shell snapshot Locally about -20-60 — preload coverage guard must parse Vite's .then()/async-destructuring wrappers
- **#120** wsTransport chunk is ~half contracts schemas for all 199 RPCs, and some server layers are rebuilt per WS connection Estimated −60–80 KiB raw — item (1): move the server-only agentControl schemas (internal MCP surface, external MCP tool catalog) out of the module the web boot chunk evaluates, e.g. a server-only subpath; keep contracts schema-only

## WP14A · Mobile data plane

Area: apps/mobile/src/connection, apps/mobile/src/state, apps/mobile/src/rpc, apps/mobile/src/features/threads (send/outbox/activity rows), apps/mobile/src/persistence, apps/mobile/src/hostedHub/primaryConnection.ts

- **#131** Thread windows are 80–95 % full tool output and diffs, and pre-#481 rows still carry raw outputs up to 1 MB An estimated 3–10x smaller windo — mobile requests activity previews and fetches full payloads on expand (getActivityPayload)
- **#154** Client checkpoint-diff store keeps every viewed patch forever — mobile part: bound the checkpoint-diff cache (count + bytes, release on unmount/archive)
- **#107** ServerConfig is loaded and sent twice on every connect, the usage page adds a getConfig preflight per request, and each load runs a ~6 ms sy — item (1): one config stream per mobile connection
- **#119** Shell re-syncs replace every thread object, and thread-detail events commit one zustand set per event Avoids full sidebar re-renders on ever — item (2): frame-batch mobile thread-detail events
- **#78** Shell snapshot re-application replaces every thread object; AI-Focus ranking changes push a full snapshot For reconnects and ranking updates — mobile hosted primary connection supplies applyThreadPriorities so priorities arrive as deltas
- **#237** Every projection change triggers a full-environment JSON.stringify + double UTF-8 encode + SQLite write 500 ms later Avoids up to ~2 MiB str — snapshot capture skips work while only timestamps churn during streaming
- **#147** Claude sends pay a client review RPC and an unconditional setPermissionMode control round trip on every turn -1 RTT per Claude send — item (1): mobile sends reuse the subscribed Claude review state (no extra getThreadWindow RTT)
- **#141** Pre-warm the provider session — Part B: mobile composer prewarm using the shared helper from WP10 (if WP10's helper is not present in this worktree, add the helper in packages/client-runtime/src/state/composer/sessionPrewarm.ts yourself with the same name resolveProviderSessionPrewarmRequest)

## WP14B · Mobile boot and render cost

Area: apps/mobile/babel.config.js, apps/mobile/src/features/threads (ThreadDetailScreen, ThreadComposer render structure), apps/mobile/src/components/ProjectFavicon.tsx, apps/mobile/src/navigation/lazyRouteScreens.ts, apps/mobile/src/connection (session hints), packages/client-runtime/src/connection/savedSessionRenewal.ts, packages/client-runtime effect sub-barrel imports

- **#240** React Compiler is enabled for web but not for the mobile app, leaving hand-written memoization fragile Fewer re-renders and derived-data reb — widen the React Compiler to the thread surfaces and components; remove the bailouts in ThreadDetailScreen/ThreadComposer/useThreadChecks
- **#245** Project icons are re-fetched over RPC after every — mobile part of the project icon latch + clear the icon cache on hosted sign-out/domain change
- **#238** All 25+ screens — make the Thread route prewarm actually evaluate ThreadDetailScreen under inline requires
- **#239** Every direct cold connect pays a GET /api/auth/session RTT — items (a)-(c) only; keep re-reading the bearer on every use
- **#248** Effect and @ryco/contracts root barrels pull unused modules into the startup graph, and tree shaking is off Effect: −85 modules / −1.45 MiB  — import effect rpc/reactivity submodules instead of the sub-barrel indexes in client-runtime and mobile

## WP15 · Client-runtime hosted session and device

Area: packages/client-runtime/src/relay/hostedHubSession.ts, packages/client-runtime/src/authorization (state.ts restore branch, api.ts ticket memo), apps/web/src/environments/remote/api.ts, packages/client-runtime/src/state/device, packages/shared relay E2EE corpus tests

- **#216** A silently dead Hub-session socket takes up to 45 s to detect; foreground and online signals skip 'healthy' states Dead-socket detection aft — liveness probe deadline starts after the ping is flushed (not behind queued data); unintentional logical-channel closes trigger a probe. Do not change lifecycle ownership
- **#225** Ticket issuance pays two POSTs on every attempt against Hubs that reject protocolMinor 3 -1 RTT per connect against older/custom Hubs — ticket minor fallback memo expires (e.g. per hub-session generation or TTL) instead of sticking for the instance lifetime
- **#215** Boot gate can hold the loading surface for 30-60 s on a stalled network — 401 restore chain uses the short boot-phase deadline and settles access
- **#34** Client descriptor/session/ws-token fetches and the WS URL provider have no timeout; one request in the window stalls reconnects indefinitely — declare `signal` in the resolveRemoteWebSocketConnectionUrl wrapper type
- **#110** Every environment connect opens a second /ws/device socket and runs device.list, spawning 4–10 simulator/emulator processes — agent device.open-pane-requested for a thread that is not subscribed must not be lost (buffer or re-surface on navigation) (also covers #96)
- **#228** Server/desktop relay E2EE uses noble where node:crypto is 6-30x faster for the identical algorithms Node event-loop time per MiB sealed drop — Part B only: run the relay E2EE corpus with the native provider installed (test-only)

## WP16 · Provider event logging

Area: apps/server/src/provider/providerEventLogRecords.ts, EventNdjsonLogger.ts, ProviderEventLoggers.ts, OpenCodeAdapter/CopilotAdapter event logging hooks, LocalFileTracer.ts

- **#251** Canonical log embeds the full native message in every runtime event — lifecycle mode: keep raw.payload for canonical lifecycle records whose native message the native lifecycle filter dropped
- **#252** Native log writes one ~700 B envelope per streaming delta that carries ~9 B of content — delta coalescing also for OpenCode message.part.delta and Copilot assistant deltas
- **#256** Logs write large items uncapped and up to 4 times — do not stringify over-cap records fully before capping
- **#257** Shared native and canonical loggers are never closed: the last batch is lost on quit, writers are never evicted, and the queue bound counts  — bound the logger finalizer drain time; close Claude/Copilot loggers
- **#259** Each log write creates 3 exported Effect.fn spans and takes a SynchronizedRef lock shared by all threads About 1.15 KB less trace output per — remove per-event named Effect.fn spans on the OpenCode streaming hot path
- **#8** The desktop backend's local trace file writes ~280 KB/s under agent load, 75% of it full SQL text spans ≈−200 KB/s disk writes and the match — normalize SQL text only for spans that are kept

## Needs a decision (not implemented)

- **#2** Real-world boot is dominated by 3–15 s backend stalls before 'Listening'; the listener waits behind provider creation and migrations p90 tim — Parts B/C: upgrading-data UI and moving data backfills behind the router are product/boundary decisions
- **#4** Renderer origin follows the first free port from 3773, which T3 Code also uses; origin flips split caches and localStorage Avoids fully cold — Part B: migrating existing installs to a new origin moves user data (drafts, UI state, attachments)
- **#7** Renderer cannot fetch or parse any app JS until the backend listens; the ryco:// origin with codeCache is registered but unused Overlaps ~0. — Step 2: decoupling the shell from the backend means a new request path in main or the ryco:// origin (auth semantics)
- **#20** Every boot runs cold capability probes for every enabled provider: 15 child processes, ~1.9 GB peak process-tree RSS, and Claude Code creden — Codex usage freshness without an app-server spawn needs a product choice
- **#45** Routes are served only after engine hydration and projector catch-up, while the socket is already bound Static shell and descriptor availabl — async engine hydration changes readiness semantics; measured gain about 0 ms on typical boots
- **#46** Shell snapshot: 5.65 MiB and about 140 ms per build at 4.5k threads, with a redundant whole-snapshot Schema decode, deleted rows decoded the — lazy archived threads change the subscribeShell protocol and product behaviour
- **#79** Main-thread Effect Schema decode of the whole shell snapshot, including archived threads −5–25 ms of cold-boot main-thread work at 2,000 thr — same as #46
- **#69** Feature CSS sits in the main stylesheet, and DM Sans is only fetched after the shell paints — hosted DM Sans preload reverses a deliberate, test-pinned exclusion and needs a Hub deploy
- **#71** No route-level code splitting: every route module and its imports — reverses the measured BOOT_ROOT_MODULES trade-off or moves auth outside the client-runtime owner
- **#95** The full ~113-130 KB ServerConfig is fetched 3-6 times per session even though it is already subscribed, and it blocks the shell snapshot on — hosted live-config and persisting catalogs on non-loopback clients touch hosted lifecycle and privacy decisions
- **#112** Saved/remote environment connect is a ≥4-RTT waterfall, and thread subscriptions wait for registration after metadata −1 to −2 RTTs per save — web/desktop saved-pairing auth flow change
- **#117** WebSocket compression is off; large snapshots to remote and saved environments travel uncompressed — item 3: relay compression is compress-before-encrypt (CRIME/BREACH-class side channel to the Hub)
- **#121** The primary local/desktop environment has no persisted shell cache: the sidebar stays empty until the whole network critical path completes  — cross-boot shell resume needs a contract addition and reverses the Phase 1 cache design
- **#124** 'New thread' waits for a full getConfig — removing the hosted fresh getConfig trusts a cached snapshot under the hosted lifecycle rules
- **#146** Worktree-mode first send: full-remote fetch, worktree add, client RPCs and dispatches run serially before the turn exists -0.5 s or more — keeping the worktree prefetch warm adds background fetches; reordering setup vs agent changes visible order
- **#148** Turn-start lane repeats thread/project reads, takes the node-wide storage lock 2-3 times, and runs a provider goal RPC every turn -1 provide — lease handoff vs pending relocation is a deliberate, tested lifecycle choice
- **#150** One codex app-server process per thread session; share one per provider instance — shared Codex app-server trades per-thread failure isolation for memory
- **#174** The client @-search cache never evicts and never reuses earlier results; every keystroke is a 9-12 KB round trip after a fixed 120 ms deboun — client-side index copies trade bandwidth/memory and need a server push for freshness
- **#212** Every in-session relay drop establishes the relay twice — hosted connectionRecovered deadline is inside the hosted lifecycle owner
- **#214** Session restore and directory fetch run serially on every cold start and every foreground resume; the Hub-session socket opens only afterwar — opening the Hub-session socket before session validation changes hosted lifecycle ownership
- **#219** Every connect and reconnect needs a separate HTTP ticket round trip although the Hub-session socket is already authenticated -1 RTT per conn — Hub-session protocol v2 (tickets on the socket) is a Hub protocol + security change
- **#220** Hosted connections never use shell-sequence resume, so every reconnect or resume re-downloads the full shell Reconnect transfer drops from ~ — hosted shell resume relaxes the AGENTS.md hosted lifecycle rule
- **#221** No payload compression on the relay; E2EE makes transport-level deflate useless Shell snapshot 363 → ~41 KiB — relay payload compression needs a crypto/security review
- **#226** Unary read RPCs are held until the full shell snapshot is accepted, adding a node round trip to first-render reads Saves 1 RTT + 1 Hub↔node  — Part B: hosted read admission before the snapshot belongs to the hosted lifecycle owner
- **#227** Client NX handshake runs cold, pure-JS noble X25519/Ed25519 on the main thread, about 25 ms on desktop V8 for the first connect First connec — WebCrypto path for the browser handshake needs crypto review
- **#228** Server/desktop relay E2EE uses noble where node:crypto is 6-30x faster for the identical algorithms Node event-loop time per MiB sealed drop — Part A: async WebCrypto AEAD on Electron needs crypto review
- **#229** Browser relay data plane does ~7 full copies, a full CBOR re-encode and noble decryption per chunk on the main thread — moving the data plane into a Worker moves key material and lifecycle ownership
- **#230** Native bearer mode re-hashes the same token per request and re-upserts the enrollment on every launch Saves one native-bridge hash per Hub r — treating a cached enrollment as ready changes E2EE enrollment semantics
- **#231** Connects to nodes that send no E2EE carrier pay a fixed 1.5 s T_ADV wait before any RPC flows, on every connect and reconnect -1.5 s per con — ending the T_ADV window early changes §4.4 K13 of the E2EE protocol
- **#235** Hosted users see a logo until restoreSession AND listNodes finish; offline launches show sign-in instead of the cached workspace −1 RTT + 1  — showing cached workspace on an unconfirmed session reverses a documented auth-gate rule
- **#239** Every direct cold connect pays a GET /api/auth/session RTT — item (d): reusing a bearer read changes superseded-bearer semantics
- **#241** Hosted live list waits for a per-launch enrollment upsert and a directory-gated selection restore before the relay ticket −1 to 2 sequential — cached enrollment/prewarmed relay before selection change E2EE and lifecycle ordering
- **#242** Every hosted relay frame is base64-decoded in JS — native AEAD on Hermes is forbidden by §14.7 today
- **#261** Worktrees whose checkout directory was deleted outside Ryco are never marked removed, so every source-control refresh re-probes them and log — Part B: which missing parents count as deleted also auto-archives workspaces

## Not scheduled

- **#82** Startup marks miss decode and paint; no reproducible boot or streaming CPU benchmark at realistic scale Makes the ~120–150 ms — micro-benchmarks for web boot functions: measurement only, low value now
- **#134** Timeline remounts with a 56 px row-height guess, so it over-renders at first and re-measures every visit Estimated 3–4x fewer rows rendered  — timeline height memory was reverted on purpose in #723 while the blank-timeline cause is open
