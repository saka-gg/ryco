import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type ClientSettings,
  type EnvironmentId as EnvironmentIdValue,
  type PersistedSavedEnvironmentRecord,
} from "@ryco/contracts";
import * as Schema from "effect/Schema";
import {
  BROWSER_SAVED_ENVIRONMENT_BEARER_TOKEN_MAX_AGE_MS,
  computeBearerTokenExpiresAt,
  isBearerTokenUsable,
} from "@ryco/client-runtime/state/settings";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { isHostedHubMode } from "./env";
import { readHostedInboxPreferences, writeHostedInboxPreferences } from "./hostedInboxPreferences";

export const CLIENT_SETTINGS_STORAGE_KEY = "ryco:client-settings:v1";
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "ryco:saved-environment-registry:v1";
export { BROWSER_SAVED_ENVIRONMENT_BEARER_TOKEN_MAX_AGE_MS };

const BrowserSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(
    Schema.Struct({
      alias: Schema.String,
      hostname: Schema.String,
      username: Schema.NullOr(Schema.String),
      port: Schema.NullOr(Schema.Number),
    }),
  ),
  bearerToken: Schema.optionalKey(Schema.String),
  bearerTokenSavedAt: Schema.optionalKey(Schema.String),
  bearerTokenExpiresAt: Schema.optionalKey(Schema.String),
});
type BrowserSavedEnvironmentRecord = typeof BrowserSavedEnvironmentRecordSchema.Type;

const BrowserSavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(BrowserSavedEnvironmentRecordSchema)),
});
type BrowserSavedEnvironmentRegistryDocument =
  typeof BrowserSavedEnvironmentRegistryDocumentSchema.Type;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return record.desktopSsh ? { ...nextRecord, desktopSsh: record.desktopSsh } : nextRecord;
}

function isRecordBearerTokenUsable(record: BrowserSavedEnvironmentRecord, nowMs: number): boolean {
  return isBearerTokenUsable({
    token: record.bearerToken,
    expiresAt: record.bearerTokenExpiresAt,
    nowMs,
  });
}

function withBrowserBearerTokenLifetime(
  record: BrowserSavedEnvironmentRecord,
  nowMs: number,
): BrowserSavedEnvironmentRecord {
  if (!record.bearerToken) {
    return record;
  }

  return {
    ...record,
    bearerTokenSavedAt: record.bearerTokenSavedAt ?? new Date(nowMs).toISOString(),
    bearerTokenExpiresAt: record.bearerTokenExpiresAt ?? computeBearerTokenExpiresAt(nowMs),
  };
}

function pruneBrowserBearerToken(
  record: BrowserSavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  return toPersistedSavedEnvironmentRecord(record);
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const settings = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
    return isHostedHubMode()
      ? { ...DEFAULT_CLIENT_SETTINGS, ...readHostedInboxPreferences(), ...settings }
      : settings;
  } catch {
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
  if (isHostedHubMode()) writeHostedInboxPreferences(settings);
}

function readBrowserSavedEnvironmentRegistryDocument(): BrowserSavedEnvironmentRegistryDocument {
  if (!hasWindow()) {
    return {};
  }

  try {
    const parsed = getLocalStorageItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      BrowserSavedEnvironmentRegistryDocumentSchema,
    );
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeBrowserSavedEnvironmentRegistryDocument(
  document: BrowserSavedEnvironmentRegistryDocument,
): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(
    SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
    document,
    BrowserSavedEnvironmentRegistryDocumentSchema,
  );
}

function readBrowserSavedEnvironmentRecordsWithSecrets(): ReadonlyArray<BrowserSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRegistryDocument().records ?? [];
}

function writeBrowserSavedEnvironmentRecords(
  records: ReadonlyArray<BrowserSavedEnvironmentRecord>,
): void {
  writeBrowserSavedEnvironmentRegistryDocument({
    version: 1,
    records,
  });
}

export function readBrowserSavedEnvironmentRegistry(): ReadonlyArray<PersistedSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRecordsWithSecrets().map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeBrowserSavedEnvironmentRegistry(
  records: ReadonlyArray<PersistedSavedEnvironmentRecord>,
): void {
  const nowMs = Date.now();
  const existing = new Map(
    readBrowserSavedEnvironmentRecordsWithSecrets().map(
      (record) => [record.environmentId, record] as const,
    ),
  );
  writeBrowserSavedEnvironmentRecords(
    records.map((record) => {
      const existingRecord = existing.get(record.environmentId);
      if (!existingRecord || !isRecordBearerTokenUsable(existingRecord, nowMs)) {
        return toPersistedSavedEnvironmentRecord(record);
      }

      const tokenFields = withBrowserBearerTokenLifetime(existingRecord, nowMs);
      const bearerToken = tokenFields.bearerToken;
      if (!bearerToken) {
        return toPersistedSavedEnvironmentRecord(record);
      }
      const bearerTokenSavedAt = tokenFields.bearerTokenSavedAt ?? new Date(nowMs).toISOString();
      const bearerTokenExpiresAt =
        tokenFields.bearerTokenExpiresAt ?? computeBearerTokenExpiresAt(nowMs);
      return {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
        ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
        bearerToken,
        bearerTokenSavedAt,
        bearerTokenExpiresAt,
      };
    }),
  );
}

export function readBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
): string | null {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const records = document.records ?? [];
  const matchingRecord = records.find((record) => record.environmentId === environmentId);
  if (!matchingRecord?.bearerToken) {
    return null;
  }

  const nowMs = Date.now();
  if (!isRecordBearerTokenUsable(matchingRecord, nowMs)) {
    removeBrowserSavedEnvironmentSecret(environmentId);
    return null;
  }

  const nextRecord = withBrowserBearerTokenLifetime(matchingRecord, nowMs);
  if (
    nextRecord.bearerTokenSavedAt !== matchingRecord.bearerTokenSavedAt ||
    nextRecord.bearerTokenExpiresAt !== matchingRecord.bearerTokenExpiresAt
  ) {
    writeBrowserSavedEnvironmentRegistryDocument({
      version: document.version ?? 1,
      records: records.map((record) =>
        record.environmentId === environmentId ? nextRecord : record,
      ),
    });
  }

  return matchingRecord.bearerToken;
}

export function writeBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
  secret: string,
): boolean {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) {
    removeBrowserSavedEnvironmentSecret(environmentId);
    return false;
  }

  const document = readBrowserSavedEnvironmentRegistryDocument();
  const records = document.records ?? [];
  let found = false;
  const nowMs = Date.now();
  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    records: records.map((record) => {
      if (record.environmentId !== environmentId) {
        return record;
      }
      found = true;
      const nextRecord = {
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
        createdAt: record.createdAt,
        lastConnectedAt: record.lastConnectedAt,
        bearerToken: trimmedSecret,
        bearerTokenSavedAt: new Date(nowMs).toISOString(),
        bearerTokenExpiresAt: computeBearerTokenExpiresAt(nowMs),
      };
      return record.desktopSsh
        ? Object.assign(nextRecord, { desktopSsh: record.desktopSsh })
        : nextRecord;
    }),
  });
  return found;
}

export function removeBrowserSavedEnvironmentSecret(environmentId: EnvironmentIdValue): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    records: (document.records ?? []).map((record) => {
      if (record.environmentId !== environmentId) {
        return record;
      }
      return pruneBrowserBearerToken(record);
    }),
  });
}
