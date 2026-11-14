import type { ScopedThreadRef, ServerConfig } from "@ryco/contracts";
import {
  type ComposerImageAttachment,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type TerminalContextDraft } from "../../lib/terminalContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

export const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

export function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

export function mergeStashedPrompt(currentPrompt: string, stashedPrompt: string): string {
  if (stashedPrompt.trim().length === 0) return currentPrompt;
  if (currentPrompt.length === 0) return stashedPrompt;
  return `${currentPrompt}\n\n${stashedPrompt}`;
}

export function formatStashImageNames(names: ReadonlyArray<string>): string {
  const visible = names.slice(0, 3);
  const suffix = names.length > visible.length ? ` and ${names.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

export function stashSnapshotKey(
  target: ScopedThreadRef | DraftId,
  prompt: string,
  images: ReadonlyArray<ComposerImageAttachment>,
): string {
  const targetKey =
    typeof target === "string" ? target : `${target.environmentId}:${target.threadId}`;
  return `${targetKey}\u0000${prompt}\u0000${images.map((image) => image.id).join("\u0001")}`;
}

export function revokeUnreferencedStashPreviewUrls(
  images: ReadonlyArray<ComposerImageAttachment>,
): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  const referencedPreviewUrls = new Set(
    Object.values(useComposerDraftStore.getState().draftsByThreadKey).flatMap((draft) =>
      draft.images.map((image) => image.previewUrl),
    ),
  );
  for (const image of images) {
    if (image.previewUrl.startsWith("blob:") && !referencedPreviewUrls.has(image.previewUrl)) {
      URL.revokeObjectURL(image.previewUrl);
    }
  }
}

export const selectLiveThreadModelSelectionSupported = (config: ServerConfig | null): boolean =>
  config?.environment.capabilities.liveThreadModelSelection === true;
