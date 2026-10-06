/**
 * Where a token's popover goes (the lab's `steer` + `pin`): a virtual anchor
 * for Base UI's positioner that reports a one-pixel line just above the spot
 * `tokenPopupSpot` picks — under the whole sentence at the token's x, inside
 * the dialog. The positioner re-reads it whenever the popup resizes or
 * anything scrolls, so the popover stays put while its content changes.
 *
 * Elements are found by attribute, never held: `[data-ae-ed]` is the
 * editor, `[data-tok]` its tokens and picks, `[data-ae-pop]` the open popup.
 */
import type { EditorTokenKind } from "./editorModel.logic";
import { tokenPopupSpot } from "./editorModel.logic";

/** Base UI's (Floating UI's) virtual element. */
export interface TokenVirtualAnchor {
  getBoundingClientRect(): DOMRect;
  readonly contextElement?: Element | undefined;
}

export const TOKEN_POPUP_PAD = 12;

/** The `data-ae-pop` value of a token's popup. */
export function tokenPopupId(editorId: string, kind: EditorTokenKind): string {
  return `${editorId}:${kind}`;
}

export function findEditorToken(editorId: string, kind: EditorTokenKind): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const root = document.querySelector(`[data-ae-ed="${CSS.escape(editorId)}"]`);
  return root?.querySelector<HTMLElement>(`[data-tok="${kind}"]`) ?? null;
}

export function findTokenPopup(editorId: string, kind: EditorTokenKind): HTMLElement | null {
  if (typeof document === "undefined") return null;
  // A closing popup may linger while it fades: the newest is the open one.
  const all = document.querySelectorAll<HTMLElement>(
    `[data-ae-pop="${CSS.escape(tokenPopupId(editorId, kind))}"]`,
  );
  return all.item(all.length - 1);
}

export function tokenAnchor(
  editorId: string,
  kind: EditorTokenKind,
  gap: number,
): TokenVirtualAnchor {
  return {
    getBoundingClientRect() {
      const token = findEditorToken(editorId, kind);
      if (!token) return new DOMRect(0, 0, 0, 0);
      const tokenRect = token.getBoundingClientRect();
      const dialog = token.closest(".ad-dialog") ?? document.documentElement;
      const reference = token.closest(".ae-sentence") ?? token;
      const popup = findTokenPopup(editorId, kind);
      const spot = tokenPopupSpot({
        dialog: dialog.getBoundingClientRect(),
        reference: reference.getBoundingClientRect(),
        token: tokenRect,
        popup: { width: popup?.offsetWidth ?? 0, height: popup?.offsetHeight ?? 0 },
        gap,
        pad: TOKEN_POPUP_PAD,
      });
      return new DOMRect(spot.left, spot.top - gap - 1, tokenRect.width, 1);
    },
    get contextElement() {
      return findEditorToken(editorId, kind) ?? undefined;
    },
  };
}
