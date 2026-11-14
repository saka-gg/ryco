import type { PersistedSavedEnvironmentRecord } from "@ryco/contracts";

import { handleAppInvoke } from "./appInvoke.ts";
import {
  decodeClientSettingsPayload,
  type DesktopSecretStorage,
  readClientSettings,
  readSavedEnvironmentRegistry,
  readSavedEnvironmentSecret,
  removeSavedEnvironmentSecret,
  writeClientSettings,
  writeSavedEnvironmentRegistry,
  writeSavedEnvironmentSecret,
} from "./clientPersistence.ts";
import {
  GET_CLIENT_SETTINGS_CHANNEL,
  SET_CLIENT_SETTINGS_CHANNEL,
  GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
  GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
  REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
} from "./desktopIpcChannels.ts";

/** What the client settings and saved environment channels need from main. */
export interface ClientPersistenceIpcDeps {
  readonly clientSettingsPath: string;
  readonly savedEnvironmentRegistryPath: string;
  readonly getDesktopSecretStorage: () => DesktopSecretStorage;
}

/** Client settings, the saved environment registry and its secrets. */
export function registerClientPersistenceIpc(deps: ClientPersistenceIpcDeps): void {
  handleAppInvoke(
    GET_CLIENT_SETTINGS_CHANNEL,
    async () => readClientSettings(deps.clientSettingsPath),
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_CLIENT_SETTINGS_CHANNEL,
    async (_event, rawSettings: unknown) => {
      writeClientSettings(deps.clientSettingsPath, decodeClientSettingsPayload(rawSettings));
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
    async () => readSavedEnvironmentRegistry(deps.savedEnvironmentRegistryPath),
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL,
    async (_event, rawRecords: unknown) => {
      if (!Array.isArray(rawRecords)) {
        throw new Error("Invalid saved environment registry payload.");
      }

      writeSavedEnvironmentRegistry(
        deps.savedEnvironmentRegistryPath,
        rawRecords as readonly PersistedSavedEnvironmentRecord[],
      );
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    GET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return null;
      }

      return readSavedEnvironmentSecret({
        registryPath: deps.savedEnvironmentRegistryPath,
        environmentId: rawEnvironmentId,
        secretStorage: deps.getDesktopSecretStorage(),
      });
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    SET_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown, rawSecret: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        throw new Error("Invalid saved environment id.");
      }
      if (typeof rawSecret !== "string" || rawSecret.trim().length === 0) {
        throw new Error("Invalid saved environment secret.");
      }

      return writeSavedEnvironmentSecret({
        registryPath: deps.savedEnvironmentRegistryPath,
        environmentId: rawEnvironmentId,
        secret: rawSecret,
        secretStorage: deps.getDesktopSecretStorage(),
      });
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL,
    async (_event, rawEnvironmentId: unknown) => {
      if (typeof rawEnvironmentId !== "string" || rawEnvironmentId.trim().length === 0) {
        return;
      }

      removeSavedEnvironmentSecret({
        registryPath: deps.savedEnvironmentRegistryPath,
        environmentId: rawEnvironmentId,
      });
    },
    { requireMainFrame: false },
  );
}
