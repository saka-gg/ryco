/**
 * Server tests whose assertions bound real elapsed time, timer latency, or
 * event-loop gaps from above, or that wait a fixed real time for background work
 * and then assume it finished.
 *
 * Every other server file runs in parallel with the rest of its shard. The CPU
 * those files use stretches exactly what these assertions measure, so these
 * files run isolated and one at a time after the parallel group, the same load
 * profile the whole suite had when it ran serially. A lower bound alone does
 * not qualify (load only makes things slower), and neither does a test driven
 * by TestClock.
 *
 * Add a file here when a new test asserts that real work finishes within a
 * wall-clock budget (Date.now()/performance.now() deltas, setInterval gap
 * probes, real-interval heartbeats) or sleeps a fixed time instead of waiting for
 * a condition. Better still, make the bound relative, wait for the condition, or
 * move the test to TestClock, then take the file off the list.
 */
export const SERVER_TIMING_TEST_FILES = [
  // Failed discovery retries finish within 1 s.
  "src/agentControl/externalSecurity.test.ts",
  // Measurements answer within 3-6.5 s, and a stopped browser's cleanup is
  // bounded to 0.95-1.8 s.
  "src/htmlRender/HtmlRenderLive.test.ts",
  // 24 lookups that never resolve are refused within 2 s, a local one in 0.5 s.
  "src/htmlRender/publicProxy.test.ts",
  // Graceful shutdown with open sockets finishes within 2 s.
  "src/httpShutdown.test.ts",
  // 16 in-process lock handoffs finish within 50 ms each.
  "src/hubIdentity/LocalHubIdentityState.test.ts",
  // Paging a large thread history finishes within 2 s.
  "src/orchestration/Layers/ProjectionSnapshotQuery.test.ts",
  // A prewarmed send reaches the provider within half of a 300 ms fake start.
  "src/orchestration/Layers/ProviderCommandReactor.test.ts",
  // Event-loop gaps stay under 250 ms while sqlite waits for a write lock.
  "src/persistence/Layers/Sqlite.test.ts",
  // Event-loop gaps and main-connection latency stay under a heavy read's time.
  "src/persistence/SqliteReadClient.test.ts",
  // A hanging folder probe is cut off within 1 s.
  "src/project/chatFolders.test.ts",
  // An 8 s probe timeout plus the process start stay under 12 s.
  "src/provider/Layers/CodexProvider.test.ts",
  // Interrupting hung starts returns within 2 s and 5 s.
  "src/provider/Layers/CodexStoredThreadReader.test.ts",
  // Forced and parallel client stops stay within 1 s and two stop budgets.
  "src/provider/Layers/CopilotAdapter.clientStop.test.ts",
  // Closing a logger with a wedged file handle finishes within 5 s.
  "src/provider/Layers/ProviderEventLoggers.test.ts",
  // Latched instance shutdown finishes within 1 s, ahead of its 2 s fallback.
  "src/provider/Layers/ProviderInstanceRegistryLive.test.ts",
  // Provider shutdown finishes within 1 s.
  "src/provider/Layers/ProviderService.test.ts",
  // A hanging shutdown-hint write is cut off after 2 s, within 6 s overall.
  "src/serverRuntimeStartup.test.ts",
  // Shutdown flushes analytics within 2 s.
  "src/telemetry/Layers/AnalyticsService.test.ts",
  // Usage summaries answer within 2 s while the rates download hangs.
  "src/usage/UsageService.test.ts",
  // Allows 20 ms for a 200-event backlog to queue behind a held chunk; under
  // parallel load it split into 4 chunks in CI.
  "src/ws/context/orchestrationStreamBatching.test.ts",
  // Real 100 ms pings against a 200 ms liveness timeout, and a 250-450 ms
  // silence window.
  "src/ws/rpcHeartbeat.test.ts",
] as const;
