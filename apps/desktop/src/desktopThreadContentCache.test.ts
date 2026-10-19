import * as FS from "node:fs";
import * as FSPromises from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  THREAD_CONTENT_CACHE_MAX_THREADS,
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
} from "@ryco/client-runtime/state/threads/threadContentCachePolicy";
import type {
  WorkspaceMetadataCache,
  WorkspaceMetadataCacheNamespace,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED,
  DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS,
  createDesktopThreadContentCache,
  withThreadContentPurges,
  type DesktopThreadContentCache,
  type DesktopThreadContentScope,
} from "./desktopThreadContentCache.ts";
import type { DesktopSecretProtection } from "./protectedRecordStore.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const HUB_ORIGIN = "https://hub.example";
const SECRET_MARKER = "conversation-secret-marker";

const temporaryDirectories: string[] = [];
const openCaches: DesktopThreadContentCache[] = [];

/** A reversible stand-in for the OS key: unreadable without `decryptString`. */
function fakeProtection(available = { value: true }): DesktopSecretProtection {
  const mask = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => available.value,
    encryptString: (plaintext) => mask(Buffer.from(plaintext, "utf8")),
    decryptString: (ciphertext) => mask(ciphertext).toString("utf8"),
  };
}

function temporaryDirectory(): string {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-thread-content-"));
  temporaryDirectories.push(root);
  return Path.join(root, "desktop-workspace-client");
}

/** Every cache is disposed after its test so no deferred write outlives its directory. */
function openCache(
  directory: string,
  overrides: {
    readonly protection?: DesktopSecretProtection;
    readonly hubOrigin?: string;
    readonly now?: () => number;
  } = {},
): DesktopThreadContentCache {
  const cache = createDesktopThreadContentCache({
    directory,
    hubOrigin: overrides.hubOrigin ?? HUB_ORIGIN,
    protection: overrides.protection ?? fakeProtection(),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  openCaches.push(cache);
  return cache;
}

const cacheFile = (directory: string) => Path.join(directory, "thread-content-v1.enc");
const settingsFile = (directory: string) => Path.join(directory, "thread-content-settings.json");

const scope = (environmentId: string, accountId = "account-a"): DesktopThreadContentScope => ({
  accountId,
  environmentId,
});

function thread(name: string, text = `${SECRET_MARKER} ${name}`) {
  return {
    messages: [
      {
        id: `${name}-message`,
        role: "assistant",
        text,
        createdAt: "2026-10-01T00:00:00Z",
        turnId: null,
        streaming: false,
      },
    ],
  };
}

/** Threads in the order the renderer sends them: least recently visited first. */
function threads(names: ReadonlyArray<string>, text?: (name: string) => string) {
  return Object.fromEntries(names.map((name) => [name, thread(name, text?.(name))]));
}

const threadIds = (content: object) => Object.keys(content);

const writeFile = vi.mocked(FSPromises.writeFile);

beforeEach(() => {
  writeFile.mockClear();
});

afterEach(async () => {
  await Promise.all(openCaches.splice(0).map((cache) => cache.dispose().catch(() => undefined)));
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop thread content cache", () => {
  it("keeps content across restarts, encrypted, in a private file", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("environment-1"), threads(["a", "b"]));
    await cache.flush();

    const reopened = openCache(directory);
    expect(threadIds(await reopened.load(scope("environment-1")))).toEqual(["a", "b"]);
    expect((await reopened.load(scope("environment-1")))["a"]).toEqual(thread("a"));

    const stored = FS.readFileSync(cacheFile(directory), "utf8");
    expect(stored).not.toContain(SECRET_MARKER);
    expect(Buffer.from(stored.split("\n")[1] ?? "", "base64").toString("utf8")).not.toContain(
      SECRET_MARKER,
    );
    if (process.platform !== "win32") {
      expect(FS.statSync(cacheFile(directory)).mode & 0o077).toBe(0);
    }
  });

  it("serves content only to the account and environment it was saved for", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("environment-1"), threads(["a"]));

    expect(threadIds(await cache.load(scope("environment-1")))).toEqual(["a"]);
    expect(await cache.load(scope("environment-2"))).toEqual({});
    expect(await cache.load(scope("environment-1", "account-b"))).toEqual({});
    // Another Hub origin never sees it either, and replaces the file on its next write.
    await cache.flush();
    const elsewhere = openCache(directory, { hubOrigin: "https://other.example" });
    expect(await elsewhere.load(scope("environment-1"))).toEqual({});
  });

  it("serializes reads with pending writes and purges", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    const publishing = cache.publish(scope("environment-1"), threads(["a"]));
    const reading = cache.load(scope("environment-1"));
    const purging = cache.purgeEnvironment(scope("environment-1"));
    const after = cache.load(scope("environment-1"));
    await publishing;
    expect(threadIds(await reading)).toEqual(["a"]);
    await purging;
    expect(await after).toEqual({});
    expect(await openCache(directory).load(scope("environment-1"))).toEqual({});
  });
});

