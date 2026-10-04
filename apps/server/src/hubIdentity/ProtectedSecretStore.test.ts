import { chmod, link, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  makeBunProtectedSecretStore,
  makeKeytarProtectedSecretStore,
  makeOsProtectedSecretStore,
  makePermissionedFileSecretStore,
  makeProtectedSecretStore,
  probeOsProtectedSecretStore,
  ProtectedSecretStoreError,
} from "./ProtectedSecretStore.ts";

class MemoryCredentials {
  readonly values = new Map<string, string>();

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.values.get(`${service}:${account}`) ?? null;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.values.set(`${service}:${account}`, password);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.values.delete(`${service}:${account}`);
  }
}

describe("protected node secret stores", () => {
  it("probes the OS store with one read that writes nothing", async () => {
    const credentials = new MemoryCredentials();
    const reads: string[] = [];
    const available = await probeOsProtectedSecretStore({
      service: "dev.ryco.node",
      makeOsStore: async (service) => {
        const store = makeKeytarProtectedSecretStore(service, credentials);
        return {
          ...store,
          get: async (name) => {
            reads.push(name);
            return store.get(name);
          },
        };
      },
    });
    expect(available).toBe(true);
    expect(reads).toHaveLength(1);
    expect(credentials.values.size).toBe(0);
  });

  it("reports an OS store that loads but cannot answer as unavailable", async () => {
    // Headless Linux: keytar imports, construction succeeds, and every read
    // fails because no Secret Service is running.
    const noSecretService = makeKeytarProtectedSecretStore("dev.ryco.node", {
      getPassword: async () => {
        throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
      },
      setPassword: async () => undefined,
      deletePassword: async () => false,
    });
    expect(
      await probeOsProtectedSecretStore({
        service: "dev.ryco.node",
        makeOsStore: async () => noSecretService,
      }),
    ).toBe(false);
    expect(
      await probeOsProtectedSecretStore({
        service: "dev.ryco.node",
        makeOsStore: async () => {
          throw new ProtectedSecretStoreError("protected_store_unavailable");
        },
      }),
    ).toBe(false);
    expect(
      await probeOsProtectedSecretStore({
        service: "dev.ryco.node",
        timeoutMs: 10,
        makeOsStore: async () => ({
          ...noSecretService,
          get: () => new Promise<never>(() => undefined),
        }),
      }),
    ).toBe(false);
  });

  it("loads packaged keytar when available and otherwise fails closed", async () => {
    if ((globalThis as { readonly Bun?: unknown }).Bun !== undefined) return;
    try {
      expect((await makeOsProtectedSecretStore("dev.ryco.node.test")).backend).toBe("keytar");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtectedSecretStoreError);
      expect(error).toMatchObject({ code: "protected_store_unavailable" });
    }
  });

  it("round-trips keytar values without exposing raw bytes to the backend", async () => {
    const credentials = new MemoryCredentials();
    const store = makeKeytarProtectedSecretStore("dev.ryco.node", credentials);
    const value = Uint8Array.from([0, 1, 2, 253, 254, 255]);
    await store.create("node-key.fixture", value);
    expect(credentials.values.get("dev.ryco.node:node-key.fixture")).toBe("AAEC_f7_");
    expect(await store.get("node-key.fixture")).toEqual(value);
    await store.remove("node-key.fixture");
    expect(await store.get("node-key.fixture")).toBeNull();
  });

  it("uses the Bun secrets shape and refuses overwrite", async () => {
    const credentials = new MemoryCredentials();
    const store = makeBunProtectedSecretStore("dev.ryco.node", {
      get: ({ service, name }) => credentials.getPassword(service, name),
      set: ({ service, name, value }) => credentials.setPassword(service, name, value),
      delete: ({ service, name }) => credentials.deletePassword(service, name),
    });
    await store.create("poll.fixture", Uint8Array.from([4, 5, 6]));
    await expect(store.create("poll.fixture", Uint8Array.from([7]))).rejects.toMatchObject({
      code: "protected_store_conflict",
    });
  });

  it("serializes concurrent OS-backed creators so one loses without overwrite", async () => {
    const credentials = new MemoryCredentials();
    const store = makeKeytarProtectedSecretStore("dev.ryco.node.concurrent", credentials);
    const results = await Promise.allSettled([
      store.create("node-key.fixture", Uint8Array.from([1])),
      store.create("node-key.fixture", Uint8Array.from([2])),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await store.get("node-key.fixture")).toEqual(Uint8Array.from([1]));
  });

  it("requires explicit permission for the file fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-protected-store-denied-"));
    await expect(
      makePermissionedFileSecretStore(root, { explicitlyAllowed: false }),
    ).rejects.toMatchObject({ code: "protected_store_unavailable" });
  });

  it.runIf(process.platform !== "win32")(
    "uses the permissioned fallback only after an explicit OS-store unavailability",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ryco-protected-store-selected-"));
      const unavailable = () =>
        Promise.reject(new ProtectedSecretStoreError("protected_store_unavailable"));
      await expect(
        makeProtectedSecretStore({
          service: "dev.ryco.node",
          fileRoot: root,
          allowFileFallback: false,
          makeOsStore: unavailable,
        }),
      ).rejects.toMatchObject({ code: "protected_store_unavailable" });
      const selected = await makeProtectedSecretStore({
        service: "dev.ryco.node",
        fileRoot: root,
        allowFileFallback: true,
        makeOsStore: unavailable,
      });
      expect(selected.backend).toBe("permissioned-file");
    },
  );

  it.runIf(process.platform !== "win32")(
    "creates permissioned files, survives restart, and deletes cleanly",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ryco-protected-store-"));
      const store = await makePermissionedFileSecretStore(root, { explicitlyAllowed: true });
      const value = new Uint8Array(96).fill(0x45);
      await store.create("node-key.fixture", value);

      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      const path = join(root, "node-key.fixture.bin");
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path)).toEqual(Buffer.from(value));

      const restarted = await makePermissionedFileSecretStore(root, {
        explicitlyAllowed: true,
      });
      expect(await restarted.get("node-key.fixture")).toEqual(value);

      await restarted.create("crash-recovery", Uint8Array.from([7, 8, 9]));
      const installedPath = join(root, "crash-recovery.bin");
      const siblingPath = join(root, "crash-recovery.bin.interrupted.tmp");
      await link(installedPath, siblingPath);
      expect((await lstat(installedPath)).nlink).toBe(2);
      expect(await restarted.get("crash-recovery")).toEqual(Uint8Array.from([7, 8, 9]));
      expect((await lstat(installedPath)).nlink).toBe(1);

      await restarted.remove("node-key.fixture");
      expect(await restarted.get("node-key.fixture")).toBeNull();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinks, hard links, corrupt sizes, and concurrent overwrite",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ryco-protected-store-invalid-"));
      const outside = join(await mkdtemp(join(tmpdir(), "ryco-protected-store-outside-")), "x");
      await writeFile(outside, "outside", { mode: 0o600 });
      const store = await makePermissionedFileSecretStore(root, { explicitlyAllowed: true });

      await symlink(outside, join(root, "symlink.bin"));
      await expect(store.get("symlink")).rejects.toMatchObject({
        code: "protected_store_access_denied",
      });

      await store.create("linked", Uint8Array.from([1, 2, 3]));
      await link(join(root, "linked.bin"), join(root, "linked-copy.bin"));
      await expect(store.get("linked")).rejects.toMatchObject({
        code: "protected_store_access_denied",
      });

      await writeFile(join(root, "empty.bin"), new Uint8Array(), { mode: 0o600 });
      await expect(store.get("empty")).rejects.toMatchObject({
        code: "protected_store_corrupt",
      });

      await store.create("existing", Uint8Array.from([9]));
      await expect(store.create("existing", Uint8Array.from([8]))).rejects.toMatchObject({
        code: "protected_store_conflict",
      });
      expect(await store.get("existing")).toEqual(Uint8Array.from([9]));

      const outsideRoot = await mkdtemp(join(tmpdir(), "ryco-protected-store-linked-root-"));
      await chmod(outsideRoot, 0o755);
      const linkedRoot = join(root, "linked-root");
      await symlink(outsideRoot, linkedRoot);
      await expect(
        makePermissionedFileSecretStore(linkedRoot, { explicitlyAllowed: true }),
      ).rejects.toMatchObject({ code: "protected_store_access_denied" });
      expect((await lstat(outsideRoot)).mode & 0o777).toBe(0o755);
    },
  );

  it("uses bounded errors that do not reflect names or secret values", async () => {
    const secretCanary = Buffer.from("private-key-canary");
    const store = makeKeytarProtectedSecretStore("dev.ryco.node", {
      getPassword: async () => {
        throw new Error(`backend leaked ${secretCanary.toString()}`);
      },
      setPassword: async () => undefined,
      deletePassword: async () => true,
    });
    let error: unknown;
    try {
      await store.get("node-key.fixture");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ProtectedSecretStoreError);
    expect(String(error)).not.toContain(secretCanary.toString());
    expect(JSON.stringify(error)).not.toContain(secretCanary.toString());
  });
});
