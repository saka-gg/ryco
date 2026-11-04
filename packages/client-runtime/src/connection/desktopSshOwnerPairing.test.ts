import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopSshOwnerRepairTracker,
  DESKTOP_SSH_OWNER_REPAIR_RETRY_MS,
  desktopSshMutateBlockedReason,
  desktopSshOwnerRepairRetryAt,
  shouldRepairDesktopSshAsOwner,
  type DesktopSshOwnerRepairInput,
} from "./desktopSshOwnerPairing.ts";

const NOW = 1_800_000_000_000;

const clientSshConnect: DesktopSshOwnerRepairInput = {
  desktopSsh: true,
  sessionRole: "client",
  bearerIssuedThisConnect: false,
  lastOutcome: undefined,
  serverVersion: "0.1.30",
  now: NOW,
};

describe("shouldRepairDesktopSshAsOwner", () => {
  it("re-pairs a Desktop SSH environment that presents a client bearer", () => {
    expect(shouldRepairDesktopSshAsOwner(clientSshConnect)).toBe(true);
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, serverVersion: null })).toBe(true);
  });

  it("leaves owner bearers and an unknown role alone", () => {
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: "owner" })).toBe(
      false,
    );
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: undefined })).toBe(
      false,
    );
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, sessionRole: null })).toBe(false);
  });

  it("never re-pairs an environment that is not reached over Desktop SSH", () => {
    expect(shouldRepairDesktopSshAsOwner({ ...clientSshConnect, desktopSsh: false })).toBe(false);
  });

  it("never re-pairs a client bearer this connect minted", () => {
    expect(
      shouldRepairDesktopSshAsOwner({ ...clientSshConnect, bearerIssuedThisConnect: true }),
    ).toBe(false);
  });

  it("asks a remote CLI that could not mint owner credentials again only on another Ryco version", () => {
    const unsupported = {
      ...clientSshConnect,
      lastOutcome: { kind: "unsupported", serverVersion: "0.1.30" },
    } as const;
    expect(shouldRepairDesktopSshAsOwner(unsupported)).toBe(false);
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, now: NOW + 24 * 60 * 60_000 })).toBe(
      false,
    );
    // The node was updated: its CLI may mint owner credentials now.
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, serverVersion: "0.1.36" })).toBe(true);
    // A version that cannot be read now proves nothing.
    expect(shouldRepairDesktopSshAsOwner({ ...unsupported, serverVersion: null })).toBe(false);
    // Found before the version could be read: the first known one is asked again.
    expect(
      shouldRepairDesktopSshAsOwner({
        ...unsupported,
        lastOutcome: { kind: "unsupported", serverVersion: null },
      }),
    ).toBe(true);
  });

  it("retries a failed re-pair on the same Ryco once its retry delay has passed", () => {
    const failed = {
      ...clientSshConnect,
      lastOutcome: { kind: "failed", at: NOW, serverVersion: "0.1.30" },
    } as const;
    expect(shouldRepairDesktopSshAsOwner(failed)).toBe(false);
    expect(shouldRepairDesktopSshAsOwner({ ...failed, serverVersion: null })).toBe(false);
    expect(
      shouldRepairDesktopSshAsOwner({
        ...failed,
        now: NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldRepairDesktopSshAsOwner({ ...failed, now: NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS }),
    ).toBe(true);
    expect(
      shouldRepairDesktopSshAsOwner({
        ...failed,
        serverVersion: null,
        now: NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS,
      }),
    ).toBe(true);
  });

  it("retries a failed re-pair at once when the node reports another Ryco version", () => {
    const failed = {
      ...clientSshConnect,
      lastOutcome: { kind: "failed", at: NOW, serverVersion: "0.1.30" },
    } as const;
    // Ryco was updated, and its server restarted, within the retry delay.
    expect(shouldRepairDesktopSshAsOwner({ ...failed, serverVersion: "0.1.36" })).toBe(true);
    // Failed before the version could be read: the first known one asks again.
    expect(
      shouldRepairDesktopSshAsOwner({
        ...failed,
        lastOutcome: { kind: "failed", at: NOW, serverVersion: null },
      }),
    ).toBe(true);
  });
});

describe("desktopSshOwnerRepairRetryAt", () => {
  it("retries a failed re-pair after its delay and an unsupported one never on time alone", () => {
    expect(desktopSshOwnerRepairRetryAt({ kind: "failed", at: NOW, serverVersion: null })).toBe(
      NOW + DESKTOP_SSH_OWNER_REPAIR_RETRY_MS,
    );
    expect(desktopSshOwnerRepairRetryAt({ kind: "unsupported", serverVersion: "0.1.30" })).toBe(
      null,
    );
  });
});

