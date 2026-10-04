import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ProtectedSecretStoreBackend = "bun-secrets" | "keytar" | "permissioned-file";

export type ProtectedSecretStoreErrorCode =
  | "protected_store_unavailable"
  | "protected_store_invalid_name"
  | "protected_store_conflict"
  | "protected_store_access_denied"
  | "protected_store_corrupt"
  | "protected_store_operation_failed";

export class ProtectedSecretStoreError extends Error {
  readonly code: ProtectedSecretStoreErrorCode;

  constructor(code: ProtectedSecretStoreErrorCode) {
    super("Protected secret storage operation failed.");
    this.name = "ProtectedSecretStoreError";
    this.code = code;
  }
}

export interface ProtectedSecretStore {
  readonly backend: ProtectedSecretStoreBackend;
  readonly get: (name: string) => Promise<Uint8Array | null>;
  readonly create: (name: string, value: Uint8Array) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
}

interface BunSecretsApi {
  readonly get: (options: {
    readonly service: string;
    readonly name: string;
  }) => Promise<string | null>;
  readonly set: (options: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }) => Promise<void>;
  readonly delete: (options: {
    readonly service: string;
    readonly name: string;
  }) => Promise<boolean>;
}

interface KeytarApi {
  readonly getPassword: (service: string, account: string) => Promise<string | null>;
  readonly setPassword: (service: string, account: string, password: string) => Promise<void>;
  readonly deletePassword: (service: string, account: string) => Promise<boolean>;
}

const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const osCreateLocks = new Map<string, Promise<void>>();

function fail(code: ProtectedSecretStoreErrorCode): never {
  throw new ProtectedSecretStoreError(code);
}

function validateServiceName(value: string): string {
  if (!SERVICE_NAME.test(value)) fail("protected_store_invalid_name");
  return value;
}

function validateSecretName(value: string): string {
  if (!SECRET_NAME.test(value)) fail("protected_store_invalid_name");
  return value;
}

function encodeSecret(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 4096) {
    fail("protected_store_operation_failed");
  }
  return Buffer.from(value).toString("base64url");
}

function decodeSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{2,5462}$/.test(value)) fail("protected_store_corrupt");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.byteLength > 4096) fail("protected_store_corrupt");
  return Uint8Array.from(decoded);
}

function safeOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof ProtectedSecretStoreError) throw error;
    return fail("protected_store_operation_failed");
  });
}

async function serializeOsCreate<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = osCreateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  osCreateLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (osCreateLocks.get(key) === current) osCreateLocks.delete(key);
  }
}

export function makeBunProtectedSecretStore(
  service: string,
  secrets: BunSecretsApi,
): ProtectedSecretStore {
  const serviceName = validateServiceName(service);
  return {
    backend: "bun-secrets",
    get: (rawName) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        const value = await secrets.get({ service: serviceName, name });
        return value === null ? null : decodeSecret(value);
      }),
    create: (rawName, value) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        await serializeOsCreate(`bun:${serviceName}:${name}`, async () => {
          if ((await secrets.get({ service: serviceName, name })) !== null) {
            fail("protected_store_conflict");
          }
          await secrets.set({ service: serviceName, name, value: encodeSecret(value) });
        });
      }),
    remove: (rawName) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        await secrets.delete({ service: serviceName, name });
      }),
  };
}

export function makeKeytarProtectedSecretStore(
  service: string,
  keytar: KeytarApi,
): ProtectedSecretStore {
  const serviceName = validateServiceName(service);
  return {
    backend: "keytar",
    get: (rawName) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        const value = await keytar.getPassword(serviceName, name);
        return value === null ? null : decodeSecret(value);
      }),
    create: (rawName, value) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        await serializeOsCreate(`keytar:${serviceName}:${name}`, async () => {
          if ((await keytar.getPassword(serviceName, name)) !== null) {
            fail("protected_store_conflict");
          }
          await keytar.setPassword(serviceName, name, encodeSecret(value));
        });
      }),
    remove: (rawName) =>
      safeOperation(async () => {
        const name = validateSecretName(rawName);
        await keytar.deletePassword(serviceName, name);
      }),
  };
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("protected_store_access_denied");
  if (process.platform === "win32") fail("protected_store_unavailable");
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid) {
    fail("protected_store_access_denied");
  }
}

async function assertSecureDirectory(path: string): Promise<void> {
  await assertOwnedDirectory(path);
  const stat = await lstat(path);
  if ((stat.mode & 0o777) !== 0o700) fail("protected_store_access_denied");
}

async function assertSecureFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("protected_store_access_denied");
  }
  const uid = process.getuid?.();
  if (uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    fail("protected_store_access_denied");
  }
}

