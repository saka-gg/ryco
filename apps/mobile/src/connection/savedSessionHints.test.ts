import type { AuthSessionState, EnvironmentId } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  createSavedSessionHints,
  SAVED_SESSION_HINTS_STORAGE_KEY,
  usableSavedSessionHint,
} from "./savedSessionHints";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12);
const ENV = "env-1" as EnvironmentId;

function session(overrides: Record<string, unknown> = {}): AuthSessionState {
  return {
    authenticated: true,
    role: "owner",
    sessionMethod: "bearer-session-token",
    expiresAt: new Date(NOW + 29.5 * DAY_MS).toISOString(),
    auth: {},
    ...overrides,
  } as unknown as AuthSessionState;
}

function memoryKv(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(SAVED_SESSION_HINTS_STORAGE_KEY, initial);
  return {
    values,
    kv: {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

describe("when a remembered session may skip the pre-socket check", () => {
  it("accepts a bearer session far from renewal", () => {
    expect(usableSavedSessionHint(session(), NOW)).not.toBeNull();
  });

  it.each([
    ["no hint", null],
    ["an unauthenticated answer", session({ authenticated: false })],
    ["a cookie session", session({ sessionMethod: "browser-session-cookie" })],
    [
      "a session due for renewal",
      session({ expiresAt: new Date(NOW + 20 * DAY_MS).toISOString() }),
    ],
    ["an expired session", session({ expiresAt: new Date(NOW - DAY_MS).toISOString() })],
    ["an unreadable expiry", session({ expiresAt: "soon" })],
  ])("asks first for %s", (_label, hint) => {
    expect(usableSavedSessionHint(hint, NOW)).toBeNull();
  });
});

describe("saved session hint store", () => {
  it("persists answers across instances and forgets on request", async () => {
    const { kv } = memoryKv();
    const first = createSavedSessionHints(kv);
    first.record(ENV, session({ role: "client" }));
    await expect(first.read(ENV)).resolves.toMatchObject({ role: "client" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = createSavedSessionHints(kv);
    await expect(second.read(ENV)).resolves.toMatchObject({ role: "client" });

    second.forget(ENV);
    await expect(second.read(ENV)).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(createSavedSessionHints(kv).read(ENV)).resolves.toBeNull();
  });

  it("keeps other environments' stored answers when recording before the first read", async () => {
    const other = "env-2" as EnvironmentId;
    const { kv } = memoryKv(JSON.stringify({ version: 1, sessions: { [other]: session() } }));
    const hints = createSavedSessionHints(kv);
    hints.record(ENV, session());

    await expect(hints.read(other)).resolves.not.toBeNull();
    await expect(hints.read(ENV)).resolves.not.toBeNull();
  });

  it("never stores an unauthenticated answer and ignores a corrupt record", async () => {
    const { kv, values } = memoryKv("{not json");
    const hints = createSavedSessionHints(kv);
    hints.record(ENV, session({ authenticated: false }));
    await expect(hints.read(ENV)).resolves.toBeNull();
    expect(values.get(SAVED_SESSION_HINTS_STORAGE_KEY)).toBe("{not json");
  });

  it("holds a decoded answer in the same JSON form a later launch reads back", async () => {
    // A decoded session carries a DateTime; the hint keeps its ISO string, so
    // the in-process hint and the persisted one decide the same way.
    const decodedExpiry = DateTime.makeUnsafe(Date.now() + 29.5 * DAY_MS);
    const hints = createSavedSessionHints(memoryKv().kv);
    hints.record(ENV, session({ expiresAt: decodedExpiry }));

    const hint = await hints.read(ENV);
    expect(typeof hint?.expiresAt).toBe("string");
    expect(usableSavedSessionHint(hint, Date.now())).not.toBeNull();
  });

  it("stores only the session fields it reads, never anything else the answer carried", async () => {
    const { kv, values } = memoryKv();
    const hints = createSavedSessionHints(kv);
    hints.record(ENV, session({ sessionToken: "secret" }));
    await hints.read(ENV);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      Object.keys(JSON.parse(values.get(SAVED_SESSION_HINTS_STORAGE_KEY)!).sessions[ENV]),
    ).toEqual(["authenticated", "auth", "role", "sessionMethod", "expiresAt"]);
  });
});