describe("Desktop thread content cache encryption", () => {
  it("never writes or serves content while encryption is unavailable", async () => {
    const directory = temporaryDirectory();
    const available = { value: false };
    const cache = openCache(directory, { protection: fakeProtection(available) });

    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(await cache.load(scope("environment-1"))).toEqual({});

    // Once encryption is available the same cache accepts content.
    available.value = true;
    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(true);
  });

  it("cannot read what it cannot decrypt, and a purge still removes it", async () => {
    const directory = temporaryDirectory();
    const available = { value: true };
    const protection = fakeProtection(available);
    const writer = openCache(directory, { protection });
    await writer.publish(scope("environment-1"), threads(["a"]));
    await writer.flush();

    available.value = false;
    const locked = openCache(directory, { protection });
    expect(await locked.load(scope("environment-1"))).toEqual({});
    await locked.purgeAccount("account-a");
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
  });

  it("does not leave a file behind when the content cannot be encrypted at write time", async () => {
    const directory = temporaryDirectory();
    const available = { value: true };
    const cache = openCache(directory, { protection: fakeProtection(available) });
    await cache.publish(scope("environment-1"), threads(["a"]));
    available.value = false;

    await expect(cache.flush()).rejects.toThrow("cannot be encrypted");
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    expect(FS.existsSync(directory) ? FS.readdirSync(directory) : []).toEqual([]);
  });
});

describe("Desktop thread content cache setting", () => {
  it("defaults to the shared default until the user chooses", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    expect(DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED).toBe(true);
    expect(await cache.isEnabled()).toBe(DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED);
    expect(FS.existsSync(settingsFile(directory))).toBe(false);
  });

  it("persists the choice and purges when it is turned off", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(true);

    await cache.setEnabled(false);
    expect(await cache.isEnabled()).toBe(false);
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    expect(await cache.load(scope("environment-1"))).toEqual({});

    // Off stays off for new content and across restarts.
    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    const reopened = openCache(directory);
    expect(await reopened.isEnabled()).toBe(false);

    await reopened.setEnabled(true);
    expect(await openCache(directory).isEnabled()).toBe(true);
    await reopened.publish(scope("environment-1"), threads(["a"]));
    expect(threadIds(await reopened.load(scope("environment-1")))).toEqual(["a"]);
  });

  it("discards content that was only waiting to be written when it is turned off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.setEnabled(false);

    vi.advanceTimersByTime(60_000);
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(FS.readFileSync(settingsFile(directory), "utf8"))).toEqual({
      version: 1,
      enabled: false,
    });
  });

  it("stays off for this run even when the choice cannot be saved", async () => {
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("environment-1"), threads(["a"]));
    await cache.flush();

    writeFile.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(cache.setEnabled(false)).rejects.toThrow("disk unavailable");
    expect(await cache.isEnabled()).toBe(false);
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
  });

  it("ignores a setting file it cannot understand", async () => {
    const directory = temporaryDirectory();
    FS.mkdirSync(directory, { recursive: true });
    FS.writeFileSync(settingsFile(directory), '{"version":1,"enabled":"yes"}');
    expect(await openCache(directory).isEnabled()).toBe(
      DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED,
    );
    FS.writeFileSync(settingsFile(directory), "not json");
    expect(await openCache(directory).isEnabled()).toBe(
      DESKTOP_THREAD_CONTENT_CACHE_DEFAULT_ENABLED,
    );
  });
});

