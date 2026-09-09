import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";
import {
  createDesktopHostedSessionCredentials,
  getOrCreateDesktopInstallationId,
} from "./hostedCredentials.ts";
import { describe, expect, it, vi } from "vite-plus/test";

function memoryStore(
  seed: Readonly<Record<string, string>> = {},
  createOverride?: DesktopProtectedRecordStore["create"],
): {
  readonly records: Map<string, string>;
  readonly store: DesktopProtectedRecordStore;
} {
  const records = new Map(Object.entries(seed));
  return {
    records,
    store: {
      read: async (name) => records.get(name) ?? null,
      create:
        createOverride ??
        (async (name, value) => {
          if (records.has(name)) return false;
          records.set(name, value);
          return true;
        }),
      write: async (name, value) => {
        records.set(name, value);
      },
      delete: async (name) => {
        records.delete(name);
      },
    },
  };
}

describe("Desktop hosted credentials", () => {
  it("reports failed persistence and allows a later durable retry", async () => {
    const memory = memoryStore();
    const write = vi.fn(memory.store.write).mockRejectedValueOnce(new Error("locked"));
    const credentials = createDesktopHostedSessionCredentials({ ...memory.store, write });
    credentials.writeBearerToken?.("new-token");
    await expect(credentials.flush()).rejects.toThrow("credential storage is unavailable");
    await expect(credentials.flush()).resolves.toBeUndefined();
    expect(memory.records.get("hub-session-token")).toBe("new-token");
  });

  it("retries a locked store without treating the existing session as signed out", async () => {
    const memory = memoryStore({ "hub-session-token": "stored-token" });
    const read = vi.fn(memory.store.read).mockRejectedValueOnce(new Error("locked"));
    const credentials = createDesktopHostedSessionCredentials({ ...memory.store, read });
    await expect(credentials.hydrate()).rejects.toThrow("credential storage is unavailable");
    await credentials.hydrate();
    expect(credentials.readBearerToken?.()).toBe("stored-token");
  });

  it("does not resurrect a session when a pending read completes after sign-out", async () => {
    let finishRead!: (value: string) => void;
    const memory = memoryStore();
    const credentials = createDesktopHostedSessionCredentials({
      ...memory.store,
      read: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    });
    const hydration = credentials.hydrate();
    await credentials.clear();
    finishRead("old-token");
    await hydration;
    expect(credentials.readBearerToken?.()).toBeNull();
  });

  it("creates one stable opaque installation id", async () => {
    const memory = memoryStore();
    const first = await getOrCreateDesktopInstallationId(memory.store);
    const second = await getOrCreateDesktopInstallationId(memory.store);
    expect(first).toMatch(/^install_[A-Za-z0-9_-]{22}$/);
    expect(second).toBe(first);
  });

  it("adopts the create-only winner when installation creators race", async () => {
    const winner = `install_${"A".repeat(22)}`;
    let memory!: ReturnType<typeof memoryStore>;
    memory = memoryStore(
      {},
      vi.fn(async () => {
        memory.records.set("installation-id", winner);
        return false;
      }),
    );
    await expect(getOrCreateDesktopInstallationId(memory.store)).resolves.toBe(winner);
  });

  it("hydrates, persists in call order, and durably clears the bearer token", async () => {
    const memory = memoryStore({ "hub-session-token": "stored-token" });
    const credentials = createDesktopHostedSessionCredentials(memory.store);
    await credentials.hydrate();
    expect(credentials.readBearerToken?.()).toBe("stored-token");

    credentials.writeBearerToken?.("replacement-token");
    await credentials.flush();
    expect(memory.records.get("hub-session-token")).toBe("replacement-token");

    await credentials.clear();
    expect(credentials.readBearerToken?.()).toBeNull();
    expect(memory.records.has("hub-session-token")).toBe(false);
  });
});
