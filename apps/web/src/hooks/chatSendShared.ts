import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type AgentTokenMode,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@ryco/contracts";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@ryco/shared/model";
import { DateTime } from "effect";

import { resolveBuildModeModelSelection } from "../buildMode";
import {
  maybeResolveDevicePromptAttachment,
  type DevicePromptAttachmentResolution,
} from "../lib/devicePromptContext";
import { getPresentationTier } from "../lib/presentationTier";
import {
  changeRequestDetailQueryOptions,
  issueDetailQueryOptions,
} from "../lib/sourceControlContextRpc";
import { newCommandId } from "../lib/utils";
import { getProviderModelCapabilities } from "../providerModels";
import type { QueryClient } from "../rpc/queryClient";
import { DEFAULT_AGENT_TOKEN_MODE, DEFAULT_INTERACTION_MODE } from "../types";
import { useUiStateStore } from "../uiStateStore";
import type {
  SendTurnComposerSnapshot,
  SendTurnPersistSettingsDeps,
  SendTurnSettings,
  SendTurnSourceControlFetcher,
} from "./executeChatSendTurn";

// ---------------------------------------------------------------------------
// Send helpers shared by the foreground ChatView send and the headless
// background queue sender, so a queued message replays exactly like a live
// send no matter which of them dispatches it.
// ---------------------------------------------------------------------------

export function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

type PersistThreadSettingsInput = Parameters<
  SendTurnPersistSettingsDeps["persistThreadSettingsForNextTurn"]
>[0];

/** Writes only the modes that differ from the thread's current settings. */
export async function persistThreadSettingsForNextTurn(
  api: EnvironmentApi,
  current: {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly tokenMode?: AgentTokenMode | undefined;
  },
  input: PersistThreadSettingsInput,
): Promise<void> {
  if (input.runtimeMode !== current.runtimeMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.runtime-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      createdAt: input.createdAt,
    });
  }

  if (input.interactionMode !== current.interactionMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
      createdAt: input.createdAt,
    });
  }

  if (input.tokenMode !== (current.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE)) {
    await api.orchestration.dispatchCommand({
      type: "thread.token-mode.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      tokenMode: input.tokenMode,
      createdAt: input.createdAt,
    });
  }
}

/** Refreshes a stale issue / change-request context before it is sent. */
export function createSourceControlContextFetcher(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly queryClient: QueryClient;
}): SendTurnSourceControlFetcher["fetcher"] {
  const { environmentId, cwd, queryClient } = input;
  return async (ctx: ComposerSourceControlContext) => {
    if (!cwd) return ctx;
    const now = DateTime.fromDateUnsafe(new Date());
    const staleAfterDate = DateTime.fromDateUnsafe(new Date(Date.now() + 5 * 60 * 1000));
    if (ctx.kind === "issue") {
      const detail = await queryClient.fetchQuery(
        issueDetailQueryOptions({
          environmentId,
          cwd,
          reference: String(ctx.detail.number),
        }),
      );
      return {
        ...ctx,
        detail,
        fetchedAt: now,
        staleAfter: staleAfterDate,
      };
    }
    const detail = await queryClient.fetchQuery(
      changeRequestDetailQueryOptions({
        environmentId,
        cwd,
        reference: String(ctx.detail.number),
      }),
    );
    return { ...ctx, detail, fetchedAt: now, staleAfter: staleAfterDate };
  };
}

/** The non-hook form of ChatView's Build-mode lock. */
export function resolveEnforceBuildMode(): boolean {
  return useUiStateStore.getState().alwaysUseBuildMode && getPresentationTier() !== "phone";
}

/**
 * With the Build-mode lock on, every dispatched turn runs in Build mode, even
 * a message queued as Plan/Ask before the setting flipped. Queued messages
 * otherwise keep the settings snapshot from enqueue time.
 */
export function applyBuildModeToSend(input: {
  readonly composer: SendTurnComposerSnapshot;
  readonly settings: SendTurnSettings;
  readonly enforceBuildMode: boolean;
}): { composer: SendTurnComposerSnapshot; settings: SendTurnSettings } {
  if (!input.enforceBuildMode) return { composer: input.composer, settings: input.settings };
  return {
    composer: {
      ...input.composer,
      selectedModelSelection: resolveBuildModeModelSelection(
        input.composer.selectedProvider,
        input.composer.selectedModelSelection,
      ),
    },
    settings: { ...input.settings, interactionMode: DEFAULT_INTERACTION_MODE },
  };
}

export type DevicePromptScreenshotNotice =
  | { readonly kind: "skipped"; readonly maxAttachments: number }
  | {
      readonly kind: "unavailable";
      readonly reason: Extract<DevicePromptAttachmentResolution, { requested: true }>["reason"];
    };

/**
 * Attaches the simulator screen when the prompt asks about it. `notify` lets
 * the foreground surface a toast; the headless background sender passes none.
 */
export async function attachDevicePromptScreenshot(input: {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly composer: SendTurnComposerSnapshot;
  readonly notify?: (notice: DevicePromptScreenshotNotice) => void;
}): Promise<SendTurnComposerSnapshot> {
  const { composer } = input;
  const devicePromptAttachment: DevicePromptAttachmentResolution =
    await maybeResolveDevicePromptAttachment({
      api: input.api,
      threadId: input.threadId,
      prompt: composer.prompt,
    }).catch(() => ({ requested: false, image: null }));
  if (devicePromptAttachment.image) {
    if (composer.images.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return { ...composer, images: [...composer.images, devicePromptAttachment.image] };
    }
    URL.revokeObjectURL(devicePromptAttachment.image.previewUrl);
    input.notify?.({ kind: "skipped", maxAttachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS });
  } else if (devicePromptAttachment.requested) {
    input.notify?.({ kind: "unavailable", reason: devicePromptAttachment.reason });
  }
  return composer;
}
