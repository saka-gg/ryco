import type { CSSProperties } from "react";

export const PREFERS_REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const DEFAULT_INACTIVE_PANEL_CONTAIN_INTRINSIC_SIZE = "1px 100vh";
export const DOCUMENT_MOTION_PAUSED_ATTRIBUTE = "data-ryco-motion-paused";

interface MotionVisibilityDocument {
  readonly visibilityState: DocumentVisibilityState;
  readonly documentElement: Pick<HTMLElement, "toggleAttribute">;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function syncDocumentMotionVisibility(
  documentTarget: MotionVisibilityDocument = document,
): () => void {
  const sync = () => {
    documentTarget.documentElement.toggleAttribute(
      DOCUMENT_MOTION_PAUSED_ATTRIBUTE,
      documentTarget.visibilityState === "hidden",
    );
  };
  sync();
  documentTarget.addEventListener("visibilitychange", sync);
  return () => documentTarget.removeEventListener("visibilitychange", sync);
}

/**
 * A house motion duration in milliseconds. Appearance preferences and reduced
 * motion rewrite the tokens to zero, so a zero result means "do not animate".
 */
export function readMotionDurationMs(
  token: `--app-motion-duration-${string}`,
  fallbackMs: number,
): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallbackMs;
  return raw.endsWith("ms") ? value : value * 1000;
}

export type InactivePanelContentVisibilityStyle = CSSProperties & {
  contentVisibility: "hidden";
  containIntrinsicSize: string;
};

export function shouldEnableAutoAnimate(input: {
  prefersReducedMotion: boolean;
  withinThreshold: boolean;
}): boolean {
  return input.withinThreshold && !input.prefersReducedMotion;
}

export function resolveInactivePanelContentVisibilityStyle(input: {
  active: boolean;
  containIntrinsicSize?: string | undefined;
}): InactivePanelContentVisibilityStyle | undefined {
  if (input.active) {
    return undefined;
  }

  return {
    contentVisibility: "hidden",
    containIntrinsicSize:
      input.containIntrinsicSize ?? DEFAULT_INACTIVE_PANEL_CONTAIN_INTRINSIC_SIZE,
  };
}