describe("Desktop thread content cache bounds", () => {
  it("keeps the most recent threads when more than the cap arrive", async () => {
    const cache = openCache(temporaryDirectory());
    const names = Array.from(
      { length: THREAD_CONTENT_CACHE_MAX_THREADS + 8 },
      (_, index) => `thread-${String(index).padStart(2, "0")}`,
    );
    await cache.publish(scope("environment-1"), threads(names));

    const kept = threadIds(await cache.load(scope("environment-1")));
    expect(kept).toEqual(names.slice(-THREAD_CONTENT_CACHE_MAX_THREADS));
  });

  it("drops the least recently visited threads to stay within the record budget", async () => {
    const cache = openCache(temporaryDirectory());
    const names = ["oldest", "older", "newer", "newest", "routed"];
    // 450 kB of text each: five of them exceed the budget, four do not.
    const text = () => "x".repeat(450_000);
    expect(5 * 450_000).toBeGreaterThan(THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES);
    await cache.publish(scope("environment-1"), threads(names, text));

    const kept = await cache.load(scope("environment-1"));
    expect(threadIds(kept)).toEqual(["older", "newer", "newest", "routed"]);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
      THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
    );
  });

  it("drops threads and messages the policy does not accept", async () => {
    const cache = openCache(temporaryDirectory());
    await cache.publish(scope("environment-1"), {
      ...threads(["good"]),
      noMessages: { messages: "nope" },
      badRole: { messages: [{ ...thread("x").messages[0], role: "tool" }] },
      notAThread: 4,
    });
    expect(threadIds(await cache.load(scope("environment-1")))).toEqual(["good"]);

    for (const invalid of [null, [], "text", 7]) {
      await cache.publish(scope("environment-2"), invalid);
      expect(await cache.load(scope("environment-2"))).toEqual({});
    }
  });

  it("keeps at most three environments, dropping the least recently updated", async () => {
    let clock = 1;
    const directory = temporaryDirectory();
    const cache = openCache(directory, { now: () => clock++ });
    expect(DESKTOP_THREAD_CONTENT_CACHE_MAX_ENVIRONMENTS).toBe(3);
    for (const environment of ["env-1", "env-2", "env-3"]) {
      await cache.publish(scope(environment), threads(["a"]));
    }
    // Updating the first makes the second the least recently updated.
    await cache.publish(scope("env-1"), threads(["a", "b"]));
    await cache.publish(scope("env-4"), threads(["a"]));

    expect(await cache.load(scope("env-2"))).toEqual({});
    for (const environment of ["env-1", "env-3", "env-4"]) {
      expect(Object.keys(await cache.load(scope(environment))).length).toBeGreaterThan(0);
    }
    await cache.flush();
    const reopened = openCache(directory);
    expect(await reopened.load(scope("env-2"))).toEqual({});
    expect(threadIds(await reopened.load(scope("env-1")))).toEqual(["a", "b"]);
  });

  it("holds one account at a time: new content drops another account's", async () => {
    const cache = openCache(temporaryDirectory());
    await cache.publish(scope("env-1", "account-a"), threads(["a"]));
    await cache.publish(scope("env-2", "account-b"), threads(["b"]));

    expect(await cache.load(scope("env-1", "account-a"))).toEqual({});
    expect(threadIds(await cache.load(scope("env-2", "account-b")))).toEqual(["b"]);
  });

  it("removes an environment's content when it is published empty", async () => {
    const cache = openCache(temporaryDirectory());
    await cache.publish(scope("env-1"), threads(["a"]));
    await cache.publish(scope("env-1"), {});
    expect(await cache.load(scope("env-1"))).toEqual({});
  });
});

