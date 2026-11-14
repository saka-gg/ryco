import * as FS from "node:fs";

import { ClientSettingsSchema, MAX_KEYBINDINGS_COUNT, type ClientSettings } from "@ryco/contracts";
import { PersistedSavedEnvironmentRecord } from "@ryco/contracts/saved-environment";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeSavedEnvironmentRecords,
  isSavedEnvironmentHubLink,
  persistedSavedEnvironmentRecordFields,
} from "@ryco/shared/savedEnvironmentRecord";

import { writeFileAtomicallySync } from "./atomicFileWrite.ts";

interface ClientSettingsDocument {
  readonly settings: ClientSettings;
}

/** A record in the registry file: the shared fields and the `safeStorage`-encrypted bearer. */
const PersistedSavedEnvironmentStorageRecord = Schema.Struct({
  ...PersistedSavedEnvironmentRecord.fields,
  encryptedBearerToken: Schema.optionalKey(Schema.String),
});
type PersistedSavedEnvironmentStorageRecord = typeof PersistedSavedEnvironmentStorageRecord.Type;

interface SavedEnvironmentRegistryDocument {
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

export interface DesktopSecretStorage {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Owner-only, and a failed write leaves the previous file and no temp file behind. */
function writeJsonFile(filePath: string, value: unknown): void {
  writeFileAtomicallySync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readSavedEnvironmentRegistryDocument(filePath: string): SavedEnvironmentRegistryDocument {
  const parsed = readJsonFile<SavedEnvironmentRegistryDocument>(filePath);
  if (!Predicate.isObject(parsed)) {
    return { records: [] };
  }

  return {
    // A hub link this build cannot verify (no id, no parseable time) leaves its record out.
    records: decodeSavedEnvironmentRecords(
      parsed.records,
      PersistedSavedEnvironmentStorageRecord,
    ).filter((record) => record.hubLink === undefined || isSavedEnvironmentHubLink(record.hubLink)),
  };
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  return persistedSavedEnvironmentRecordFields(record);
}

export function readClientSettings(settingsPath: string): ClientSettings | null {
  const raw = readJsonFile<ClientSettingsDocument>(settingsPath)?.settings;
  if (!raw) {
    return null;
  }
  try {
    return Schema.decodeUnknownSync(ClientSettingsSchema)(raw);
  } catch {
    return null;
  }
}

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);

/**
 * The settings a renderer sent, decoded with the schema `readClientSettings` reads them back
 * with. Throws on anything else, so an invalid payload is refused instead of written and later
 * read back as "no settings".
 */
export function decodeClientSettingsPayload(payload: unknown): ClientSettings {
  try {
    return decodeClientSettings(payload);
  } catch {
    throw new Error("Invalid client settings payload.");
  }
}

export function writeClientSettings(settingsPath: string, settings: ClientSettings): void {
  writeJsonFile(settingsPath, { settings } satisfies ClientSettingsDocument);
}

export function readSavedEnvironmentRegistry(
  registryPath: string,
): readonly PersistedSavedEnvironmentRecord[] {
  return readSavedEnvironmentRegistryDocument(registryPath).records.map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeSavedEnvironmentRegistry(
  registryPath: string,
  records: readonly PersistedSavedEnvironmentRecord[],
): void {
  const currentDocument = readSavedEnvironmentRegistryDocument(registryPath);
  const encryptedBearerTokenById = new Map(
    currentDocument.records.flatMap((record) =>
      record.encryptedBearerToken
        ? [[record.environmentId, record.encryptedBearerToken] as const]
        : [],
    ),
  );
  writeJsonFile(registryPath, {
    records: records.map((record) => {
      const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
      return encryptedBearerToken
        ? Object.assign(persistedSavedEnvironmentRecordFields(record), { encryptedBearerToken })
        : persistedSavedEnvironmentRecordFields(record);
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}

export function readSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  const encoded = document.records.find(
    (record) => record.environmentId === input.environmentId,
  )?.encryptedBearerToken;
  if (!encoded) {
    return null;
  }

  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

export function writeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly secretStorage: DesktopSecretStorage;
}): boolean {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);

  if (!input.secretStorage.isEncryptionAvailable()) {
    return false;
  }

  let found = false;

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      found = true;
      const encryptedBearerToken = input.secretStorage
        .encryptString(input.secret)
        .toString("base64");
      return Object.assign(persistedSavedEnvironmentRecordFields(record), {
        encryptedBearerToken,
      });
    }),
  } satisfies SavedEnvironmentRegistryDocument);
  return found;
}

export function removeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
}): void {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  if (
    !document.records.some(
      (record) =>
        record.environmentId === input.environmentId && record.encryptedBearerToken !== undefined,
    )
  ) {
    return;
  }

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => {
      if (record.environmentId !== input.environmentId) {
        return record;
      }

      return toPersistedSavedEnvironmentRecord(record);
    }),
  } satisfies SavedEnvironmentRegistryDocument);
}

/** Separate from general preferences so stale renderer snapshots cannot overwrite shortcuts. */
export function readAppKeybindings(settingsPath: string): string | null {
  try {
    return FS.readFileSync(settingsPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/**
 * The renderer validates the entries. Main checks only the document's shape and writes it
 * unchanged, so entries a newer version saved are not rejected or stripped.
 */
const AppKeybindingsDocument = Schema.Struct({
  rules: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_KEYBINDINGS_COUNT)),
  disabledCommands: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_KEYBINDINGS_COUNT)),
});

export function writeAppKeybindings(settingsPath: string, document: string): void {
  const parsed: unknown = JSON.parse(document);
  Schema.decodeUnknownSync(AppKeybindingsDocument)(parsed);
  writeJsonFile(settingsPath, parsed);
}
