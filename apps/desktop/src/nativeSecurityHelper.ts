import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Path from "node:path";

import {
  derSignatureToRaw,
  type DpopSigningKey,
  uncompressedPointToJwk,
} from "@ryco/client-runtime/relay";

import type { DesktopAuthorizationVariant } from "./nativeAuthorization.ts";

const HELPER_FILE_NAME = "ryco-desktop-security-helper";
const HELPER_TIMEOUT_MS = 5_000;
const HELPER_RESPONSE_BYTES = 32 * 1024;
const P256_PUBLIC_KEY_BYTES = 65;
const X25519_KEY_BYTES = 32;
const MAXIMUM_KEY_RECORD_BYTES = 4 * 1024;

type NativeSecurityRequest =
  | { readonly operation: "signing.create" }
  | { readonly operation: "signing.inspect"; readonly keyRecord: string }
  | { readonly operation: "signing.sign"; readonly keyRecord: string; readonly payload: string }
  | { readonly operation: "agreement.create" }
  | { readonly operation: "agreement.inspect"; readonly keyRecord: string }
  | { readonly operation: "agreement.borrow"; readonly keyRecord: string };

type NativeSecretKind = "signing" | "agreement";

export interface DesktopNativeSecretStore {
  readonly read: (kind: NativeSecretKind) => Promise<string | null>;
  /** Create-only. Returns false when another caller already committed the key. */
  readonly create: (kind: NativeSecretKind, keyRecord: string) => Promise<boolean>;
  readonly delete: (kind: NativeSecretKind) => Promise<void>;
}

export type DesktopNativeSecurityErrorCode =
  | "hardware_unavailable"
  | "key_missing"
  | "operation_failed";

export class DesktopNativeSecurityError extends Error {
  readonly code: DesktopNativeSecurityErrorCode;

  constructor(code: DesktopNativeSecurityErrorCode) {
    super("Desktop native security operation failed.");
    this.name = "DesktopNativeSecurityError";
    this.code = code;
  }
}

export type NativeSecurityHelperRunner = (request: NativeSecurityRequest) => Promise<unknown>;

function failure(code: DesktopNativeSecurityErrorCode): never {
  throw new DesktopNativeSecurityError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeBase64(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) return failure("operation_failed");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== length || decoded.toString("base64") !== value) {
    decoded.fill(0);
    return failure("operation_failed");
  }
  return Uint8Array.from(decoded);
}

function decodeBase64Url(value: unknown, length: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) return failure("operation_failed");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== length || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    return failure("operation_failed");
  }
  return Uint8Array.from(decoded);
}

function validateKeyRecord(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return failure("operation_failed");
  const decoded = Buffer.from(value, "base64");
  const valid =
    decoded.byteLength > 0 &&
    decoded.byteLength <= MAXIMUM_KEY_RECORD_BYTES &&
    decoded.toString("base64") === value;
  decoded.fill(0);
  if (!valid) return failure("operation_failed");
  return value;
}

function successfulResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return failure("operation_failed");
  if (value.ok) return value;
  if (!hasExactKeys(value, ["error", "ok"]) || typeof value.error !== "string") {
    return failure("operation_failed");
  }
  if (value.error === "unavailable") return failure("hardware_unavailable");
  return failure("operation_failed");
}

/** A stable opaque filename namespace without putting account/origin text on disk. */
export function desktopNativeSecurityNamespace(scope: string): string {
  if (scope.length === 0 || scope.length > 1_024) return failure("operation_failed");
  return Crypto.createHash("sha256")
    .update("ryco.desktop.native-security.v1\0", "utf8")
    .update(scope, "utf8")
    .digest("hex");
}

/**
 * Keep development and preview safeStorage records isolated from the installed app.
 * Production retains the legacy scope so existing enrolled identities remain readable.
 */
export function desktopNativeInstallationNamespace(variant: DesktopAuthorizationVariant): string {
  const scope = "ryco.desktop.installation.v1";
  return desktopNativeSecurityNamespace(variant === "production" ? scope : `${scope}\0${variant}`);
}

export function resolveDesktopNativeSecurityHelperPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly moduleDirectory: string;
}): string {
  return input.isPackaged
    ? Path.join(input.resourcesPath, HELPER_FILE_NAME)
    : Path.resolve(input.moduleDirectory, "../resources", HELPER_FILE_NAME);
}

/**
 * How long an idle helper stays up for the next request. A Hub resume or an
 * E2EE handshake signs several times in a burst; one helper serves the burst
 * instead of a process launch (and Secure Enclave key reload) per signature.
 */
const HELPER_IDLE_MS = 2_000;

