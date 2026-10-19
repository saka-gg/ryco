import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acquireHostedPreviewLease,
  forgetHostedPreviewOwner,
  noteHostedPreviewInteraction,
  readHostedPreviewLeaseHolder,
  resetHostedPreviewLeaseForTests,
  subscribeHostedPreviewLease,
} from "./hostedPreviewLease";

afterEach(() => {
  resetHostedPreviewLeaseForTests();
});

/** Records the holder each time the lease changes hands. */
function recordHolders(): Array<string | null> {
  const seen: Array<string | null> = [];
  subscribeHostedPreviewLease(() => seen.push(readHostedPreviewLeaseHolder()));
  return seen;
}

describe("hosted preview lease", () => {
  it("grants the lease to the first owner and reports no holder after release", () => {
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    const lease = acquireHostedPreviewLease("a");
    expect(lease.granted).toBe(true);
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    lease.release();
    expect(readHostedPreviewLeaseHolder()).toBeNull();
  });

  it("gives the lease to the newest owner while nobody has interacted", () => {
    const first = acquireHostedPreviewLease("a");
    const holders = recordHolders();
    const second = acquireHostedPreviewLease("b");
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(true);
    expect(readHostedPreviewLeaseHolder()).toBe("b");
    expect(holders).toEqual(["b"]);
  });

  it("keeps the lease with an owner that interacted when another one arrives", () => {
    acquireHostedPreviewLease("a");
    noteHostedPreviewInteraction("a");
    const late = acquireHostedPreviewLease("b");
    expect(late.granted).toBe(false);
    expect(readHostedPreviewLeaseHolder()).toBe("a");
  });

  it("hands the lease to the owner that interacted most recently and notifies the previous holder", () => {
    acquireHostedPreviewLease("a");
    acquireHostedPreviewLease("b");
    noteHostedPreviewInteraction("a");
    expect(readHostedPreviewLeaseHolder()).toBe("a");

    const holders = recordHolders();
    noteHostedPreviewInteraction("b");
    expect(readHostedPreviewLeaseHolder()).toBe("b");
    expect(holders).toEqual(["b"]);

    // The holder interacting again changes nothing.
    noteHostedPreviewInteraction("b");
    expect(holders).toEqual(["b"]);
  });

  it("hands the lease to the best remaining owner when the holder releases", () => {
    const a = acquireHostedPreviewLease("a");
    const b = acquireHostedPreviewLease("b");
    const c = acquireHostedPreviewLease("c");
    noteHostedPreviewInteraction("a");
    noteHostedPreviewInteraction("c");
    expect(readHostedPreviewLeaseHolder()).toBe("c");

    const holders = recordHolders();
    c.release();
    // Interaction outranks acquisition order, so "a" beats the newer "b".
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    a.release();
    expect(readHostedPreviewLeaseHolder()).toBe("b");
    b.release();
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    expect(holders).toEqual(["a", "b", null]);
  });

  it("does not notify when a non-holder releases", () => {
    const a = acquireHostedPreviewLease("a");
    noteHostedPreviewInteraction("a");
    const b = acquireHostedPreviewLease("b");
    const holders = recordHolders();
    b.release();
    expect(holders).toEqual([]);
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    a.release();
  });

  it("ignores interactions from owners without a lease", () => {
    const holders = recordHolders();
    noteHostedPreviewInteraction("ghost");
    expect(holders).toEqual([]);
    expect(readHostedPreviewLeaseHolder()).toBeNull();

    const lease = acquireHostedPreviewLease("a");
    lease.release();
    noteHostedPreviewInteraction("a");
    expect(readHostedPreviewLeaseHolder()).toBeNull();
  });

  it.each([[["a", "b"]], [["b", "a"]]])(
    "keeps the owner that interacted in front when previews release and return as %j",
    (order) => {
      const leases = new Map([
        ["a", acquireHostedPreviewLease("a")],
        ["b", acquireHostedPreviewLease("b")],
      ]);
      noteHostedPreviewInteraction("a");
      expect(readHostedPreviewLeaseHolder()).toBe("a");

      // The tab is hidden: every preview lets go, then each takes the lease again.
      for (const ownerId of order) leases.get(ownerId)!.release();
      expect(readHostedPreviewLeaseHolder()).toBeNull();
      for (const ownerId of order) leases.set(ownerId, acquireHostedPreviewLease(ownerId));
      expect(readHostedPreviewLeaseHolder()).toBe("a");
    },
  );

  it("ranks by interaction recency across releases", () => {
    const a = acquireHostedPreviewLease("a");
    const b = acquireHostedPreviewLease("b");
    noteHostedPreviewInteraction("a");
    noteHostedPreviewInteraction("b");
    a.release();
    b.release();
    // "b" interacted last, whichever order they come back in.
    acquireHostedPreviewLease("b");
    acquireHostedPreviewLease("a");
    expect(readHostedPreviewLeaseHolder()).toBe("b");
  });

  it("forgets the interaction history of an owner that goes away", () => {
    acquireHostedPreviewLease("a");
    noteHostedPreviewInteraction("a");
    const holders = recordHolders();
    forgetHostedPreviewOwner("a");
    expect(readHostedPreviewLeaseHolder()).toBeNull();
    expect(holders).toEqual([null]);

    // A new owner with the same id starts from nothing: it ranks below one that interacted.
    acquireHostedPreviewLease("b");
    noteHostedPreviewInteraction("b");
    const returning = acquireHostedPreviewLease("a");
    expect(returning.granted).toBe(false);
    expect(readHostedPreviewLeaseHolder()).toBe("b");
  });

  it("treats forgetting an unknown owner as a no-op and invalidates its old handle", () => {
    const holders = recordHolders();
    forgetHostedPreviewOwner("ghost");
    expect(holders).toEqual([]);

    const stale = acquireHostedPreviewLease("a");
    forgetHostedPreviewOwner("a");
    const fresh = acquireHostedPreviewLease("a");
    stale.release();
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    fresh.release();
  });

  it("treats release as idempotent and ignores a stale handle after re-acquiring", () => {
    const stale = acquireHostedPreviewLease("a");
    const fresh = acquireHostedPreviewLease("a");
    stale.release();
    expect(readHostedPreviewLeaseHolder()).toBe("a");
    fresh.release();
    fresh.release();
    expect(readHostedPreviewLeaseHolder()).toBeNull();
  });

  it("lets a listener change the lease while the others are notified", () => {
    let reacted = false;
    subscribeHostedPreviewLease(() => {
      if (reacted) return;
      reacted = true;
      acquireHostedPreviewLease("late");
    });
    const holders = recordHolders();
    acquireHostedPreviewLease("a");
    expect(readHostedPreviewLeaseHolder()).toBe("late");
    expect(holders.at(-1)).toBe("late");
  });

  it("stops notifying an unsubscribed listener and tolerates unsubscribing while notified", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHostedPreviewLease(listener);
    acquireHostedPreviewLease("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    acquireHostedPreviewLease("b");
    expect(listener).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    const stop = subscribeHostedPreviewLease(() => stop());
    subscribeHostedPreviewLease(later);
    acquireHostedPreviewLease("c");
    expect(later).toHaveBeenCalledTimes(1);
  });
});