describe("Desktop thread content cache purges", () => {
  const filled = async (directory: string) => {
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));
    await cache.publish(scope("env-2"), threads(["b"]));
    await cache.flush();
    writeFile.mockClear();
    return cache;
  };

  it("purges one environment", async () => {
    const directory = temporaryDirectory();
    const cache = await filled(directory);
    await cache.purgeEnvironment(scope("env-1"));

    expect(await cache.load(scope("env-1"))).toEqual({});
    expect(threadIds(await cache.load(scope("env-2")))).toEqual(["b"]);
    expect(threadIds(await openCache(directory).load(scope("env-2")))).toEqual(["b"]);
  });

  it("purges an account, removing the file once nothing is left", async () => {
    const directory = temporaryDirectory();
    const cache = await filled(directory);
    await cache.purgeAccount("account-a");

    expect(FS.existsSync(cacheFile(directory))).toBe(false);
    expect(await cache.load(scope("env-1"))).toEqual({});
  });

  it("retains one account and forgets the rest", async () => {
    const directory = temporaryDirectory();
    const cache = await filled(directory);
    await cache.retainAccount("account-a");
    expect(threadIds(await cache.load(scope("env-1")))).toEqual(["a"]);
    expect(writeFile).not.toHaveBeenCalled();

    await cache.retainAccount("account-b");
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
  });

  it("writes a purge at once, including changes still waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));
    await cache.publish(scope("env-2"), threads(["b"]));
    expect(FS.existsSync(cacheFile(directory))).toBe(false);

    await cache.purgeEnvironment(scope("env-1"));
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(threadIds(await openCache(directory).load(scope("env-2")))).toEqual(["b"]);

    // Nothing is left waiting.
    vi.advanceTimersByTime(20_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite the file for a purge that removes nothing", async () => {
    const directory = temporaryDirectory();
    const cache = await filled(directory);
    await cache.purgeEnvironment(scope("elsewhere"));
    await cache.purgeAccount("account-b");
    expect(writeFile).not.toHaveBeenCalled();
    expect(FS.existsSync(cacheFile(directory))).toBe(true);
  });
});

