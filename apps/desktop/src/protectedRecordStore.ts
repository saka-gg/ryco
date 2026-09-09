import * as FS from "node:fs";
import * as Path from "node:path";

const RECORD_PREFIX = "ryco-desktop-protected-record-v1\n";
const MAXIMUM_ENCRYPTED_RECORD_BYTES = 64 * 1024;
const RECORD_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export interface DesktopSecretProtection {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (plaintext: string) => Buffer;
  readonly decryptString: (ciphertext: Buffer) => string;
}

export interface DesktopProtectedRecordStore {
  readonly read: (name: string) => Promise<string | null>;
  /** Create-only. Returns false when a record already exists. */
  readonly create: (name: string, value: string) => Promise<boolean>;
  /** Crash-atomic replacement. */
  readonly write: (name: string, value: string) => Promise<void>;
  readonly delete: (name: string) => Promise<void>;
}

export class DesktopProtectedRecordError extends Error {
  readonly code = "operation_failed" as const;

  constructor() {
    super("Desktop protected record operation failed.");
    this.name = "DesktopProtectedRecordError";
  }
}

function failed(): never {
  throw new DesktopProtectedRecordError();
}

function assertPrivateDirectory(directory: string): void {
  try {
    FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = FS.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) failed();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) failed();
  } catch (cause) {
    if (cause instanceof DesktopProtectedRecordError) throw cause;
    failed();
  }
}

function assertPrivateFile(filePath: string): void {
  try {
    const stat = FS.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size <= RECORD_PREFIX.length ||
      stat.size > MAXIMUM_ENCRYPTED_RECORD_BYTES
    ) {
      failed();
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) failed();
  } catch (cause) {
    if (cause instanceof DesktopProtectedRecordError) throw cause;
    failed();
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = FS.openSync(directory, "r");
    FS.fsyncSync(descriptor);
  } catch {
    failed();
  } finally {
    if (descriptor !== undefined) FS.closeSync(descriptor);
  }
}

function encodeRecord(protection: DesktopSecretProtection, value: string): string {
  if (!protection.isEncryptionAvailable()) failed();
  let encrypted: Buffer;
  try {
    encrypted = protection.encryptString(value);
  } catch {
    return failed();
  }
  try {
    if (encrypted.byteLength === 0 || encrypted.byteLength > MAXIMUM_ENCRYPTED_RECORD_BYTES) {
      return failed();
    }
    return `${RECORD_PREFIX}${encrypted.toString("base64")}`;
  } finally {
    encrypted.fill(0);
  }
}

function decodeRecord(protection: DesktopSecretProtection, stored: string): string {
  if (!protection.isEncryptionAvailable() || !stored.startsWith(RECORD_PREFIX)) failed();
  const encoded = stored.slice(RECORD_PREFIX.length);
  const encrypted = Buffer.from(encoded, "base64");
  if (
    encrypted.byteLength === 0 ||
    encrypted.toString("base64") !== encoded ||
    encrypted.byteLength > MAXIMUM_ENCRYPTED_RECORD_BYTES
  ) {
    encrypted.fill(0);
    return failed();
  }
  try {
    return protection.decryptString(encrypted);
  } catch {
    return failed();
  } finally {
    encrypted.fill(0);
  }
}

function validateName(name: string): string {
  return RECORD_NAME.test(name) ? name : failed();
}

/** A startup hint only; never grants authority or decrypts a record. */
export function desktopProtectedRecordExists(input: {
  readonly directory: string;
  readonly name: string;
}): boolean {
  const pattern = new RegExp(`^[0-9a-f]{64}\\.${validateName(input.name)}\\.record$`);
  try {
    return FS.readdirSync(input.directory).some((name) => pattern.test(name));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    return failed();
  }
}

export function createDesktopProtectedRecordStore(input: {
  readonly directory: string;
  readonly namespace: string;
  readonly protection: DesktopSecretProtection;
}): DesktopProtectedRecordStore {
  if (!/^[0-9a-f]{64}$/.test(input.namespace)) failed();

  const filePath = (name: string) =>
    Path.join(input.directory, `${input.namespace}.${validateName(name)}.record`);

  const read = async (name: string): Promise<string | null> => {
    if (!input.protection.isEncryptionAvailable()) failed();
    assertPrivateDirectory(input.directory);
    const path = filePath(name);
    if (!FS.existsSync(path)) return null;
    assertPrivateFile(path);
    try {
      return decodeRecord(input.protection, FS.readFileSync(path, "utf8"));
    } catch (cause) {
      if (cause instanceof DesktopProtectedRecordError) throw cause;
      return failed();
    }
  };

  const create = async (name: string, value: string): Promise<boolean> => {
    assertPrivateDirectory(input.directory);
    const body = encodeRecord(input.protection, value);
    let descriptor: number | undefined;
    try {
      descriptor = FS.openSync(filePath(name), "wx", 0o600);
      FS.writeFileSync(descriptor, body, { encoding: "utf8" });
      FS.fsyncSync(descriptor);
      FS.closeSync(descriptor);
      descriptor = undefined;
      assertPrivateFile(filePath(name));
      fsyncDirectory(input.directory);
      return true;
    } catch (cause) {
      if (descriptor !== undefined) FS.closeSync(descriptor);
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      if (cause instanceof DesktopProtectedRecordError) throw cause;
      return failed();
    }
  };

  const write = async (name: string, value: string): Promise<void> => {
    assertPrivateDirectory(input.directory);
    const body = encodeRecord(input.protection, value);
    const target = filePath(name);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = FS.openSync(temporary, "wx", 0o600);
      FS.writeFileSync(descriptor, body, { encoding: "utf8" });
      FS.fsyncSync(descriptor);
      FS.closeSync(descriptor);
      descriptor = undefined;
      assertPrivateFile(temporary);
      FS.renameSync(temporary, target);
      assertPrivateFile(target);
      fsyncDirectory(input.directory);
    } catch (cause) {
      if (descriptor !== undefined) FS.closeSync(descriptor);
      try {
        FS.unlinkSync(temporary);
      } catch {
        // The temporary may never have been created or may already have moved.
      }
      if (cause instanceof DesktopProtectedRecordError) throw cause;
      failed();
    }
  };

  const remove = async (name: string): Promise<void> => {
    assertPrivateDirectory(input.directory);
    const path = filePath(name);
    if (!FS.existsSync(path)) return;
    assertPrivateFile(path);
    try {
      FS.unlinkSync(path);
      fsyncDirectory(input.directory);
    } catch {
      failed();
    }
  };

  return { read, create, write, delete: remove };
}
