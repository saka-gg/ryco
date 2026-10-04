import {
  ProviderDriverKind,
  type ModelCapabilities,
  type OpenCodeSettings,
  type ServerProviderModel,
} from "@ryco/contracts";
import { Cause, Data, Effect } from "effect";

import { createModelCapabilities } from "@ryco/shared/model";

import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import type { ServerProviderRateLimits } from "@ryco/contracts";
import { probeOpenCodeGoUsageRateLimits } from "./OpenCodeGoUsage.ts";
import {
  describeUnsupportedOpenCodeVersion,
  OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
} from "../openCodeVersion.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
  verifyOpenCodeServerVersion,
} from "../opencodeRuntime.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

const PROVIDER = ProviderDriverKind.make("opencode");
const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;
class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.entries(input.model.variants ?? {})
    .filter(([, configuration]) => configuration.disabled !== true)
    .map(([variant]) => variant)
    .toSorted((left, right) => left.localeCompare(right));
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) =>
    defaultVariant === value
      ? { id: value, label: titleCaseSlug(value), isDefault: true as const }
      : { id: value, label: titleCaseSlug(value) },
  );
  const primaryAgents = [
    ...new Map(
      input.agents
        .filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"))
        .map((agent) => [agent.name, agent] as const),
    ).values(),
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...(variantOptions.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variantOptions,
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models = new Map<string, ServerProviderModel>();

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const modelId = nonEmptyTrimmed(model.id);
      const name = nonEmptyTrimmed(model.name);
      if (!modelId || !name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      const shortName = subProvider
        ? deriveShortNameByStrippingPrefix(name, subProvider)
        : undefined;
      // Older OpenCode servers may omit `limit`; read defensively so the
      // context meter just falls back to "unknown" instead of failing.
      const maxContextTokens = model.limit?.context;
      const slug = `${provider.id}/${modelId}`;
      if (models.has(slug)) {
        continue;
      }
      models.set(slug, {
        slug,
        name,
        ...(subProvider ? { subProvider } : {}),
        ...(shortName ? { shortName } : {}),
        ...(typeof maxContextTokens === "number" &&
        Number.isFinite(maxContextTokens) &&
        maxContextTokens > 0
          ? { maxContextTokens: Math.floor(maxContextTokens) }
          : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return [...models.values()].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
  );
}

/**
 * Strip a leading provider prefix from `name` so the chat-box trigger doesn't
 * render it twice next to the same word in the subProvider slot. Returns
 * `undefined` when the prefix doesn't apply or the remainder is empty.
 */
function deriveShortNameByStrippingPrefix(name: string, prefix: string): string | undefined {
  const lowerName = name.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerName.startsWith(lowerPrefix)) {
    return undefined;
  }
  const rest = name.slice(prefix.length).trimStart();
  return rest.length > 0 ? rest : undefined;
}

export const makePendingOpenCodeProvider = (
  openCodeSettings: OpenCodeSettings,
): ServerProviderDraft => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          openCodeSettings.serverUrl.trim().length > 0
            ? "OpenCode is disabled in Ryco settings. A server URL is configured."
            : "OpenCode is disabled in Ryco settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "OpenCode provider status has not been checked in this session yet.",
    },
  });
};

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  probeUsage: (
    probeEnvironment: NodeJS.ProcessEnv,
  ) => Effect.Effect<ServerProviderRateLimits | undefined> = probeOpenCodeGoUsageRateLimits,
): Effect.fn.Return<ServerProviderDraft, never, OpenCodeRuntime> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const checkedAt = new Date().toISOString();
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      serverUrl: openCodeSettings.serverUrl,
    });
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode is disabled in Ryco settings. A server URL is configured."
          : "OpenCode is disabled in Ryco settings.",
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCodeRuntime
        .runOpenCodeCommand({
          binaryPath: openCodeSettings.binaryPath,
          args: ["--version"],
          environment,
        })
        .pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      return fallback(Cause.squash(versionExit.cause));
    }
    version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

    if (!version) {
      return fallback(new Error(OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE), null);
    }
    // Gate before connecting: a 2.x binary must never be started as a server (it converts the
    // shared OpenCode database in place). Built directly, so formatOpenCodeProbeError never
    // rewrites the message.
    const versionProblem = describeUnsupportedOpenCodeVersion(version, "binary");
    if (versionProblem !== null) {
      return buildServerProvider({
        presentation: OPENCODE_PRESENTATION,
        enabled: openCodeSettings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          [],
          PROVIDER,
          customModels,
          DEFAULT_OPENCODE_MODEL_CAPABILITIES,
        ),
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: versionProblem,
        },
      });
    }
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openCodeRuntime
          .connectToOpenCodeServer({
            binaryPath: openCodeSettings.binaryPath,
            serverUrl: openCodeSettings.serverUrl,
            ...(openCodeSettings.serverPassword
              ? { serverPassword: openCodeSettings.serverPassword }
              : {}),
            environment,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
        const client = yield* openCodeRuntime
          .createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: cwd,
            ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
        const serverVersion = yield* verifyOpenCodeServerVersion(client).pipe(
          Effect.mapError(
            (cause) => new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
          ),
        );
        const inventory = yield* openCodeRuntime
          .loadOpenCodeInventory(client)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
            ),
          );
        return { inventory, serverVersion };
      }),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  version = inventoryExit.value.serverVersion;
  const models = providerModelsFromSettings(
    flattenOpenCodeModels(inventoryExit.value.inventory),
    PROVIDER,
    customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
  const connectedCount = new Set(inventoryExit.value.inventory.providerList.connected).size;
  // Account-level Go usage limits; degrades to `undefined` without a Go key.
  const rateLimits = yield* probeUsage(environment).pipe(Effect.orElseSucceed(() => undefined));
  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    ...(rateLimits ? { rateLimits } : {}),
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
            : "OpenCode is available, but it did not report any connected upstream providers.",
    },
  });
});
