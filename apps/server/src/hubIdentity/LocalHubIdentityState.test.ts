import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  identitySecretsInService,
  LocalHubIdentityStateError,
  makeLocalHubIdentityStateStore,
  readActiveHubEnvironmentId,
} from "./LocalHubIdentityState.ts";

describe("local Hub identity state", () => {
  it("reads the Hub environment id only while an enrollment is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-active-"));
    const path = join(root, "identity.json");
    try {
      // Never enrolled: nothing is read, and no record is created.
      expect(await readActiveHubEnvironmentId(path)).toBeNull();
      await expect(readFile(path)).rejects.toThrow();

      const store = await makeLocalHubIdentityStateStore(path);
      const created = await store.readOrCreate();
      expect(await readActiveHubEnvironmentId(path)).toBeNull();

      const active = await store.update((state) => ({
        ...state,
        revision: state.revision + 1,
        activeNode: {
          hubOrigin: "https://hub.example.com",
          nodeId: `node_${"a".repeat(22)}`,
          activeKeyId: `nkey_${"b".repeat(22)}`,
          activeKeySecretName: "node-key.active",
          cleanupPollingSecretName: null,
          enrolledAt: 1,
        },
      }));
      expect(await readActiveHubEnvironmentId(path)).toBe(created.environmentId);

      // Leaving: the id is no longer this node's.
      await store.update((state) => ({
        ...state,
        revision: active.revision + 1,
        pendingTeardown: { secretNames: [], requestedAt: 2 },
      }));
      expect(await readActiveHubEnvironmentId(path)).toBeNull();

      // An unreadable record reads as no enrollment.
      await writeFile(path, "{", { mode: 0o600 });
      expect(await readActiveHubEnvironmentId(path)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a stable random EnvironmentId and survives restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-state-"));
    const path = join(root, "nested", "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    const created = await store.readOrCreate();
    expect(created.environmentId).toMatch(/^env_[A-Za-z0-9_-]{22}$/);
    expect(created.revision).toBe(0);
    expect(created.protectedStoreBackend).toBeNull();
    expect(created.activeNode).toBeNull();

    const restarted = await makeLocalHubIdentityStateStore(path);
    expect(await restarted.readOrCreate()).toEqual(created);
    if (process.platform !== "win32") {
      await expect(
        (await import("node:fs/promises")).lstat(path).then((stat) => stat.mode & 0o777),
      ).resolves.toBe(0o600);
    }
  });

  it("persists protected-store references but no polling bearer", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-pending-"));
    const path = join(root, "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    const initial = await store.readOrCreate();
    const pollingCanary = "raw-polling-secret-must-not-be-written";
    const updated = await store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      pendingEnrollment: {
        hubOrigin: "https://hub.example.com",
        keySecretName: "node-key.pending",
        pollingSecretName: "enrollment-poll.pending",
        label: "Build node",
        deviceCode: "ABCD-EFGH",
        createdAt: 1_784_160_000_000,
        expiresAt: 1_784_160_600_000,
        pollIntervalMs: 5_000,
        cleanupRequested: false,
      },
    }));
    expect(updated.environmentId).toBe(initial.environmentId);
    const persisted = await readFile(path, "utf8");
    expect(persisted).toContain("enrollment-poll.pending");
    expect(persisted).toContain('"label":"Build node"');
    expect(persisted).not.toContain(pollingCanary);
  });

  it("reads a pending record written before device codes were persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-legacy-pending-"));
    const path = join(root, "identity.json");
    // Exactly the shape written by a build that predates `deviceCode`. Failing
    // this closed would strand a live ceremony — and, worse, would fail the whole
    // state read, taking an enrolled node offline for a field it never had.
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        revision: 3,
        environmentId: `env_${"E".repeat(22)}`,
        pendingEnrollment: {
          hubOrigin: "https://hub.example.com",
          keySecretName: "node-key.pending",
          pollingSecretName: "enrollment-poll.pending",
          createdAt: 1_784_160_000_000,
          expiresAt: 1_784_160_600_000,
          pollIntervalMs: 5_000,
          cleanupRequested: false,
        },
        activeNode: null,
        stagedRotation: null,
      }),
      { mode: 0o600 },
    );

    const store = await makeLocalHubIdentityStateStore(path);
    const state = await store.readOrCreate();

    expect(state.pendingEnrollment?.deviceCode).toBeNull();
    expect(state.pendingEnrollment?.label).toBeNull();
    expect(state.protectedStoreBackend).toBeNull();
    expect(state.pendingEnrollment?.keySecretName).toBe("node-key.pending");
    expect(state.revision).toBe(3);
  });

  it("persists only the bounded protected-store custody class", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-backend-"));
    const path = join(root, "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    await store.readOrCreate();
    const updated = await store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      protectedStoreBackend: "permissioned-file",
    }));

    expect(updated.protectedStoreBackend).toBe("permissioned-file");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      protectedStoreBackend: "permissioned-file",
    });
  });

  it("rejects an unbounded protected-store backend value", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-bad-backend-"));
    const path = join(root, "identity.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        revision: 1,
        environmentId: `env_${"E".repeat(22)}`,
        protectedStoreBackend: "remote-private-canary",
        pendingEnrollment: null,
        activeNode: null,
        stagedRotation: null,
        pendingTeardown: null,
      }),
      { mode: 0o600 },
    );

    const store = await makeLocalHubIdentityStateStore(path);
    await expect(store.readOrCreate()).rejects.toMatchObject({ code: "identity_state_corrupt" });
  });

  it("rejects a pending device code that is unbounded or out of charset", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-bad-code-"));
    const path = join(root, "identity.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        revision: 1,
        environmentId: `env_${"E".repeat(22)}`,
        pendingEnrollment: {
          hubOrigin: "https://hub.example.com",
          keySecretName: "node-key.pending",
          pollingSecretName: "enrollment-poll.pending",
          deviceCode: "x".repeat(4096),
          createdAt: 1_784_160_000_000,
          expiresAt: 1_784_160_600_000,
          pollIntervalMs: 5_000,
          cleanupRequested: false,
        },
        activeNode: null,
        stagedRotation: null,
      }),
      { mode: 0o600 },
    );

    const store = await makeLocalHubIdentityStateStore(path);
    await expect(store.readOrCreate()).rejects.toMatchObject({ code: "identity_state_corrupt" });
  });

  it("rejects an invalid persisted pending label without reflecting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-bad-label-"));
    const path = join(root, "identity.json");
    const canary = `private-machine-${"x".repeat(100)}`;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        revision: 1,
        environmentId: `env_${"E".repeat(22)}`,
        pendingEnrollment: {
          hubOrigin: "https://hub.example.com",
          keySecretName: "node-key.pending",
          pollingSecretName: "enrollment-poll.pending",
          label: canary,
          deviceCode: "ABCD-EFGH",
          createdAt: 1_784_160_000_000,
          expiresAt: 1_784_160_600_000,
          pollIntervalMs: 5_000,
          cleanupRequested: false,
        },
        activeNode: null,
        stagedRotation: null,
      }),
      { mode: 0o600 },
    );

    const store = await makeLocalHubIdentityStateStore(path);
    let error: unknown;
    try {
      await store.readOrCreate();
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ code: "identity_state_corrupt" });
    expect(String(error)).not.toContain(canary);
  });

  it("rejects environment replacement and invalid revision transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-invalid-update-"));
    const store = await makeLocalHubIdentityStateStore(join(root, "identity.json"));
    await store.readOrCreate();
    await expect(
      store.update((current) => ({
        ...current,
        environmentId: "env_ZZZZZZZZZZZZZZZZZZZZZZ",
        revision: current.revision + 1,
      })),
    ).rejects.toMatchObject({ code: "identity_state_operation_failed" });
    await expect(store.update((current) => ({ ...current }))).rejects.toMatchObject({
      code: "identity_state_operation_failed",
    });
  });

  it("drops fields it does not know on its next write", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-forward-"));
    const path = join(root, "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    const initial = await store.readOrCreate();
    await writeFile(path, `${JSON.stringify({ ...initial, addedByANewerBinary: "lineage" })}\n`, {
      mode: 0o600,
    });

    await store.update((current) => ({ ...current, revision: current.revision + 1 }));

    // Not a defect — this record is reconstructed from its known keys by design,
    // and that is exactly why durable state which must survive a downgrade does
    // not live here. A binary older than any field silently deletes it, which
    // for §7.5 continuity lineage would be a fleet-wide re-verification event
    // caused by a routine rollback (`NodeIdentityContinuityStore`), and for the
    // §6.4 agreement-key names would be private keys nothing can ever destroy
    // (`NodeE2eePrekeyStore`). Both live in records of their own for that
    // reason, and neither is reachable from this file.
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(stored.addedByANewerBinary).toBeUndefined();
    expect(stored.environmentId).toBe(initial.environmentId);
  });

  it("serializes concurrent writers instead of failing one of them", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-race-"));
    const store = await makeLocalHubIdentityStateStore(join(root, "identity.json"));
    const initial = await store.readOrCreate();
    const results = await Promise.allSettled([
      store.update((current) => ({ ...current, revision: current.revision + 1 })),
      store.update((current) => ({ ...current, revision: current.revision + 1 })),
    ]);

    // Both run, one after the other, and the second sees the first's write.
    // Brief contention must not be an outcome: these records are read on the
    // capability-advertisement path, where a spurious failure is a §5.5 U2
    // `statement-unavailable` the node inflicted on itself.
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await store.readOrCreate()).revision).toBe(initial.revision + 2);
  });

  it("reports every secret it currently calls in service", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-in-service-"));
    const store = await makeLocalHubIdentityStateStore(join(root, "identity.json"));
    const initial = await store.readOrCreate();
    expect(identitySecretsInService(initial).size).toBe(0);

    const enrolled = await store.update((current) => ({
      ...current,
      revision: current.revision + 1,
      activeNode: {
        hubOrigin: "https://hub.example.com",
        nodeId: `node_${"N".repeat(22)}`,
        activeKeyId: `nkey_${"K".repeat(22)}`,
        activeKeySecretName: "node-key.active",
        cleanupPollingSecretName: "node-poll.cleanup",
        enrolledAt: 1,
      },
      stagedRotation: {
        hubOrigin: "https://hub.example.com",
        rotationRequestId: `nrot_${"R".repeat(22)}`,
        newKeyId: `nkey_${"Q".repeat(22)}`,
        newKeySecretName: "node-key.staged",
        continuityMode: "continue" as const,
        stagedAt: 2,
        activatedAt: null,
      },
    }));
    // The destroy queue is a record of its own, so this is what the drain
    // compares it against: a queued name that appears here belongs to a
    // promotion that has not committed and must not be destroyed.
    expect([...identitySecretsInService(enrolled)].toSorted()).toEqual([
      "node-key.active",
      "node-key.staged",
      "node-poll.cleanup",
    ]);
  });

  it("serves a burst of waiters in arrival order, without a poll interval each", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-burst-"));
    const store = await makeLocalHubIdentityStateStore(join(root, "identity.json"));
    const initial = await store.readOrCreate();
    // Advertisement reads these records on the per-channel path, so a burst of
    // new channels is a burst of same-process acquisitions. Waiting on the
    // durable lock by polling would cost each of them up to a poll interval and
    // would serve them in whatever order their timers happened to fire; the
    // in-process queue hands the lock over directly and in arrival order.
    const waiters = 16;
    const observed: number[] = [];
    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: waiters }, (_unused, index) =>
        store.update((current) => {
          observed.push(index);
          return { ...current, revision: current.revision + 1 };
        }),
      ),
    );
    const elapsed = Date.now() - started;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(waiters);
    expect(observed).toEqual(Array.from({ length: waiters }, (_unused, index) => index));
    expect((await store.readOrCreate()).revision).toBe(initial.revision + waiters);
    // Deliberately loose: this asserts that the cost per handoff is a write and
    // not a timer, which is a different order of magnitude and not a benchmark.
    expect(elapsed).toBeLessThan(waiters * 50);
  });

  it("still reports a lock that is held past the wait, rather than waiting forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-held-lock-"));
    const path = join(root, "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    await store.readOrCreate();
    // A live holder this process cannot reclaim: `process.pid` is running by
    // definition, so the abandoned-lock path must not fire.
    await writeFile(
      `${path}.lock`,
      `${process.pid}
`,
      { mode: 0o600 },
    );
    await expect(store.readOrCreate()).rejects.toMatchObject({ code: "identity_state_locked" });
  });

  it.runIf(process.platform !== "win32")(
    "reclaims a well-formed lock left by a terminated process",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-stale-lock-"));
      const path = join(root, "identity.json");
      const store = await makeLocalHubIdentityStateStore(path);
      await writeFile(`${path}.lock`, "2147483647\n", { mode: 0o600 });
      expect((await store.readOrCreate()).environmentId).toMatch(/^env_/);
    },
  );

  it("fails closed when state disappears before an update", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-missing-update-"));
    const path = join(root, "identity.json");
    const store = await makeLocalHubIdentityStateStore(path);
    await store.readOrCreate();
    await rm(path);
    await expect(
      store.update((current) => ({ ...current, revision: current.revision + 1 })),
    ).rejects.toMatchObject({ code: "identity_state_operation_failed" });
  });

  it.runIf(process.platform !== "win32")(
    "fails closed for insecure, corrupt, and symlinked state",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-corrupt-"));
      const path = join(root, "identity.json");
      const store = await makeLocalHubIdentityStateStore(path);
      await store.readOrCreate();

      await chmod(path, 0o644);
      await expect(store.readOrCreate()).rejects.toBeInstanceOf(LocalHubIdentityStateError);

      await chmod(path, 0o600);
      await writeFile(path, "{not-json", { mode: 0o600 });
      await expect(store.readOrCreate()).rejects.toMatchObject({ code: "identity_state_corrupt" });

      await rm(path);
      const outside = join(root, "outside.json");
      await writeFile(outside, "{}", { mode: 0o600 });
      await symlink(outside, path);
      await expect(store.readOrCreate()).rejects.toMatchObject({ code: "identity_state_corrupt" });

      const outsideDirectory = await mkdtemp(join(tmpdir(), "ryco-hub-identity-outside-"));
      const linkedDirectory = join(root, "linked-directory");
      await symlink(outsideDirectory, linkedDirectory);
      await expect(
        makeLocalHubIdentityStateStore(join(linkedDirectory, "identity.json")),
      ).rejects.toMatchObject({ code: "identity_state_unavailable" });
    },
  );
});
