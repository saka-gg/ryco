import {
  DEFAULT_AGENT_TOKEN_MODE,
  type AgentTokenMode,
  type CommandId,
  type EnvironmentApi,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type ThreadUsageLimit,
} from "@ryco/contracts";
import {
  USAGE_LIMIT_RESUME_MESSAGE,
  applicableUsageLimit,
  usageLimitResumeIds,
} from "@ryco/shared/usageLimit";

import type { ClaudeCacheReviewPresentation } from "./claudeCacheReview.ts";
import type { CommitSendTurnDispatchInput } from "./sendEngine.ts";

export interface UsageLimitResumeThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode | undefined;
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly session?: { readonly provider: ProviderDriverKind } | null | undefined;
}

/**
 * "Resume now" for a usage-limited thread, sent through the shared send engine so the
 * Claude cache review and mutation readiness apply. It shares its command and message
 * ids with the server's auto-resume, so a click and the worker converge on one turn, and
 * runs with the thread's own model and modes rather than the composer's staged ones.
 * Returns null when the thread has no applicable limit.
 */
export function buildUsageLimitResumeDispatch(input: {
  readonly api: EnvironmentApi;
  readonly thread: UsageLimitResumeThread;
  readonly claudeCacheReview?: ClaudeCacheReviewPresentation | undefined;
  readonly assertMutationReady?: (() => void) | undefined;
  readonly createdAt: string;
  readonly newCommandId: () => CommandId;
}): CommitSendTurnDispatchInput | null {
  const limit = applicableUsageLimit(input.thread);
  if (limit === null) return null;
  const { commandId, messageId } = usageLimitResumeIds(limit.limitId);
  const sessionProvider = input.thread.session?.provider ?? null;
  return {
    ...(input.claudeCacheReview ? { claudeCacheReview: input.claudeCacheReview } : {}),
    ...(input.assertMutationReady ? { assertMutationReady: input.assertMutationReady } : {}),
    providerDriver: sessionProvider ?? limit.provider,
    sourceProviderDriver: sessionProvider,
    api: input.api,
    threadId: input.thread.id,
    isFirstMessage: false,
    isServerThread: true,
    // Only a first message uses its title seed, but the seed is always sent: keep it non-empty.
    title: input.thread.title,
    messageId,
    commandId,
    usageLimitResumeGuard: { limitId: limit.limitId, origin: "manual" },
    outgoingMessageText: USAGE_LIMIT_RESUME_MESSAGE,
    turnAttachments: [],
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    tokenMode: input.thread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    bootstrap: undefined,
    sourceControlContexts: [],
    createdAt: input.createdAt,
    newCommandId: input.newCommandId,
    beginLocalDispatch: () => {},
    persistThreadSettingsForNextTurn: () => Promise.resolve(),
  };
}
