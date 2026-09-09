import * as Crypto from "node:crypto";

import type { SessionCredentialsService } from "@ryco/client-runtime/platform";
import { Schema } from "effect";
import { DesktopInstallationId } from "@ryco/contracts/hosted-identity";

import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const INSTALLATION_RECORD = "installation-id";
const SESSION_RECORD = "hub-session-token";
const SESSION_TOKEN_MAX_CHARS = 8 * 1024;

function decodeInstallationId(value: unknown): typeof DesktopInstallationId.Type {
  return Schema.decodeUnknownSync(DesktopInstallationId)(value, {
    onExcessProperty: "error",
  });
}

export async function getOrCreateDesktopInstallationId(
  store: DesktopProtectedRecordStore,
): Promise<typeof DesktopInstallationId.Type> {
  const existing = await store.read(INSTALLATION_RECORD);
  if (existing !== null) return decodeInstallationId(existing);
  const generated = decodeInstallationId(`install_${Crypto.randomBytes(16).toString("base64url")}`);
  if (await store.create(INSTALLATION_RECORD, generated)) return generated;
  const winner = await store.read(INSTALLATION_RECORD);
  if (winner === null) throw new Error("Desktop installation identity is unavailable.");
  return decodeInstallationId(winner);
}

export interface DesktopHostedSessionCredentials extends SessionCredentialsService {
  readonly hydrate: () => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly clear: () => Promise<void>;
}

function validToken(token: string | null): token is string {
  return token !== null && token.length > 0 && token.length <= SESSION_TOKEN_MAX_CHARS;
}

/** Main-process-only native Hub session holder with ordered durable mirroring. */
export function createDesktopHostedSessionCredentials(
  store: DesktopProtectedRecordStore,
): DesktopHostedSessionCredentials {
  let bearerToken: string | null = null;
  let hydrated: Promise<void> | undefined;
  let persistence: Promise<void> = Promise.resolve();
  let revision = 0;
  let persistenceFailed = false;

  const enqueue = (token: string | null): Promise<void> => {
    const operation = persistence
      .catch(() => undefined)
      .then(async () => {
        try {
          if (token === null) await store.delete(SESSION_RECORD);
          else await store.write(SESSION_RECORD, token);
          persistenceFailed = false;
        } catch {
          persistenceFailed = true;
          throw new Error("Desktop Hub credential storage is unavailable.");
        }
      });
    persistence = operation;
    // The synchronous credential port cannot await disk I/O. Keep its rejection
    // handled while preserving it for flush(), which gates successful sign-in.
    void operation.catch(() => undefined);
    return operation;
  };

  return {
    mode: "bearer",
    readCsrfToken: () => null,
    writeCsrfToken: () => undefined,
    readBearerToken: () => bearerToken,
    writeBearerToken: (token) => {
      revision += 1;
      bearerToken = validToken(token) ? token : null;
      void enqueue(bearerToken);
    },
    hydrate: () =>
      (hydrated ??= (async () => {
        const startedAtRevision = revision;
        const stored = await store.read(SESSION_RECORD);
        if (revision === startedAtRevision && validToken(stored)) bearerToken = stored;
      })().catch(() => {
        hydrated = undefined;
        throw new Error("Desktop Hub credential storage is unavailable.");
      })),
    flush: async () => {
      // A later explicit retry can persist the retained session after unlock.
      // The first failed flush still rejects, so sign-in never claims durability.
      if (persistenceFailed) enqueue(bearerToken);
      await persistence;
    },
    clear: async () => {
      revision += 1;
      bearerToken = null;
      await enqueue(null);
    },
  };
}
