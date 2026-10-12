import {
  type ContextHandoffInputBudget,
  ModelContextWindowMetadata,
  CONTEXT_HANDOFF_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ModelSelection,
} from "@ryco/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEFAULT_CONTEXT_HANDOFF_INPUT_BUDGET: ContextHandoffInputBudget = {
  maxInputChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  budgetSource: "default",
  contextWindowTokens: null,
};

const decodeMetadata = Schema.decodeUnknownOption(ModelContextWindowMetadata);

export function resolveModelContextWindow(
  driverKind: string,
  modelSlug: string,
  selection?: Pick<ModelSelection, "options">,
  metadata?: unknown,
): { readonly contextWindowTokens: number; readonly source: "manifest" | "slug" } | null {
  let tokens: number | undefined;
  let source: "manifest" | "slug" = "manifest";
  if (metadata !== undefined || driverKind === "claudeAgent") {
    const decoded = decodeMetadata(metadata);
    if (Option.isNone(decoded)) return null;
    const entry = decoded.value.find(
      (candidate) => candidate.slug === modelSlug || candidate.aliases?.includes(modelSlug),
    );
    if (!entry) return null;
    const selected = selection?.options?.find((option) => option.id === "contextWindow")?.value;
    const key = selected ?? entry.defaultContextWindow;
    tokens =
      entry.fixedContextWindowTokens ??
      (typeof key === "string" ? entry.contextWindowTokens?.[key] : undefined);
  } else {
    source = "slug";
    const matches = [
      ...modelSlug.matchAll(/(?:^|[-_[(])([1-9]\d*(?:k|m)|[1-9]\d{4,6})(?=$|[-_\])])/gi),
    ];
    if (matches.length !== 1) return null;
    const value = matches[0]![1]!.toLowerCase();
    tokens =
      Number(value.replace(/[km]$/, "")) *
      (value.endsWith("m") ? 1_000_000 : value.endsWith("k") ? 1_000 : 1);
  }
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 1_024
    ? { contextWindowTokens: tokens, source }
    : null;
}

export function resolveContextHandoffInputBudget(
  driverKind: string,
  modelSlug: string,
  selection?: Pick<ModelSelection, "options">,
  metadata?: unknown,
): ContextHandoffInputBudget {
  const window = resolveModelContextWindow(driverKind, modelSlug, selection, metadata);
  return window
    ? {
        maxInputChars: Math.min(
          CONTEXT_HANDOFF_MAX_INPUT_CHARS,
          Math.floor(window.contextWindowTokens * 0.35 * 4),
        ),
        budgetSource: window.source,
        contextWindowTokens: window.contextWindowTokens,
      }
    : DEFAULT_CONTEXT_HANDOFF_INPUT_BUDGET;
}
