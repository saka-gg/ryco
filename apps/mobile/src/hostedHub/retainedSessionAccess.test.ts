import { describe, expect, it, vi } from "vite-plus/test";
import type { HostedAccountStatus } from "@ryco/client-runtime/authorization";

import {
  deriveRetainedHubSession,
  HUB_SESSION_CONFIRMED_AT_KEY,
  isHubSessionConfirmationFresh,
  publishStoredHubSession,
  readHubSessionConfirmedAt,
  readStoredHubSession,
  resetHubLaunchStateForTests,
  resolveLaunchAccountStatus,
  isHubLaunchCheckSettled,
  publishHubLaunchCheckSettled,
  RETAINED_SESSION_ACCESS_WINDOW_MS,
  subscribeHubLaunchState,
  watchHubSessionConfirmation,
} from "./retainedSessionAccess";

const NOW = Date.parse("2026-11-10T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const retained = {
  storedSession: true,
  confirmedAt: NOW - HOUR,
  now: NOW,
  accessCheckSettled: false,
  accountStatus: "signed-out",
} as const;

describe("a retained Hub sign-in", () => {
  it("opens the saved workspace before the launch check has answered", () => {
    expect(deriveRetainedHubSession(retained)).toBe(true);
    expect(deriveRetainedHubSession({ ...retained, accountStatus: "authenticating" })).toBe(true);
  });

  it("needs the stored credential and the Hub's recent confirmation, both", () => {
    expect(deriveRetainedHubSession({ ...retained, storedSession: false })).toBe(false);
    expect(deriveRetainedHubSession({ ...retained, storedSession: null })).toBe(false);
    expect(deriveRetainedHubSession({ ...retained, confirmedAt: null })).toBe(false);
    expect(
      deriveRetainedHubSession({
        ...retained,
        confirmedAt: NOW - RETAINED_SESSION_ACCESS_WINDOW_MS,
      }),
    ).toBe(false);
    expect(
      deriveRetainedHubSession({
        ...retained,
        confirmedAt: NOW - RETAINED_SESSION_ACCESS_WINDOW_MS + 1,
      }),
    ).toBe(true);
  });

  it("does not trust a confirmation dated in the future", () => {
    expect(isHubSessionConfirmationFresh(NOW + 1, NOW)).toBe(false);
    expect(isHubSessionConfirmationFresh(NOW, NOW)).toBe(true);
  });

  it("stays open while the Hub cannot be reached, and ends when the session is gone", () => {
    const settled = { ...retained, accessCheckSettled: true };
    const after = (accountStatus: HostedAccountStatus) =>
      deriveRetainedHubSession({ ...settled, accountStatus });
    expect(after("unavailable")).toBe(true);
    expect(after("authenticating")).toBe(true);
    expect(after("authenticated")).toBe(true);
    expect(after("signing-out")).toBe(true);
    expect(after("signed-out")).toBe(false);
    expect(after("session-expired")).toBe(false);
  });
});

function memoryKV(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function accountStore(initial: HostedAccountStatus) {
  let status = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: HostedAccountStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
    /** A store update that leaves the account status as it is. */
    touch() {
      for (const listener of listeners) listener();
    },
  };
}