describe("Desktop thread content cache files", () => {
  const encodeWith = (records: ReadonlyArray<unknown>, hubOrigin = HUB_ORIGIN) => {
    const protection = fakeProtection();
    const encrypted = protection.encryptString(JSON.stringify({ version: 1, hubOrigin, records }));
    return `ryco-desktop-thread-content-v1\n${encrypted.toString("base64")}\n`;
  };
  const record = (environmentId: string, capturedAt: number, content: object = threads(["a"])) => ({
    accountId: "account-a",
    environmentId,
    capturedAt,
    content,
  });
  const seed = (directory: string, body: string) => {
    FS.mkdirSync(directory, { recursive: true });
    FS.writeFileSync(cacheFile(directory), body);
  };

  it("ignores files it cannot use and replaces them on the next write", async () => {
    for (const body of [
      "not a cache",
      "ryco-desktop-thread-content-v1\n%%%not base64%%%",
      `ryco-desktop-thread-content-v1\n${Buffer.from("plain text").toString("base64")}`,
      encodeWith([record("env-1", 1)], "https://other.example"),
      encodeWith("not records" as unknown as unknown[]),
    ]) {
      const directory = temporaryDirectory();
      seed(directory, body);
      const cache = openCache(directory);
      expect(await cache.load(scope("env-1"))).toEqual({});

      await cache.publish(scope("env-1"), threads(["fresh"]));
      await cache.flush();
      expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["fresh"]);
    }
  });

  it("refuses an oversized file without reading it", async () => {
    const directory = temporaryDirectory();
    seed(directory, "x".repeat(16 * 1024 * 1024 + 1));
    const cache = openCache(directory);
    expect(await cache.load(scope("env-1"))).toEqual({});
    await cache.purgeAccount("account-a");
    expect(FS.existsSync(cacheFile(directory))).toBe(false);
  });

  it("validates every record and thread it reads back", async () => {
    const directory = temporaryDirectory();
    const valid = record("env-1", 1);
    seed(
      directory,
      encodeWith([
        valid,
        { ...record("env-2", 2), capturedAt: -1 },
        { ...record("env-3", 3), accountId: "" },
        { ...record("env-4", 4), content: {} },
        record("env-5", 5, { ...threads(["kept"]), broken: { messages: [{ id: 1 }] } }),
        null,
      ]),
    );
    const cache = openCache(directory);

    expect(threadIds(await cache.load(scope("env-1")))).toEqual(["a"]);
    for (const environment of ["env-2", "env-3", "env-4"]) {
      expect(await cache.load(scope(environment))).toEqual({});
    }
    expect(threadIds(await cache.load(scope("env-5")))).toEqual(["kept"]);
  });

  it("bounds what it reads back to the environment cap", async () => {
    const directory = temporaryDirectory();
    seed(directory, encodeWith([1, 2, 3, 4, 5].map((index) => record(`env-${index}`, index))));
    const cache = openCache(directory);

    expect(await cache.load(scope("env-1"))).toEqual({});
    expect(await cache.load(scope("env-2"))).toEqual({});
    for (const environment of ["env-3", "env-4", "env-5"]) {
      expect(threadIds(await cache.load(scope(environment)))).toEqual(["a"]);
    }
  });

  it("bounds the threads of a record it reads back", async () => {
    const directory = temporaryDirectory();
    const names = Array.from(
      { length: THREAD_CONTENT_CACHE_MAX_THREADS + 10 },
      (_, index) => `thread-${String(index).padStart(2, "0")}`,
    );
    seed(directory, encodeWith([record("env-1", 1, threads(names))]));
    const cache = openCache(directory);

    expect(threadIds(await cache.load(scope("env-1")))).toHaveLength(
      THREAD_CONTENT_CACHE_MAX_THREADS,
    );
    // The file held more than the document does, so a purge that matches nothing still cleans it.
    await cache.purgeEnvironment(scope("elsewhere"));
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toHaveLength(
      THREAD_CONTENT_CACHE_MAX_THREADS,
    );
  });
});

describe("Desktop thread content cache writes", () => {
  function fakeClock() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  it("serves a change from memory at once and writes it after a quiet period", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));

    expect(threadIds(await cache.load(scope("env-1")))).toEqual(["a"]);
    vi.advanceTimersByTime(1_999);
    await cache.load(scope("env-1"));
    expect(FS.existsSync(cacheFile(directory))).toBe(false);

    vi.advanceTimersByTime(1);
    await cache.flush();
    expect(FS.existsSync(cacheFile(directory))).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("writes a burst of changes once, after the burst", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    for (const name of ["a", "b", "c", "d", "e"]) {
      await cache.publish(scope("env-1"), threads([name]));
      vi.advanceTimersByTime(1_500);
    }
    await cache.publish(scope("env-2"), threads(["z"]));
    expect(writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(1);
    const reopened = openCache(directory);
    expect(threadIds(await reopened.load(scope("env-1")))).toEqual(["e"]);
    expect(threadIds(await reopened.load(scope("env-2")))).toEqual(["z"]);
  });

  it("never defers a change beyond the maximum wait", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    // A change every 1.5 s keeps resetting the quiet period.
    for (let change = 1; change <= 6; change += 1) {
      await cache.publish(scope("env-1"), threads([`change-${change}`]));
      vi.advanceTimersByTime(1_500);
    }
    expect(writeFile).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await cache.flush();
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["change-6"]);

    // The next change starts a new wait.
    await cache.publish(scope("env-1"), threads(["change-7"]));
    vi.advanceTimersByTime(1_999);
    await cache.load(scope("env-1"));
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("flushes on dispose and writes every later change at once", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));
    expect(FS.existsSync(cacheFile(directory))).toBe(false);

    await cache.dispose();
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["a"]);

    await cache.publish(scope("env-1"), threads(["b"]));
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["b"]);
  });

  it("persists what is waiting when the process exits", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const hooksBefore = new Set(process.listeners("exit"));
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));
    const hooks = process.listeners("exit").filter((listener) => !hooksBefore.has(listener));
    expect(hooks).toHaveLength(1);
    expect(FS.existsSync(cacheFile(directory))).toBe(false);

    hooks[0]!(0);
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["a"]);

    // Once written, nothing is waiting and the hook is gone.
    await cache.flush();
    expect(process.listeners("exit").filter((listener) => !hooksBefore.has(listener))).toEqual([]);
  });

  it("keeps a change whose write failed and writes it on the next attempt", async () => {
    fakeClock();
    const directory = temporaryDirectory();
    const cache = openCache(directory);
    await cache.publish(scope("env-1"), threads(["a"]));
    writeFile.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(cache.flush()).rejects.toThrow("disk unavailable");
    expect(threadIds(await cache.load(scope("env-1")))).toEqual(["a"]);
    expect(FS.existsSync(cacheFile(directory))).toBe(false);

    await cache.flush();
    expect(threadIds(await openCache(directory).load(scope("env-1")))).toEqual(["a"]);
  });
});

