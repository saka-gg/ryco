// Phone glue around the shared "Turn into project" rules (`@ryco/client-runtime/state/chats`):
// which preview speaks for the location in the field, and the next free folder name when the
// one typed is taken. The rules themselves (status copy, plan, steps, errors) are web's too.
import {
  destinationLeaf,
  freeLeafCandidates,
  replaceDestinationLeaf,
} from "@ryco/client-runtime/state/chats";
import type { ProjectsPromoteChatPreviewResult } from "@ryco/contracts";

/** A preview the node answered, with the location exactly as it was asked for. */
export interface PromoteChatPreviewAnswer {
  /** The trimmed location the preview was asked for. */
  readonly destination: string;
  readonly result: ProjectsPromoteChatPreviewResult;
}

/**
 * The preview that judges the location in the field now, or null while it is being checked.
 * An older answer for another location never speaks for the new one.
 */
export function previewForDestination(
  answer: PromoteChatPreviewAnswer | null,
  destination: string,
): ProjectsPromoteChatPreviewResult | null {
  if (answer === null) return null;
  return answer.destination === destination.trim() ? answer.result : null;
}

/** The locations to probe, in order, when the folder in `destination` already exists. */
export function freeDestinationCandidates(destination: string): string[] {
  const trimmed = destination.trim();
  if (trimmed.length === 0) return [];
  return freeLeafCandidates(destinationLeaf(trimmed)).map((leaf) =>
    replaceDestinationLeaf(trimmed, leaf),
  );
}

/**
 * Probes `candidates` one at a time with `preview` and returns the first the node calls
 * available, or null (none of them is, or a probe failed). Stops early once `cancelled` says so.
 */
export async function findFreeDestination(input: {
  readonly candidates: ReadonlyArray<string>;
  readonly preview: (destination: string) => Promise<ProjectsPromoteChatPreviewResult>;
  readonly cancelled: () => boolean;
}): Promise<string | null> {
  for (const candidate of input.candidates) {
    if (input.cancelled()) return null;
    const result = await input.preview(candidate).catch(() => null);
    if (result === null) return null;
    if (result.destinationStatus === "available") return candidate;
  }
  return null;
}
