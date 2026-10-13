/**
 * The provider session start a thread's turn makes, shared by the turn start
 * (`ProviderCommandReactor.ensureSessionForThread`) and the session prewarm, so a prewarmed
 * session is adopted only when it is exactly the start the turn would make.
 *
 * Pure module: no services, no I/O.
 *
 * @module threadProviderStart
 */
import type {
  AgentTokenMode,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionResumePolicy,
  ProviderSessionStartInput,
  RuntimeMode,
  ThreadId,
} from "@ryco/contracts";

export interface ThreadProviderStart {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | undefined;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly tokenMode: AgentTokenMode;
  /** The project's custom system prompt, already trimmed (empty is absent). */
  readonly customSystemPrompt: string | undefined;
}

export function threadProviderStartInput(
  start: ThreadProviderStart,
  options?: {
    readonly resumeCursor?: unknown;
    readonly resumePolicy?: ProviderSessionResumePolicy;
  },
): ProviderSessionStartInput {
  return {
    threadId: start.threadId,
    provider: start.provider,
    providerInstanceId: start.providerInstanceId,
    ...(start.cwd ? { cwd: start.cwd } : {}),
    modelSelection: start.modelSelection,
    ...(options?.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
    ...(options?.resumePolicy !== undefined ? { resumePolicy: options.resumePolicy } : {}),
    runtimeMode: start.runtimeMode,
    tokenMode: start.tokenMode,
    ...(start.customSystemPrompt !== undefined
      ? { customSystemPrompt: start.customSystemPrompt }
      : {}),
  };
}

/** `customSystemPrompt` as both starts pass it. */
export function projectStartSystemPrompt(
  project: { readonly customSystemPrompt?: string | null | undefined } | undefined,
): string | undefined {
  return project?.customSystemPrompt?.trim() || undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .toSorted()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Equal for two starts that would configure the same provider session. */
export function threadProviderStartKey(start: ThreadProviderStart): string {
  return canonicalJson({
    threadId: start.threadId,
    providerInstanceId: start.providerInstanceId,
    cwd: start.cwd ?? null,
    modelSelection: start.modelSelection,
    runtimeMode: start.runtimeMode,
    tokenMode: start.tokenMode,
    customSystemPrompt: start.customSystemPrompt ?? null,
  });
}
