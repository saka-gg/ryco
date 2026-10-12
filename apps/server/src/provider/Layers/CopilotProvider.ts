import type { CopilotSettings, ModelCapabilities, ServerProviderModel } from "@ryco/contracts";
import { ProviderDriverKind } from "@ryco/contracts";
import { CopilotClient, type ModelInfo } from "@github/copilot-sdk";
import { Effect, Result } from "effect";
import { createModelCapabilities } from "@ryco/shared/model";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { makeCopilotClientOptions } from "./CopilotAdapter.ts";
import { COPILOT_CLIENT_STOP_TIMEOUT_MS, stopCopilotClient } from "./CopilotAdapter.clientStop.ts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  showInteractionModeToggle: true,
} as const;
const COPILOT_HEALTH_CHECK_TIMEOUT_MS = 10_000;

const EMPTY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const COPILOT_REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
    }),
  ],
});

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5",
    name: "GPT-5",
    isCustom: false,
    capabilities: COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "gpt-5-mini",
    name: "GPT-5 Mini",
    isCustom: false,
    capabilities: COPILOT_REASONING_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  },
];

function mapCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  const supportsReasoningEffort = model.capabilities.supports?.reasoningEffort ?? false;
  if (!supportsReasoningEffort || !model.supportedReasoningEfforts) {
    return EMPTY_MODEL_CAPABILITIES;
  }

  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: model.supportedReasoningEfforts.map((value) => ({
          value,
          label: value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
          ...(value === model.defaultReasoningEffort ? { isDefault: true } : {}),
        })),
      }),
    ],
  });
}

export function mapCopilotModel(model: ModelInfo): ServerProviderModel {
  const maxContextTokens = model.capabilities.limits?.max_context_window_tokens;
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: mapCopilotModelCapabilities(model),
    ...(Number.isSafeInteger(maxContextTokens) && maxContextTokens > 0 ? { maxContextTokens } : {}),
  };
}

function formatCopilotAuthLabel(authType: string | undefined): string | undefined {
  switch (authType) {
    case "user":
      return "GitHub User";
    case "gh-cli":
      return "GitHub CLI";
    case "env":
      return "Environment Token";
    case "api-key":
      return "API Key";
    case "token":
      return "Token";
    case "hmac":
      return "HMAC";
    default:
      return undefined;
  }
}

function withTimeout<A>(promise: Promise<A>, timeoutMs: number, label: string): Promise<A> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function makeClient(
  settings: Pick<CopilotSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv | undefined,
) {
  return new CopilotClient(makeCopilotClientOptions(settings, environment));
}

const withClient = <A>(
  settings: Pick<CopilotSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv | undefined,
  f: (client: CopilotClient) => Promise<A>,
): Effect.Effect<A, ProviderAdapterProcessError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => makeClient(settings, environment)),
    (client) =>
      Effect.tryPromise({
        try: () => f(client),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: "provider-check",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
    // A probe owns no sessions, so a stuck stop is force-stopped quickly (also at shutdown).
    (client) =>
      Effect.promise(() =>
        stopCopilotClient({ client, timeoutMs: COPILOT_CLIENT_STOP_TIMEOUT_MS }),
      ),
  );

export function makePendingCopilotProvider(settings: CopilotSettings): ServerProviderDraft {
  const checkedAt = new Date().toISOString();
  const models = getCopilotFallbackModels(settings);

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in Ryco settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot availability...",
    },
  });
}

export function getCopilotFallbackModels(
  settings: Pick<CopilotSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    EMPTY_MODEL_CAPABILITIES,
  );
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = new Date().toISOString();
  const builtInModels = getCopilotFallbackModels(settings);

  if (!settings.enabled) {
    return makePendingCopilotProvider(settings);
  }

  const statusResult = yield* withClient(settings, environment, async (client) => {
    await client.start();
    const [status, auth, models] = await withTimeout(
      Promise.all([client.getStatus(), client.getAuthStatus(), client.listModels()]),
      COPILOT_HEALTH_CHECK_TIMEOUT_MS,
      "GitHub Copilot health check",
    );

    const resolvedModels =
      models.length > 0
        ? [
            ...models.map(mapCopilotModel),
            ...providerModelsFromSettings(
              [],
              PROVIDER,
              settings.customModels,
              EMPTY_MODEL_CAPABILITIES,
            ),
          ]
        : builtInModels;

    const probe: ProviderProbeResult = {
      installed: true,
      version: status.version,
      status: auth.isAuthenticated ? "ready" : "error",
      auth: {
        status: auth.isAuthenticated ? "authenticated" : "unauthenticated",
        ...(auth.authType ? { type: auth.authType } : {}),
        ...(formatCopilotAuthLabel(auth.authType)
          ? { label: formatCopilotAuthLabel(auth.authType) }
          : {}),
        ...(auth.login ? { email: auth.login } : {}),
      },
      ...(auth.statusMessage ? { message: auth.statusMessage } : {}),
    };

    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: resolvedModels,
      probe,
    });
  }).pipe(Effect.result);

  if (Result.isFailure(statusResult)) {
    const cause = statusResult.failure;
    const message = cause.message;
    const missing =
      cause instanceof Error
        ? isCommandMissingCause(cause) || message.toLowerCase().includes("not found")
        : message.toLowerCase().includes("not found");
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: builtInModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : `Failed to execute GitHub Copilot health check: ${message}`,
      },
    });
  }

  return statusResult.success;
});
