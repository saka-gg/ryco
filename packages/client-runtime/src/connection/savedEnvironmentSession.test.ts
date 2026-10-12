import type { AuthSessionState } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentAuthHttpError } from "./remoteApi.ts";
import {
  awaitSavedEnvironmentConfig,
  checkSavedEnvironmentSession,
  isSavedEnvironmentAwaitingRepair,
  isSavedEnvironmentCredentialRejection,
  SAVED_ENVIRONMENT_CONFIG_SNAPSHOT_WAIT_MS,
  SavedEnvironmentTimeoutError,
} from "./savedEnvironmentSession.ts";

const session = (authenticated: boolean) =>
  ({ authenticated, ...(authenticated ? { role: "owner" } : {}) }) as unknown as AuthSessionState;

describe("isSavedEnvironmentCredentialRejection", () => {
  it("treats the node's 401 for an expired or revoked bearer as final", () => {
    expect(
      isSavedEnvironmentCredentialRejection(
        new RemoteEnvironmentAuthHttpError("Unauthorized request.", 401),
      ),
    ).toBe(true);
  });

  it("keeps retrying what pairing again cannot fix", () => {
    // A gateway or proxy in front of the node, not the node's own answer.
    expect(
      isSavedEnvironmentCredentialRejection(new RemoteEnvironmentAuthHttpError("Forbidden", 403)),
    ).toBe(false);
    expect(
      isSavedEnvironmentCredentialRejection(
        new RemoteEnvironmentAuthHttpError("Failed to issue websocket token.", 500),
      ),
    ).toBe(false);
    expect(isSavedEnvironmentCredentialRejection(new Error("fetch failed"))).toBe(false);
  });
});

describe("checkSavedEnvironmentSession", () => {
  it("reads the node's authenticated:false answer as needing a new pairing", async () => {
    await expect(
      checkSavedEnvironmentSession({ fetchSessionState: async () => session(false) }),
    ).resolves.toEqual({ status: "requires-auth" });
  });

  it("returns the session the node still accepts", async () => {
    const accepted = session(true);
    await expect(
      checkSavedEnvironmentSession({ fetchSessionState: async () => accepted }),
    ).resolves.toEqual({ status: "authenticated", session: accepted });
  });

  it("fails into the retry schedule on a 403 from in front of the node", async () => {
    const forbidden = new RemoteEnvironmentAuthHttpError("Forbidden", 403);
    await expect(
      checkSavedEnvironmentSession({
        fetchSessionState: async () => {
          throw forbidden;
        },
      }),
    ).rejects.toBe(forbidden);
  });
});

describe("isSavedEnvironmentAwaitingRepair", () => {
  it("parks only an environment whose credential the node rejected", () => {
    expect(isSavedEnvironmentAwaitingRepair({ authState: "requires-auth" })).toBe(true);
    expect(isSavedEnvironmentAwaitingRepair({ authState: "authenticated" })).toBe(false);
    expect(isSavedEnvironmentAwaitingRepair({ authState: "unknown" })).toBe(false);
    expect(isSavedEnvironmentAwaitingRepair(undefined)).toBe(false);
  });
});

describe("awaitSavedEnvironmentConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const never = <T>() => new Promise<T>(() => undefined);

  it("uses the subscription's snapshot and never reads the config when it arrives in time", async () => {
    const readConfig = vi.fn(async () => "read");
    await expect(
      awaitSavedEnvironmentConfig({ snapshot: Promise.resolve("snapshot"), readConfig }),
    ).resolves.toBe("snapshot");
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("reads the config once when no snapshot arrives within the wait, instead of failing", async () => {
    vi.useFakeTimers();
    const readConfig = vi.fn(async () => "read");
    const result = awaitSavedEnvironmentConfig({ snapshot: never<string>(), readConfig });
    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONFIG_SNAPSHOT_WAIT_MS - 1);
    expect(readConfig).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("read");
    expect(readConfig).toHaveBeenCalledTimes(1);
  });

  it("takes a late snapshot that beats the fallback read", async () => {
    vi.useFakeTimers();
    let deliver: (value: string) => void = () => undefined;
    const snapshot = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const result = awaitSavedEnvironmentConfig({ snapshot, readConfig: () => never<string>() });
    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONFIG_SNAPSHOT_WAIT_MS + 10);
    deliver("late snapshot");
    await expect(result).resolves.toBe("late snapshot");
  });

  it("fails at once on a credential rejection, without reading the config", async () => {
    vi.useFakeTimers();
    const rejection = new Error("rejected");
    const readConfig = vi.fn(async () => "read");
    const result = awaitSavedEnvironmentConfig({ snapshot: Promise.reject(rejection), readConfig });
    await expect(result).rejects.toBe(rejection);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("stays bounded when neither the snapshot nor the read answers", async () => {
    vi.useFakeTimers();
    const result = awaitSavedEnvironmentConfig({
      snapshot: never<string>(),
      readConfig: () => never<string>(),
      timeoutMs: 5_000,
    });
    const settled = expect(result).rejects.toBeInstanceOf(SavedEnvironmentTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
  });
});
