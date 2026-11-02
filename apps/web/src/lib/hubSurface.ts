import { isHostedHubMode } from "../env";

/**
 * The root attribute marking a hosted-Hub document. `src/index.css` scopes
 * every Hub rule behind it.
 *
 * There is deliberately no matching `hub:` Tailwind custom variant. Registering
 * one perturbs the order Tailwind emits utilities in, which reproducibly moves
 * the node app's chat composer — see the note on `.hub-ambient` in
 * `src/index.css` for the bisection. Attribute-scoped rules give the same
 * isolation without touching the node app's stylesheet at all.
 */
export const HUB_SURFACE_ATTRIBUTE = "data-surface";

export const HUB_SURFACE_VALUE = "hub";

/**
 * Stamps `data-surface="hub"` on `document.documentElement` when — and only
 * when — this is a hosted-Hub build.
 *
 * This is the structural half of separating the Hub website's design from the
 * node app's. `VITE_RYCO_CLIENT_MODE` is a build-time define (`env.ts`), so the
 * attribute is not a runtime toggle and cannot flicker: a standard build
 * compiles to a call that never stamps anything, which leaves every `hub:`
 * utility and every `:root[data-surface="hub"]` rule inert there. Hub styling
 * therefore cannot influence the node app by accident, rather than by review
 * discipline.
 *
 * Deliberately simpler than {@link syncDocumentPresentationTier}: the tier is a
 * live media classification that needs a subscription and change notification,
 * while the surface is a fixed property of the bundle. There is nothing to
 * observe and nothing to tear down.
 *
 * Scoping note: `:root[data-surface="hub"]` has specificity (0,2,0), so it wins
 * against the runtime-injected `<style id="ryco-active-theme">` — which writes
 * plain `:root{}` / `:root.dark{}` rules — regardless of source order.
 */
export function syncDocumentHubSurface(): void {
  if (typeof document === "undefined") return;
  if (!isHostedHubMode()) return;
  document.documentElement.setAttribute(HUB_SURFACE_ATTRIBUTE, HUB_SURFACE_VALUE);
}

/**
 * Whether the current document is a Hub surface.
 *
 * Reads the stamped attribute rather than {@link isHostedHubMode} so callers
 * agree with what CSS is actually matching. Test environments that render a
 * hosted surface without booting `main.tsx` will read `false` here — which is
 * correct: nothing stamped the attribute, so no Hub rule applied either.
 */
export function isHubSurface(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute(HUB_SURFACE_ATTRIBUTE) === HUB_SURFACE_VALUE;
}