async function recoverInstalledSecret(path: string): Promise<void> {
  const target = await lstat(path);
  if (target.nlink !== 2 || !target.isFile() || target.isSymbolicLink()) return;
  const prefix = `${basename(path)}.`;
  for (const entry of await readdir(dirname(path))) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    const siblingPath = join(dirname(path), entry);
    const sibling = await lstat(siblingPath);
    if (
      sibling.dev === target.dev &&
      sibling.ino === target.ino &&
      sibling.isFile() &&
      !sibling.isSymbolicLink() &&
      sibling.nlink === 2 &&
      (sibling.mode & 0o777) === 0o600 &&
      sibling.uid === target.uid
    ) {
      await rm(siblingPath);
      await syncDirectory(dirname(path));
      return;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function makePermissionedFileSecretStore(
  rootDirectory: string,
  options: { readonly explicitlyAllowed: boolean },
): Promise<ProtectedSecretStore> {
  if (!options.explicitlyAllowed || process.platform === "win32") {
    fail("protected_store_unavailable");
  }
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(rootDirectory);
  await chmod(rootDirectory, 0o700);
  await assertSecureDirectory(rootDirectory);

  const secretPath = (rawName: string): string =>
    join(rootDirectory, `${validateSecretName(rawName)}.bin`);

  return {
    backend: "permissioned-file",
    get: (rawName) =>
      safeOperation(async () => {
        const path = secretPath(rawName);
        let file;
        try {
          await recoverInstalledSecret(path);
          await assertSecureFile(path);
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        try {
          const stat = await file.stat();
          if (stat.size < 1 || stat.size > 4096) fail("protected_store_corrupt");
          const value = await file.readFile();
          return Uint8Array.from(value);
        } finally {
          await file.close();
        }
      }),
    create: (rawName, value) =>
      safeOperation(async () => {
        const path = secretPath(rawName);
        if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > 4096) {
          fail("protected_store_operation_failed");
        }
        await assertSecureDirectory(dirname(path));
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        let file;
        try {
          file = await open(
            temporaryPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          await file.writeFile(value);
          await file.sync();
          await file.close();
          file = undefined;
          await assertSecureFile(temporaryPath);
          await link(temporaryPath, path);
          await rm(temporaryPath);
          await assertSecureFile(path);
          await syncDirectory(dirname(path));
        } catch (error: unknown) {
          await file?.close().catch(() => undefined);
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            fail("protected_store_conflict");
          }
          throw error;
        }
      }),
    remove: (rawName) =>
      safeOperation(async () => {
        const path = secretPath(rawName);
        try {
          await recoverInstalledSecret(path);
          await assertSecureFile(path);
          await rm(path);
          await syncDirectory(dirname(path));
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
  };
}

export async function makeOsProtectedSecretStore(service: string): Promise<ProtectedSecretStore> {
  const bunSecrets = (globalThis as { readonly Bun?: { readonly secrets?: BunSecretsApi } }).Bun
    ?.secrets;
  if (bunSecrets !== undefined) return makeBunProtectedSecretStore(service, bunSecrets);
  try {
    const imported = (await import("@github/keytar")) as typeof import("@github/keytar") & {
      readonly default?: KeytarApi;
    };
    const keytar: KeytarApi = imported.default ?? imported;
    return makeKeytarProtectedSecretStore(service, keytar);
  } catch {
    return fail("protected_store_unavailable");
  }
}

/** The OS credential-store service that holds a node's Hub identity keys. */
export const NODE_IDENTITY_SECRET_SERVICE = "ryco.node.identity";

/** A name nothing ever writes: probing reads it and expects absence. */
const PROBE_SECRET_NAME = "ryco-store-probe";
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the platform credential store answers a real read.
 *
 * Constructing an OS store touches nothing: keytar loads its native module and
 * returns. On a host where that succeeds but no Secret Service runs (headless
 * Linux), every later read and write fails, so construction alone cannot say
 * the store is usable. One read of a name that is never written can, and it
 * creates and changes nothing.
 *
 * Deliberately not part of `makeOsProtectedSecretStore`: on macOS a read can
 * raise a Keychain prompt, and the runtime must not open the store before the
 * operator acts. Only an explicit operator step such as `ryco setup` probes.
 * A failed probe never selects the file fallback by itself; it only lets the
 * caller ask.
 */
export async function probeOsProtectedSecretStore(options: {
  readonly service: string;
  readonly makeOsStore?: (service: string) => Promise<ProtectedSecretStore>;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const store = await (options.makeOsStore ?? makeOsProtectedSecretStore)(options.service);
    await Promise.race([
      store.get(PROBE_SECRET_NAME),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProtectedSecretStoreError("protected_store_unavailable")),
          options.timeoutMs ?? PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function makeProtectedSecretStore(options: {
  readonly service: string;
  readonly fileRoot: string;
  readonly allowFileFallback: boolean;
  readonly makeOsStore?: (service: string) => Promise<ProtectedSecretStore>;
}): Promise<ProtectedSecretStore> {
  try {
    return await (options.makeOsStore ?? makeOsProtectedSecretStore)(options.service);
  } catch (error: unknown) {
    if (
      !options.allowFileFallback ||
      !(error instanceof ProtectedSecretStoreError) ||
      error.code !== "protected_store_unavailable"
    ) {
      throw error;
    }
  }
  return makePermissionedFileSecretStore(options.fileRoot, { explicitlyAllowed: true });
}