interface HelperSession {
  readonly child: ChildProcess.ChildProcess;
  buffer: Buffer;
  pending: {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  } | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

/**
 * Runs helper requests one at a time over a helper process that answers one
 * JSON line per request and exits when stdin closes. The process is kept for
 * {@link HELPER_IDLE_MS} after its last answer; any timeout, oversized or
 * malformed answer, or unexpected exit discards it, so a later request always
 * starts from a fresh process. No request, response, or stderr is ever logged.
 */
export function createNativeSecurityHelperRunner(
  helperPath: string,
  options: {
    readonly idleMs?: number;
    readonly timeoutMs?: number;
    readonly spawn?: typeof ChildProcess.spawn;
  } = {},
): NativeSecurityHelperRunner {
  const idleMs = options.idleMs ?? HELPER_IDLE_MS;
  const timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
  const spawn = options.spawn ?? ChildProcess.spawn;
  let session: HelperSession | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const discard = (current: HelperSession, error: Error) => {
    if (current.closed) return;
    current.closed = true;
    if (session === current) session = null;
    if (current.idleTimer) clearTimeout(current.idleTimer);
    current.buffer = Buffer.alloc(0);
    const pending = current.pending;
    current.pending = null;
    current.child.kill("SIGKILL");
    pending?.reject(error);
  };

  const open = (): HelperSession => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const current: HelperSession = {
      child,
      buffer: Buffer.alloc(0),
      pending: null,
      idleTimer: null,
      closed: false,
    };
    child.once("error", () => discard(current, new DesktopNativeSecurityError("hardware_unavailable")));
    child.once("exit", () => discard(current, new DesktopNativeSecurityError("operation_failed")));
    child.stdin?.on("error", () =>
      discard(current, new DesktopNativeSecurityError("operation_failed")),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      if (current.closed) return;
      const pending = current.pending;
      if (pending === null) {
        // Output nobody asked for: the stream can no longer be trusted.
        discard(current, new DesktopNativeSecurityError("operation_failed"));
        return;
      }
      current.buffer = Buffer.concat([current.buffer, chunk]);
      const newline = current.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (current.buffer.byteLength > HELPER_RESPONSE_BYTES) {
          discard(current, new DesktopNativeSecurityError("operation_failed"));
        }
        return;
      }
      const line = current.buffer.subarray(0, newline);
      const rest = current.buffer.subarray(newline + 1);
      current.pending = null;
      if (line.byteLength > HELPER_RESPONSE_BYTES || rest.byteLength > 0) {
        discard(current, new DesktopNativeSecurityError("operation_failed"));
        pending.reject(new DesktopNativeSecurityError("operation_failed"));
        return;
      }
      current.buffer = Buffer.alloc(0);
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8")) as unknown;
      } catch {
        discard(current, new DesktopNativeSecurityError("operation_failed"));
        pending.reject(new DesktopNativeSecurityError("operation_failed"));
        return;
      }
      pending.resolve(value);
    });
    return current;
  };

  /** Only a request in flight keeps the process alive; an idle helper never does. */
  const holdOpen = (current: HelperSession, hold: boolean) => {
    for (const handle of [current.child, current.child.stdin, current.child.stdout]) {
      const refs = handle as { ref?: () => void; unref?: () => void } | null;
      if (hold) refs?.ref?.();
      else refs?.unref?.();
    }
  };

  const request = (input: NativeSecurityRequest): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const current = session && !session.closed ? session : (session = open());
      if (current.idleTimer) clearTimeout(current.idleTimer);
      current.idleTimer = null;
      holdOpen(current, true);
      const timer = setTimeout(
        () => discard(current, new DesktopNativeSecurityError("operation_failed")),
        timeoutMs,
      );
      timer.unref();
      current.pending = {
        resolve: (value) => {
          clearTimeout(timer);
          holdOpen(current, false);
          current.idleTimer = setTimeout(() => {
            current.idleTimer = null;
            if (current.closed || current.pending !== null) return;
            // End of input: the helper answers nothing further and exits.
            current.closed = true;
            if (session === current) session = null;
            current.child.stdin?.end();
          }, idleMs);
          current.idleTimer.unref();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      current.child.stdin?.write(`${JSON.stringify(input)}\n`);
    });

  return (input) => {
    // One request at a time per helper: answers are matched to requests by order.
    const result = queue.then(() => request(input));
    queue = result.catch(() => undefined);
    return result;
  };
}

export class DesktopNativeSecurityHelper {
  readonly #run: NativeSecurityHelperRunner;
  readonly #store: DesktopNativeSecretStore;
  #signingKeyPromise: Promise<DpopSigningKey> | undefined;
  #agreementRecordPromise: Promise<string> | undefined;

  constructor(input: {
    readonly run: NativeSecurityHelperRunner;
    readonly store: DesktopNativeSecretStore;
  }) {
    this.#run = input.run;
    this.#store = input.store;
  }

