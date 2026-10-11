# Desktop-First Web: Phone "Get the App" Interstitial

- **Status:** Draft for owner approval, 2026-07-23 (revised after adversarial review)
- **Scope:** `apps/web` only. No contract, server, or deployment changes.

## Goal

A dedicated native mobile app is planned. `apps/web` becomes desktop-first: on a
phone-tier visit, the web app offers the native app first and keeps the existing
responsive phone experience reachable behind a one-tap "Continue in browser"
fallback.

The responsive phone tier is **frozen, not deleted**: it must keep working
unchanged until the native app reaches parity, and its removal is a separate,
explicitly approved change. This design adds a presentation-only overlay in
front of the phone experience; it does not modify the tier, the shell, or any
lifecycle behavior.

## Constraints (locked)

1. Do not remove or modify `components/shell/phone/*`, the presentation-tier
   signal (`lib/presentationTier.ts`), or the acceptance matrix.
2. The flag defaults **off**; merging this change alters no behavior anywhere
   until a build deliberately enables it. Enabling it in any deployed
   environment is a separate, owner-approved decision outside this change.
3. Deep-linked pairing ceremonies (`/pair`, hosted pairing links) are never
   gated. Other flows — including hosted sign-in — may see the interstitial
   **once per page load, at load time only**, always one tap away from the
   unchanged web experience. It must never appear mid-session over a surface
   the user is already using.
4. A tier flip must never unmount a mounted workspace (the
   `AppSidebarLayout` no-remount invariant), and the interstitial must never
   alter connection, authentication, or hosted-lifecycle behavior.

## Approaches considered

**A — Latched overlay at the root shell branch (chosen).** The tier signal
stays media-driven and untouched. On qualifying phone visits a full-screen
interstitial overlay renders **above** the normal route branch; the branch
itself (`HostedHubRoot` or `RootAppShell`) mounts and behaves exactly as today
underneath — hosted bootstrap, browser-lifecycle wiring, connection setup, and
onboarding surfaces all run unchanged. Dismissing removes the overlay.
Lowest blast radius: nothing is conditionally unmounted, no lifecycle owner is
displaced, and the phone tier, its CSS variants, and its acceptance matrix
behave exactly as today.

An earlier draft rendered the interstitial _instead of_ the shell; adversarial
review refuted it: in hosted mode the whole auth/onboarding funnel (sign-in,
invitation redemption, recovery codes — `HostedHubRoot.tsx:51-58`) lives under
the single `hosted-hub` gate state, so replacement gated onboarding, and it
left `hostedHubController.bootstrap()`'s directory polling running while its
only suspend/resume owner (`useHostedBrowserLifecycle`, mounted inside
`HostedHubRoot`) was absent. The overlay dissolves both problems.

**B — True tier freeze inside `computeTier()` (rejected).** Forcing the
`desktop` tier on phones inverts phone-conditional behavior across the app
(bootstrap thread redirect in `RootAppShell.logic.ts`, appearance transparency
defaults in `themes/appearancePreferences.ts:328`, context-menu sheet gating in
`localApi.ts`, the 44 px coarse-pointer touch floor across ~227 `phone:` CSS
usages) and delivers a degraded desktop layout on 320 px devices. It also
conflicts with the acceptance matrix, which drives the tier via viewport media
queries in every sweep. High risk, no additional user value.

**C — Hosted entry-funnel step only (rejected).** Gating inside
`HostedHubRoot` covers only the hosted client mode, misses standard-mode phone
visits, and inserts a new surface into the entry funnel that the acceptance
matrix sweeps (`ENTRY_SURFACES`) would have to model. Design A covers hosted
and standard modes at one seam the matrix does not mount.

## Design

### Flags (build-time, additive)

Two new Vite defines in `apps/web/vite.config.ts`, with typed readers in
`apps/web/src/env.ts`, following the existing `VITE_RYCO_CLIENT_MODE` pattern:

- `VITE_RYCO_PHONE_APP_INTERSTITIAL` — `"enabled" | "disabled"`, default
  `"disabled"`. Any value other than `"enabled"` is `"disabled"`.
- `VITE_RYCO_MOBILE_APP_URL` — the store/TestFlight URL the interstitial links
  to, default `""`.

So the pass-through is testable, both values are threaded through
`createWebViteConfig` parameters (as `clientMode` already is for the hosted
PWA plugin) rather than read from module scope.

Reader: `isPhoneAppInterstitialEnabled(): boolean` — true only when the flag is
`"enabled"` **and** `VITE_RYCO_MOBILE_APP_URL` is a non-empty `https:` URL.
An enabled flag without a valid app URL is inert (fail-safe: the gate cannot
ship a dead-end interstitial). `readMobileAppUrl(): string | null` returns the
validated URL.

### Gate placement

`RootRouteView` in `apps/web/src/routes/__root.tsx`. The `/pair` early return
and the `requires-auth` / `hosted-pairing` Outlet branches are untouched and
never show the overlay. For the three remaining branches (`authenticated`,
`hosted-static`, `hosted-hub`) the overlay renders as a **sibling above** the
existing Suspense boundary — the branch beneath is byte-for-byte the current
code:

```tsx
return (
  <>
    {showInterstitial ? <PhoneGetAppInterstitial onDismiss={dismiss} /> : null}
    <Suspense fallback={<AppBootLoadingSurface />}>…existing branch…</Suspense>
  </>
);
```

Visibility is decided by a pure, unit-testable predicate and **latched per
`RootRouteView` mount** via a lazy `useState` initializer:

```
show = isPhoneAppInterstitialEnabled()
    && !isElectron
    && getPresentationTier() === "phone"
    && !readInterstitialDismissed()
```

