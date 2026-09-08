import { useAppearancePreference } from "./useAppearancePreference";
import {
  applyAppearancePreferencesToDocument,
  setAppearancePreference,
} from "../themes/appearancePreferences";

export type DiffRenderMode = "stacked" | "split";

function setDiffLayout(layout: DiffRenderMode): void {
  setAppearancePreference("diffLayout", layout);
  applyAppearancePreferencesToDocument();
}

/** One preference for Appearance and the diff toolbar, including already-open panels. */
export function useDiffLayout(): readonly [DiffRenderMode, typeof setDiffLayout] {
  const layout = useAppearancePreference("diffLayout");
  return [layout === "split" ? "split" : "stacked", setDiffLayout];
}