  async #createOrReadRecord(
    kind: NativeSecretKind,
    operation: "signing.create" | "agreement.create",
  ): Promise<{ readonly keyRecord: string; readonly created: Record<string, unknown> | null }> {
    const existing = await this.#store.read(kind);
    if (existing !== null) return { keyRecord: validateKeyRecord(existing), created: null };
    const response = successfulResponse(await this.#run({ operation }));
    const keyRecord = validateKeyRecord(response.keyRecord);
    if (await this.#store.create(kind, keyRecord)) return { keyRecord, created: response };
    const winner = await this.#store.read(kind);
    if (winner === null) return failure("operation_failed");
    return { keyRecord: validateKeyRecord(winner), created: null };
  }

  async getSigningKey(): Promise<DpopSigningKey> {
    this.#signingKeyPromise ??= this.#loadSigningKey().catch((cause: unknown) => {
      this.#signingKeyPromise = undefined;
      throw cause;
    });
    return await this.#signingKeyPromise;
  }

  async getSigningPublicKey(): Promise<Uint8Array> {
    const jwk = (await this.getSigningKey()).publicJwk;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
      return failure("operation_failed");
    }
    const x = decodeBase64Url(jwk.x, 32);
    const y = decodeBase64Url(jwk.y, 32);
    return Uint8Array.from([0x04, ...x, ...y]);
  }

  async #loadSigningKey(): Promise<DpopSigningKey> {
    const { keyRecord, created } = await this.#createOrReadRecord("signing", "signing.create");
    const response =
      created ?? successfulResponse(await this.#run({ operation: "signing.inspect", keyRecord }));
    if (
      !hasExactKeys(
        response,
        created === null
          ? ["backing", "ok", "publicKey"]
          : ["backing", "keyRecord", "ok", "publicKey"],
      ) ||
      response.backing !== "secure-enclave"
    ) {
      return failure("hardware_unavailable");
    }
    const publicJwk = uncompressedPointToJwk(
      decodeBase64(response.publicKey, P256_PUBLIC_KEY_BYTES),
    );
    return {
      algorithm: "ES256",
      publicJwk,
      sign: async (payload) => {
        if (payload.byteLength === 0 || payload.byteLength > 64 * 1024) {
          return failure("operation_failed");
        }
        const signed = successfulResponse(
          await this.#run({
            operation: "signing.sign",
            keyRecord,
            payload: Buffer.from(payload).toString("base64"),
          }),
        );
        if (!hasExactKeys(signed, ["ok", "signature"]) || typeof signed.signature !== "string") {
          return failure("operation_failed");
        }
        const der = Buffer.from(signed.signature, "base64");
        if (
          der.byteLength < 8 ||
          der.byteLength > 80 ||
          der.toString("base64") !== signed.signature
        ) {
          der.fill(0);
          return failure("operation_failed");
        }
        try {
          return derSignatureToRaw(der);
        } catch {
          return failure("operation_failed");
        } finally {
          der.fill(0);
        }
      },
    };
  }

  async #agreementRecord(): Promise<string> {
    this.#agreementRecordPromise ??= this.#createOrReadRecord("agreement", "agreement.create")
      .then(({ keyRecord }) => keyRecord)
      .catch((cause: unknown) => {
        this.#agreementRecordPromise = undefined;
        throw cause;
      });
    return await this.#agreementRecordPromise;
  }

  async ensureAgreementPublicKey(): Promise<Uint8Array> {
    const keyRecord = await this.#agreementRecord();
    const response = successfulResponse(
      await this.#run({ operation: "agreement.inspect", keyRecord }),
    );
    if (!hasExactKeys(response, ["ok", "publicKey"])) return failure("operation_failed");
    return decodeBase64(response.publicKey, X25519_KEY_BYTES);
  }

  async getAgreementPublicKey(): Promise<Uint8Array> {
    const keyRecord = await this.#store.read("agreement");
    if (keyRecord === null) return failure("key_missing");
    const response = successfulResponse(
      await this.#run({ operation: "agreement.inspect", keyRecord: validateKeyRecord(keyRecord) }),
    );
    if (!hasExactKeys(response, ["ok", "publicKey"])) return failure("operation_failed");
    return decodeBase64(response.publicKey, X25519_KEY_BYTES);
  }

  async withAgreementSecretKey<A>(use: (secretKey: Uint8Array) => Promise<A> | A): Promise<A> {
    const keyRecord = await this.#store.read("agreement");
    if (keyRecord === null) return failure("key_missing");
    const response = successfulResponse(
      await this.#run({ operation: "agreement.borrow", keyRecord: validateKeyRecord(keyRecord) }),
    );
    if (!hasExactKeys(response, ["ok", "secretKey"])) return failure("operation_failed");
    const secretKey = decodeBase64(response.secretKey, X25519_KEY_BYTES);
    try {
      return await use(secretKey);
    } finally {
      secretKey.fill(0);
    }
  }

  async deleteAgreementKey(): Promise<void> {
    await this.#store.delete("agreement");
    this.#agreementRecordPromise = undefined;
  }

  /** Explicit secure-store reset only. Ordinary signout must retain this identity. */
  async deleteSigningKey(): Promise<void> {
    await this.#store.delete("signing");
    this.#signingKeyPromise = undefined;
  }
}