`getPresentationTier()` is safe here: `main.tsx` runs
`syncDocumentPresentationTier()` before the router renders, and `isElectron`
is a module-load constant set by the preload bridge.

Latch semantics: the decision is fixed when `RootRouteView` mounts and is
re-derived from the persisted dismissal if it remounts (root error-boundary
reset). A mid-session tier flip (tablet rotation into the phone media query)
can never summon the overlay, and — because the overlay never replaces the
branch — nothing is ever unmounted by gating. Two accepted edge cases:
(a) after a root error reset with storage unavailable, an in-memory dismissal
is lost and the overlay reappears once; (b) a device that loads at phone width
and rotates to desktop width before dismissal shows the phone-styled overlay
on a desktop-tier layout until dismissed. Both degrade to one extra tap.

The router `beforeLoad` context is not involved; `cachedReadyRootContext`
never captures an interstitial decision. In hosted mode,
`hostedHubController.bootstrap()`, `HostedHubRoot`, and
`useHostedBrowserLifecycle` mount and run exactly as today beneath the
overlay.

### Interstitial component

`apps/web/src/components/shell/phone/PhoneGetAppInterstitial.tsx` — a
full-screen fixed overlay (`inset-0`, above the toast viewport), self-contained (no
dependency on app shell, sidebar, or connection state):

- Brand mark + headline ("Ryco is better as an app") + one sentence of copy.
- Primary action: **Get the app** — a plain `<a href={mobileAppUrl}
  target="_blank" rel="noreferrer">` (no `window.open`, works under popup
  blockers).
- Secondary action: **Continue in browser** — records the dismissal and
  removes the overlay, revealing the already-mounted experience.
- Accessibility: the dialog portals to `document.body`; while open it marks
  `#root` inert, moves focus into the dialog, traps its controls, and handles
  `Escape` on the dialog itself. If `#root` is absent, the inert step is
  skipped.
- Styling uses the existing phone primitives and conventions
  (`components/mobile/GlassSurface`, safe-area insets, reduced-motion
  compliance, ≥44 px touch targets), matching the frozen phone tier's look.

### Dismissal persistence

Follows the codebase's hosted-mode storage convention
(`!isHostedHubMode()` gating, as in `composerDraftPersistence.ts:53`,
`terminalStateStore.ts:73`, `hooks/useLocalStorage.ts:6`):

- **Standard mode:** `sessionStorage` key
  `ryco:phone-app-interstitial-dismissed:v1`, value `"1"` — per-tab-session,
  a non-sensitive UI boolean (no tokens, identifiers, or auth material).
- **Hosted mode:** in-memory only (module-level latch), consistent with the
  hosted rule that browser storage stays untouched. Consequence, accepted as
  a deliberate trade-off: each hosted page load (including mobile-browser
  reloads after suspension) re-offers the app once. This doubles as the
  product nudge; if it proves too naggy, extending `sessionStorage` to hosted
  mode is a one-line, owner-approved follow-up.
- Storage access is wrapped: if `sessionStorage` throws (private mode,
  storage disabled), reads report "not dismissed" and writes fall back to the
  in-memory latch.

### Freeze policy (process, recorded here)

From this change forward the responsive phone tier is **feature-frozen**:
bug fixes and gate-keeping only, no new phone-tier features. The acceptance
matrix remains its authoritative regression fence. Removal of the phone tier
is out of scope and requires its own approved design after the native app
reaches parity.

## Testing

Each assertion is proven falsifiable by neutering the production condition
and observing the failure.

**Pure predicate unit tests** (`shouldShowPhoneAppInterstitial`): the full
truth table — flag off, flag on without URL, invalid URL, electron, desktop
tier, dismissed, and the qualifying combination.

**Browser suite** `PhoneGetAppInterstitial.browser.tsx` (phone viewport via
the existing CDP emulation helpers; the `env.ts` readers are mocked because
build-time defines cannot be toggled at test time):

1. Overlay renders above a mounted host surface; the host stays mounted
   (probe element remains in the DOM) and regains focus flow on dismissal.
2. "Continue in browser" removes the overlay; dismissal persists across a
   remount within the session (standard-mode storage path).
3. "Get the app" link carries the configured URL, `target="_blank"`,
   `rel="noreferrer"`.
4. Dialog semantics: `role="dialog"`, `aria-modal`, initial focus inside,
   `Escape` dismisses, touch targets ≥44 px, reduced-motion compliance.
5. Storage-unavailable degradation: dismissal still works in-memory.
6. Hosted-mode path uses the in-memory latch and never touches storage.

**`viteConfig.test.ts` additions** mirroring the hosted-PWA gate tests: the
defines exist, default to `"disabled"`/`""` when env vars are unset, and pass
configured values through the new `createWebViteConfig` parameters.

**Acceptance matrix:** untouched and must pass unmodified. Its sweeps mount
`HostedHubRoot` and phone components directly (never `__root`), so they never
see the overlay, and review confirmed no completeness assertion requires
registering the new suite.

Full public gate set before PR, including `bun run build --filter=@ryco/web`
and three consecutive clean runs of `bun run --cwd apps/web test:browser`
(UI-affecting change).

## Rollout

Merges with both flags unset → no behavior change in every environment.
Turning the interstitial on later means building with
`VITE_RYCO_PHONE_APP_INTERSTITIAL=enabled` and a real
`VITE_RYCO_MOBILE_APP_URL` — a deliberate, separately approved deployment
decision once the native app is installable.

## Out of scope

- Any change to `computeTier()`, the tier override dev tooling, or `data-tier`.
- Any change to the PWA install stack (`src/pwa/`), service worker, hosted
  entry funnel, or hosted lifecycle.
- Phone-tier removal; native app implementation; contracts changes.