describe("the Hub's confirmation stamp", () => {
  it("reads only a positive, finite stamp", async () => {
    expect(await readHubSessionConfirmedAt(memoryKV())).toBeNull();
    for (const raw of ["", "nope", "-5", "0", "Infinity"]) {
      expect(
        await readHubSessionConfirmedAt(memoryKV({ [HUB_SESSION_CONFIRMED_AT_KEY]: raw })),
      ).toBeNull();
    }
    expect(
      await readHubSessionConfirmedAt(memoryKV({ [HUB_SESSION_CONFIRMED_AT_KEY]: String(NOW) })),
    ).toBe(NOW);
    expect(
      await readHubSessionConfirmedAt({
        getItem: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).toBeNull();
  });

  it("keeps the stamp through the launch check and writes it once the Hub confirms", () => {
    const kv = memoryKV({ [HUB_SESSION_CONFIRMED_AT_KEY]: String(NOW - HOUR) });
    const account = accountStore("signed-out");
    let now = NOW;
    watchHubSessionConfirmation({
      kv,
      now: () => now,
      readAccountStatus: account.read,
      subscribe: account.subscribe,
    });
    // The store's starting value is no answer.
    expect(kv.removeItem).not.toHaveBeenCalled();
    account.set("authenticating");
    account.set("unavailable");
    expect(kv.removeItem).not.toHaveBeenCalled();
    expect(kv.setItem).not.toHaveBeenCalled();
    account.set("authenticating");
    account.set("authenticated");
    expect(kv.values.get(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(String(NOW));

    // Later store updates rewrite it at most every ten minutes.
    now = NOW + 5 * 60_000;
    account.touch();
    expect(kv.setItem).toHaveBeenCalledTimes(1);
    now = NOW + 10 * 60_000;
    account.touch();
    expect(kv.values.get(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(String(now));
    expect(kv.setItem).toHaveBeenCalledTimes(2);
  });

  it("drops the stamp when the session ends, not while a sign-out is still under way", () => {
    const kv = memoryKV();
    const account = accountStore("authenticated");
    const stop = watchHubSessionConfirmation({
      kv,
      now: () => NOW,
      readAccountStatus: account.read,
      subscribe: account.subscribe,
    });
    expect(kv.values.get(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(String(NOW));
    account.set("signing-out");
    expect(kv.removeItem).not.toHaveBeenCalled();
    account.set("signed-out");
    expect(kv.values.has(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(false);

    account.set("authenticated");
    account.set("session-expired");
    expect(kv.values.has(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(false);
    stop();
    account.set("authenticated");
    expect(kv.values.has(HUB_SESSION_CONFIRMED_AT_KEY)).toBe(false);
  });
});

describe("the launch state the hosted runtime publishes", () => {
  it("is unknown until published and notifies on a change only", () => {
    resetHubLaunchStateForTests();
    expect(readStoredHubSession()).toBeNull();
    expect(isHubLaunchCheckSettled()).toBe(false);
    const listener = vi.fn();
    const stop = subscribeHubLaunchState(listener);
    publishStoredHubSession(true);
    publishStoredHubSession(true);
    expect(readStoredHubSession()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    publishHubLaunchCheckSettled(true);
    publishHubLaunchCheckSettled(false);
    expect(isHubLaunchCheckSettled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    publishStoredHubSession(false);
    expect(listener).toHaveBeenCalledTimes(2);
    resetHubLaunchStateForTests();
  });

  it("reads the store's starting signed-out as no answer until the Hub was asked", () => {
    const checking = { storedSession: true, check: "pending" } as const;
    expect(resolveLaunchAccountStatus("signed-out", checking)).toBe("authenticating");
    // The stored-session read itself has not settled yet either.
    expect(resolveLaunchAccountStatus("signed-out", { ...checking, storedSession: null })).toBe(
      "authenticating",
    );
    // Nothing stored: nothing is being checked, the device is signed out.
    expect(resolveLaunchAccountStatus("signed-out", { ...checking, storedSession: false })).toBe(
      "signed-out",
    );
    // The Hub's answer is an answer, and so is every status after it.
    expect(resolveLaunchAccountStatus("signed-out", { ...checking, check: "answered" })).toBe(
      "signed-out",
    );
    for (const status of ["authenticated", "unavailable", "session-expired"] as const) {
      expect(resolveLaunchAccountStatus(status, checking)).toBe(status);
    }
  });

  it("reads a held session the Hub was never asked about as unavailable, not signed out", () => {
    // The hardware key did not load, or no endpoint is configured.
    const unanswered = { storedSession: true, check: "unanswered" } as const;
    expect(resolveLaunchAccountStatus("signed-out", unanswered)).toBe("unavailable");
    expect(resolveLaunchAccountStatus("signed-out", { ...unanswered, storedSession: false })).toBe(
      "signed-out",
    );
    expect(resolveLaunchAccountStatus("signed-out", { ...unanswered, storedSession: null })).toBe(
      "signed-out",
    );
  });

  it("reads the published launch state by default, and an answer is final", () => {
    resetHubLaunchStateForTests();
    publishStoredHubSession(true);
    expect(resolveLaunchAccountStatus("signed-out")).toBe("authenticating");
    publishHubLaunchCheckSettled(false);
    expect(resolveLaunchAccountStatus("signed-out")).toBe("unavailable");
    publishHubLaunchCheckSettled(true);
    expect(resolveLaunchAccountStatus("signed-out")).toBe("signed-out");
    publishHubLaunchCheckSettled(false);
    expect(resolveLaunchAccountStatus("signed-out")).toBe("signed-out");
    resetHubLaunchStateForTests();
  });

  it("counts an authenticated account as the Hub's answer", () => {
    resetHubLaunchStateForTests();
    publishStoredHubSession(true);
    publishHubLaunchCheckSettled(false);
    const account = accountStore("signed-out");
    watchHubSessionConfirmation({
      kv: memoryKV(),
      now: () => NOW,
      readAccountStatus: account.read,
      subscribe: account.subscribe,
    });
    // A sign-in later in the same run, then a sign-out: that one is real.
    account.set("authenticated");
    account.set("signed-out");
    expect(resolveLaunchAccountStatus("signed-out")).toBe("signed-out");
    resetHubLaunchStateForTests();
  });
});