describe("Desktop thread content purges alongside the metadata cache", () => {
  const namespace: WorkspaceMetadataCacheNamespace = {
    hubOrigin: HUB_ORIGIN,
    accountId: "account-a",
    environmentId: "env-1" as WorkspaceMetadataCacheNamespace["environmentId"],
  };

  function wiring() {
    const metadata = {
      load: vi.fn(async () => null),
      list: vi.fn(async () => []),
      replace: vi.fn(async () => undefined),
      purgeEnvironment: vi.fn(async () => undefined),
      purgeAccount: vi.fn(async () => undefined),
    } satisfies WorkspaceMetadataCache;
    const content = {
      purgeEnvironment: vi.fn(async () => undefined),
      purgeAccount: vi.fn(async () => undefined),
      retainAccount: vi.fn(async () => undefined),
    };
    return { metadata, content, cache: withThreadContentPurges(metadata, content) };
  }

  it("purges an environment's content with its metadata", async () => {
    const { metadata, content, cache } = wiring();
    await cache.purgeEnvironment(namespace);
    expect(metadata.purgeEnvironment).toHaveBeenCalledWith(namespace);
    expect(content.purgeEnvironment).toHaveBeenCalledWith({
      accountId: "account-a",
      environmentId: "env-1",
    });
  });

  it("purges an account's content on sign-out", async () => {
    const { metadata, content, cache } = wiring();
    await cache.purgeAccount({ hubOrigin: HUB_ORIGIN, accountId: "account-a" });
    expect(metadata.purgeAccount).toHaveBeenCalledOnce();
    expect(content.purgeAccount).toHaveBeenCalledWith("account-a");
  });

  it("drops other accounts' content when an account's metadata is read", async () => {
    const { metadata, content, cache } = wiring();
    await cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-b" });
    expect(metadata.list).toHaveBeenCalledOnce();
    expect(content.retainAccount).toHaveBeenCalledWith("account-b");
  });

  it("does not wait for the content on an account read", async () => {
    const { metadata, content, cache } = wiring();
    content.retainAccount.mockReturnValue(new Promise(() => undefined));
    await expect(cache.list({ hubOrigin: HUB_ORIGIN, accountId: "account-a" })).resolves.toEqual(
      [],
    );
    expect(metadata.list).toHaveBeenCalledOnce();
  });

  it("forgets the content even when the metadata purge fails, and not the other way round", async () => {
    const failing = wiring();
    failing.metadata.purgeEnvironment.mockRejectedValue(new Error("metadata unavailable"));
    await expect(failing.cache.purgeEnvironment(namespace)).rejects.toThrow("metadata unavailable");
    expect(failing.content.purgeEnvironment).toHaveBeenCalledOnce();

    const content = wiring();
    content.content.purgeAccount.mockRejectedValue(new Error("content unavailable"));
    await expect(
      content.cache.purgeAccount({ hubOrigin: HUB_ORIGIN, accountId: "account-a" }),
    ).resolves.toBeUndefined();
    expect(content.metadata.purgeAccount).toHaveBeenCalledOnce();
  });
});
