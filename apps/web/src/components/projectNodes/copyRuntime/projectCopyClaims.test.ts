import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createProjectCopyClaims,
  createStorageProjectCopyClaims,
  createWindowProjectCopyClaims,
  type ProjectCopyClaim,
  type ProjectCopyClaimStorage,
  type ProjectCopyClaims,
} from "./projectCopyClaims";

const key = () => `test:${crypto.randomUUID()}`;
const LEASE_PREFIX = "ryco:project-copy-claim:v1:";

/** A localStorage stand-in: every window of the test reads and writes the same items. */
function memoryStorage(items = new Map<string, string>()): ProjectCopyClaimStorage & {
  readonly items: Map<string, string>;
} {
  return {
    items,
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      items.set(name, value);
    },
    removeItem: (name) => {
      items.delete(name);
    },
    key: (index) => Array.from(items.keys())[index] ?? null,
    get length() {
      return items.size;
    },
  };
}

/** Claims through `storage` as one window does, with test timings. */
function storageClaims(
  storage: ProjectCopyClaimStorage,
  options: { readonly onPageHide?: (listener: () => void) => void } = {},
): ProjectCopyClaims {
  return createStorageProjectCopyClaims({
    storage,
    leaseMs: 1_000,
    renewEveryMs: 300,
    settleMs: 20,
    onPageHide: options.onPageHide ?? (() => undefined),
  });
}

/** Claims `copy` with fake timers running, past the claim's settle wait. */
async function claimWithTimers(
  claims: ProjectCopyClaims,
  copy: string,
  settleMs = 20,
): Promise<ProjectCopyClaim | null> {
  const claiming = claims.tryClaim(copy);
  await vi.advanceTimersByTimeAsync(settleMs);
  return claiming;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createProjectCopyClaims", () => {
  it("lets one holder at a time claim a copy, through Web Locks", async () => {
    // Two windows of one origin share these locks.
    const first = createProjectCopyClaims();
    const second = createProjectCopyClaims();
    const copy = key();

    const held = await first.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await second.tryClaim(copy)).toBeNull();
    expect(await first.tryClaim(copy)).toBeNull();

    held!.release();
    held!.release();
    await vi.waitFor(async () => {
      const next = await second.tryClaim(copy);
      expect(next).not.toBeNull();
      next!.release();
    });
  });

  it("claims again right after letting go in the same window", async () => {
    const claims = createProjectCopyClaims();
    const copy = key();
    const held = await claims.tryClaim(copy);
    held!.release();
    // A retry right after a run ended must not find its own lock still held.
    const again = await claims.tryClaim(copy);
    expect(again).not.toBeNull();
    again!.release();
  });

  it("shares claims between windows through storage where Web Locks refuse", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refuse = async () => {
      throw new DOMException("The request is not allowed.", "SecurityError");
    };
    const storage = memoryStorage();
    const first = createProjectCopyClaims(refuse, storageClaims(storage));
    const second = createProjectCopyClaims(refuse, storageClaims(storage));
    const copy = key();

    const held = await first.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await first.tryClaim(copy)).toBeNull();
    expect(await second.tryClaim(copy)).toBeNull();
    held!.release();
    const next = await second.tryClaim(copy);
    expect(next).not.toBeNull();
    next!.release();
    expect(warn).toHaveBeenCalled();
  });

  it("shares claims between windows without Web Locks (plain HTTP on the LAN)", async () => {
    vi.useFakeTimers();
    // No `navigator.locks` outside a secure context: the default claims go through
    // the storage the records are kept in, which every window of the origin shares.
    const first = createProjectCopyClaims(null);
    const second = createProjectCopyClaims(null);
    const copy = key();

    const held = await claimWithTimers(first, copy, 200);
    expect(held).not.toBeNull();
    expect(await claimWithTimers(second, copy, 200)).toBeNull();
    held!.release();
    const next = await claimWithTimers(second, copy, 200);
    expect(next).not.toBeNull();
    next!.release();
  });
});