describe("createDesktopSshOwnerRepairTracker", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const otherEnvironmentId = EnvironmentId.make("environment-2");
  const clientSession = {
    sessionRole: "client",
    bearerIssuedThisConnect: false,
    serverVersion: "0.1.36",
  } as const;
  const sshHiccup = () => Promise.reject(new Error("ssh: Connection reset by peer"));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a failed re-pair due once its retry delay has passed, with no connect needed", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });

    await expect(tracker.run(environmentId, "0.1.36", sshHiccup)).rejects.toThrow("ssh:");
    expect(tracker.outcome(environmentId)).toEqual({
      kind: "failed",
      at: NOW,
      serverVersion: "0.1.36",
    });
    expect(tracker.shouldRepair(environmentId, clientSession)).toBe(false);

    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS - 1);
    expect(onRetryDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetryDue).toHaveBeenCalledExactlyOnceWith(environmentId);
    expect(tracker.shouldRepair(environmentId, clientSession)).toBe(true);

    vi.advanceTimersByTime(10 * DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).toHaveBeenCalledOnce();
  });

  it("cancels the retry once another outcome is recorded, and never times an unsupported one", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });

    await expect(tracker.run(environmentId, null, sshHiccup)).rejects.toThrow();
    await expect(tracker.run(otherEnvironmentId, null, sshHiccup)).rejects.toThrow();
    // A disconnect forgets one; the other turns out unsupported.
    tracker.record(environmentId, undefined);
    tracker.record(otherEnvironmentId, { kind: "unsupported", serverVersion: "0.1.30" });

    vi.advanceTimersByTime(10 * DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).not.toHaveBeenCalled();
    expect(tracker.shouldRepair(otherEnvironmentId, clientSession)).toBe(true);
    expect(
      tracker.shouldRepair(otherEnvironmentId, { ...clientSession, serverVersion: "0.1.30" }),
    ).toBe(false);
  });

  it("runs one re-pair at a time, and the running one's failure arms the next retry", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });
    await expect(tracker.run(environmentId, "0.1.36", sshHiccup)).rejects.toThrow();
    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).toHaveBeenCalledOnce();

    let failRunning!: (error: Error) => void;
    const running = tracker.run(
      environmentId,
      "0.1.36",
      () =>
        new Promise<never>((_resolve, reject) => {
          failRunning = reject;
        }),
    );
    expect(tracker.shouldRepair(environmentId, clientSession)).toBe(false);
    const second = vi.fn(async () => "never");
    await expect(tracker.run(environmentId, "0.1.36", second)).resolves.toBeNull();
    expect(second).not.toHaveBeenCalled();

    failRunning(new Error("database is locked"));
    await expect(running).rejects.toThrow("database is locked");
    expect(tracker.outcome(environmentId)).toMatchObject({ kind: "failed", at: Date.now() });
    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).toHaveBeenCalledTimes(2);
  });

  it("retries a re-pair given up midway, unless something settled the environment meanwhile", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });
    const cancelled = new Error("Saved environment environment-1 connection was cancelled.");

    // A hung attempt the connect gave up settled nothing.
    await expect(tracker.run(environmentId, null, () => Promise.reject(cancelled))).rejects.toBe(
      cancelled,
    );
    expect(tracker.outcome(environmentId)?.kind).toBe("failed");

    // A disconnect cancelled this one: what it recorded stands.
    await expect(
      tracker.run(otherEnvironmentId, null, async () => {
        tracker.record(otherEnvironmentId, undefined);
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    expect(tracker.outcome(otherEnvironmentId)).toBeUndefined();

    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).toHaveBeenCalledExactlyOnceWith(environmentId);
  });

  it("waits out a clock set back instead of retrying early", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });
    await expect(tracker.run(environmentId, null, sshHiccup)).rejects.toThrow();

    vi.setSystemTime(NOW - 60_000);
    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onRetryDue).toHaveBeenCalledOnce();
  });

  it("forgets every outcome and retry on reset", async () => {
    const onRetryDue = vi.fn();
    const tracker = createDesktopSshOwnerRepairTracker({ onRetryDue });
    await expect(tracker.run(environmentId, null, sshHiccup)).rejects.toThrow();

    tracker.reset();
    vi.advanceTimersByTime(DESKTOP_SSH_OWNER_REPAIR_RETRY_MS);
    expect(onRetryDue).not.toHaveBeenCalled();
    expect(tracker.outcome(environmentId)).toBeUndefined();
  });
});

describe("desktopSshMutateBlockedReason", () => {
  it("asks for a Ryco update on a Desktop SSH node still on a client session", () => {
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: "client", label: "Mac mini" }),
    ).toBe("Update Ryco on Mac mini to copy projects here");
  });

  it("blocks nothing for owner sessions, unknown roles or other saved environments", () => {
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: "owner", label: "Mac mini" }),
    ).toBeNull();
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: true, role: null, label: "Mac mini" }),
    ).toBeNull();
    expect(
      desktopSshMutateBlockedReason({ desktopSsh: false, role: "client", label: "Mac mini" }),
    ).toBeNull();
  });
});
