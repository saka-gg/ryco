import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import {
  createMobileHostedScopeLeaseStore,
  measureHostedLeaseReconnectTraffic,
  mobileHostedConnectionScopes,
  MOBILE_SCOPE_LEASE_TTL_MS,
  readMobileHostedScopeLeaseDiagnostics,
} from "./hostedConnectionScopes";

describe("mobile hosted connection scope leases", () => {
  afterEach(() => {
    mobileHostedConnectionScopes.reset();
    vi.useRealTimers();
  });

  const ENV_A = "env-a" as EnvironmentId;
  const ENV_B = "env-b" as EnvironmentId;
  const THREAD_A = "thread-a" as ThreadId;

  it("refcounts identical mounted scopes and releases only the final owner", () => {
    const store = createMobileHostedScopeLeaseStore();
    const first = store.retain(ENV_A, { type: "thread-detail", threadId: THREAD_A });
    const second = store.retain(ENV_A, { type: "thread-detail", threadId: THREAD_A });

    expect(store.list(ENV_A)).toEqual([
      {
        environmentId: "env-a",
        scope: { type: "thread-detail", threadId: "thread-a" },
        refCount: 2,
      },
    ]);
    first();
    expect(store.isEnvironmentRetained(ENV_A)).toBe(true);
    second();
    second();
    expect(store.isEnvironmentRetained(ENV_A)).toBe(false);
  });

  it("computes diagnostics from the live scopes when read", () => {
    const store = createMobileHostedScopeLeaseStore();
    const read = () => readMobileHostedScopeLeaseDiagnostics(store, () => 42);
    expect(read()).toEqual({
      observedAt: 42,
      ttlMs: MOBILE_SCOPE_LEASE_TTL_MS,
      activeScopeCount: 0,
      retainedEnvironmentCount: 0,
    });

    const releaseThread = store.retain(ENV_A, { type: "thread-detail", threadId: THREAD_A });
    const releaseSameThread = store.retain(ENV_A, { type: "thread-detail", threadId: THREAD_A });
    const releaseProvider = store.retain(ENV_A, { type: "provider-status" });
    const releaseOther = store.retain(ENV_B, { type: "vcs-status", cwd: "/work/repo" });
    expect(read()).toEqual({
      observedAt: 42,
      ttlMs: MOBILE_SCOPE_LEASE_TTL_MS,
      activeScopeCount: 3,
      retainedEnvironmentCount: 2,
    });

    releaseThread();
    expect(read().activeScopeCount).toBe(3);
    releaseSameThread();
    releaseOther();
    expect(read()).toMatchObject({ activeScopeCount: 1, retainedEnvironmentCount: 1 });
    releaseProvider();
    expect(read()).toMatchObject({ activeScopeCount: 0, retainedEnvironmentCount: 0 });
  });

  it("reads the module store by default and stamps the current time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_234);
    const release = mobileHostedConnectionScopes.retain(ENV_A, { type: "provider-status" });
    expect(readMobileHostedScopeLeaseDiagnostics()).toEqual({
      observedAt: 1_234,
      ttlMs: MOBILE_SCOPE_LEASE_TTL_MS,
      activeScopeCount: 1,
      retainedEnvironmentCount: 1,
    });
    release();
    expect(readMobileHostedScopeLeaseDiagnostics().activeScopeCount).toBe(0);
  });

  it("schedules no timer while scopes are retained, released or read", async () => {
    vi.useFakeTimers();
    const store = createMobileHostedScopeLeaseStore();
    const release = store.retain(ENV_A, { type: "provider-status" });
    readMobileHostedScopeLeaseDiagnostics(store);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(MOBILE_SCOPE_LEASE_TTL_MS * 2);
    release();
    expect(vi.getTimerCount()).toBe(0);
    expect("startReporter" in store).toBe(false);
  });

  it("quantifies the assessed eight-client reconnect reduction", () => {
    const measured = measureHostedLeaseReconnectTraffic({
      clients: 8,
      bound: 3,
      retainedEnvironmentsPerClient: 1,
    });
    expect(measured).toEqual({
      unleasedReconnects: 24,
      leasedReconnects: 8,
      unleasedShellStreams: 24,
      leasedShellStreams: 8,
      reduction: 2 / 3,
    });
  });
});
