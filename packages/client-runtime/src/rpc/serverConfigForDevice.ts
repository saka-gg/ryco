/**
 * serverConfigForDevice - A node's server config as a device may keep it.
 *
 * Its own subpath, apart from `environmentServerConfigs`: that module is on
 * every client's boot path, and this one carries the secret-redaction rules
 * (`@ryco/shared/settingsSecrets`), which only a client that saves the config
 * on the device needs.
 *
 * @module rpc/serverConfigForDevice
 */
import type { ServerConfig } from "@ryco/contracts";
import {
  PROVIDER_SECRET_CONFIG_KEYS,
  PROVIDER_URL_CONFIG_KEYS,
  redactSettingSecret,
  redactUrlCredentials,
} from "@ryco/shared/settingsSecrets";

function redactConfigRecord<T>(config: T): T {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  let redacted: Record<string, unknown> | undefined;
  const put = (key: string, value: string) => {
    if (record[key] === value) return;
    redacted ??= { ...record };
    redacted[key] = value;
  };
  for (const key of PROVIDER_SECRET_CONFIG_KEYS) {
    const value = record[key];
    if (typeof value === "string") put(key, redactSettingSecret(value));
  }
  for (const key of PROVIDER_URL_CONFIG_KEYS) {
    const value = record[key];
    if (typeof value === "string") put(key, redactUrlCredentials(value));
  }
  return (redacted ?? record) as T;
}

/**
 * The config as it may be kept on a device. Nodes already send every client a
 * redacted copy (no secret leaves the node); this applies the same rules once
 * more, so a node from before that redaction can never leave a secret in a
 * device cache: sensitive provider variables, provider passwords, credentials
 * in URLs, and CLIProxyAPI hub keys are blanked.
 */
export function serverConfigForDevice(config: ServerConfig): ServerConfig {
  const settings = config.settings;
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      {
        ...instance,
        ...(instance.environment
          ? {
              environment: instance.environment.map((variable) =>
                variable.sensitive
                  ? {
                      ...variable,
                      value: "",
                      ...(variable.value.length > 0 || variable.valueRedacted
                        ? { valueRedacted: true }
                        : {}),
                    }
                  : variable,
              ),
            }
          : {}),
        ...(instance.config !== undefined ? { config: redactConfigRecord(instance.config) } : {}),
      },
    ]),
  ) as typeof settings.providerInstances;
  const providers = Object.fromEntries(
    Object.entries(settings.providers).map(([driver, providerConfig]) => [
      driver,
      redactConfigRecord(providerConfig),
    ]),
  ) as typeof settings.providers;
  const cliProxyHubs = Object.fromEntries(
    Object.entries(settings.cliProxyHubs).map(([hubId, hub]) => [
      hubId,
      {
        ...hub,
        url: redactUrlCredentials(hub.url),
        managementKey: "",
        ...(hub.managementKey.length > 0 || hub.managementKeyRedacted
          ? { managementKeyRedacted: true }
          : {}),
        ...(hub.cloudflareAccessClientSecret !== undefined
          ? {
              cloudflareAccessClientSecret: "",
              ...(hub.cloudflareAccessClientSecret.length > 0 ||
              hub.cloudflareAccessClientSecretRedacted
                ? { cloudflareAccessClientSecretRedacted: true }
                : {}),
            }
          : {}),
      },
    ]),
  ) as typeof settings.cliProxyHubs;
  return {
    ...config,
    settings: {
      ...settings,
      providers,
      providerInstances,
      cliProxyHubs,
      observability: {
        ...settings.observability,
        otlpTracesUrl: redactUrlCredentials(settings.observability.otlpTracesUrl),
        otlpMetricsUrl: redactUrlCredentials(settings.observability.otlpMetricsUrl),
      },
    },
  };
}