describe("createStorageProjectCopyClaims", () => {
  it("lets one window at a time hold a key, and lets go on release", async () => {
    const storage = memoryStorage();
    const first = storageClaims(storage);
    const second = storageClaims(storage);
    const copy = key();

    const held = await first.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await first.tryClaim(copy)).toBeNull();
    expect(await second.tryClaim(copy)).toBeNull();

    held!.release();
    held!.release();
    expect(storage.items.size).toBe(0);
    const next = await second.tryClaim(copy);
    expect(next).not.toBeNull();
    next!.release();
  });

  it("of two windows that both found a key free, only the one written last holds it", async () => {
    const storage = memoryStorage();
    // The second window read before the first one's lease reached it.
    let stale = true;
    const late: ProjectCopyClaimStorage = {
      ...storage,
      getItem: (name) => {
        if (!stale) return storage.getItem(name);
        stale = false;
        return null;
      },
      key: storage.key,
      get length() {
        return storage.length;
      },
    };
    const copy = key();
    const [first, second] = await Promise.all([
      storageClaims(storage).tryClaim(copy),
      storageClaims(late).tryClaim(copy),
    ]);
    expect(first).toBeNull();
    expect(second).not.toBeNull();
    second!.release();
  });

  it("renews a lease while it is held, and takes over one its window stopped renewing", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const holder = storageClaims(storage);
    const other = storageClaims(storage);
    const copy = key();

    const held = await claimWithTimers(holder, copy);
    // Several lease lengths later the holder still has it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await claimWithTimers(other, copy)).toBeNull();
    held!.release();

    // A window that crashed left a lease nobody renews.
    const crashed = key();
    storage.setItem(
      `${LEASE_PREFIX}${crashed}`,
      JSON.stringify({ token: "crashed", expiresAt: Date.now() + 1_000 }),
    );
    expect(await claimWithTimers(other, crashed)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    const taken = await claimWithTimers(other, crashed);
    expect(taken).not.toBeNull();
    taken!.release();
  });

  it("lets go of its leases when the page goes away", async () => {
    const storage = memoryStorage();
    let pageHide: () => void = () => undefined;
    const closing = storageClaims(storage, {
      onPageHide: (listener) => {
        pageHide = listener;
      },
    });
    const copy = key();
    expect(await closing.tryClaim(copy)).not.toBeNull();
    // A reload: the new page resumes the copy at once.
    pageHide();
    const next = await storageClaims(storage).tryClaim(copy);
    expect(next).not.toBeNull();
    next!.release();
  });

  it("clears the leases crashed windows left, keeping live ones", () => {
    const storage = memoryStorage();
    storage.setItem(
      `${LEASE_PREFIX}gone`,
      JSON.stringify({ token: "a", expiresAt: Date.now() - 1 }),
    );
    storage.setItem(`${LEASE_PREFIX}garbled`, "{");
    storage.setItem(
      `${LEASE_PREFIX}live`,
      JSON.stringify({ token: "b", expiresAt: Date.now() + 60_000 }),
    );
    storage.setItem("ryco:project-copies:v1", "[]");
    storageClaims(storage);
    expect(Array.from(storage.items.keys())).toEqual([
      `${LEASE_PREFIX}live`,
      "ryco:project-copies:v1",
    ]);
  });

  it("claims for this window alone where storage refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = memoryStorage();
    const claims = storageClaims({
      ...storage,
      setItem: () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
      key: storage.key,
      get length() {
        return storage.length;
      },
    });
    const copy = key();
    const held = await claims.tryClaim(copy);
    expect(held).not.toBeNull();
    expect(await claims.tryClaim(copy)).toBeNull();
    held!.release();
    expect(await claims.tryClaim(copy)).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("createWindowProjectCopyClaims", () => {
  it("keeps one holder per key in this window", async () => {
    const claims = createWindowProjectCopyClaims();
    const copy = key();
    expect(await claims.tryClaim(copy)).not.toBeNull();
    expect(await claims.tryClaim(copy)).toBeNull();
  });
});
