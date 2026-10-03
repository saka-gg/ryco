# Ryco marketing site

The landing page (`/`) and changelog (`/changelog`) for Ryco. It is a motion-led
product site: the centrepiece is a coded, faithful replica of the Ryco desktop
window that plays a complete agent run as you scroll, next to real product
captures and a section for Ryco Cloud (the hosted Hub at app.ryco.space).

## Stack

- React 19, react-router-dom, Tailwind v4 (`@tailwindcss/vite`), Vite, TypeScript strict
- GSAP 3.15 with ScrollTrigger, SplitText, DrawSVG, ScrambleText and CustomEase
  (all plugins ship in the public `gsap` package)
- Lenis smooth scroll, driven from the GSAP ticker so ScrollTrigger never lags it
- Fonts: Archivo (variable width + weight, animated), DM Sans (the app's own UI
  face), Geist Mono

It lives outside the monorepo workspace globs on purpose, so its dependency tree
never disturbs the pinned Effect/Bun catalog used by `apps/web`.

## Art direction

- One dark canvas (`--color-canvas`), one accent: "ignition" orange `#ff5c28`
  (`--color-accent`, `ACCENT` in `src/site/theme.ts`). Dark text on accent fills.
- Headlines end in an accent period; that is the only decorative device.
- Motion uses the app's own house curve (`cubic-bezier(0.16, 1, 0.3, 1)`,
  registered as the GSAP ease `"ryco"`), so the site and product move alike.

## Structure

```
src/
  data/content.ts        copy and product facts (providers, platforms, shots, Cloud, FAQ)
  lib/motion.ts          GSAP registration, eases, useGsap(), Lenis, reduced-motion hook
  lib/useMediaQuery.ts   shared narrow-screen query
  site/HomePage.tsx      composes the sections below
  site/ProductFilm.tsx   kinetic hero + pinned product film with chapter rail
  site/stage/            the coded app replica
    Stage.tsx            1280x800 design canvas, scaled (and cropped on phones)
    film.ts              the scroll-scrubbed timeline: Ask, Work, Parallel, Review, Run
    script.ts            the screenplay (prompt, tool rows, diff, terminal, six panes)
  site/Agents.tsx        provider roster with width-axis hover + trailing preview
  site/Gallery.tsx       real captures, pinned horizontal pan
  site/Toolkit.tsx       five live micro-demos (worktrees, ⌘K, # issues, themes, traces)
  site/Cloud.tsx         Ryco Cloud relay diagram
  site/Download.tsx      OS-detected platforms + typing terminal
  site/Faq.tsx, Finale.tsx, Nav.tsx, ui/
  pages/ChangelogPage.tsx
```

### The Stage and the film

`Stage.tsx` renders the _settled_ composition (finished conversation, review
panel open). That is exactly what shows under `prefers-reduced-motion`. With
motion on, `film.ts` rewinds it to an empty thread with explicit `gsap.set`s and
builds the run from `.to()` tweens only, so scrubbing backwards is exact. Text is
typed by writing slices into React's existing text nodes. Animation targets are
tagged `data-s="…"`. Because the canvas has fixed coordinates, the camera
(`data-s="cam"`) and the scripted cursor can be choreographed precisely; phones
use `NARROW_CROP` to frame the chat column and the camera pans to panels.

## Develop

```bash
cd marketing
bun install
bun run dev        # http://localhost:5174
```

## Build and checks

```bash
bunx tsc --noEmit && bunx vite build
node scripts/errcheck.mjs   # loads / and /changelog with motion on, reports console errors
MOTION=off node scripts/shoot.mjs   # settled (reduced-motion) captures into screenshots/
```

## Real product screenshots

`public/shots/` holds real captures of the running app (dark mode, account
identities blurred). The gallery serves the `.webp` versions; the `.png` files
are the source captures. To regenerate them, boot the server with this repo as a
project and drive it with `scripts/app-shots.mjs`:

```bash
# from the repo root
bunx turbo run build --filter=ryco-cli
RYCO_HOME=/tmp/ryco-shots RYCO_PORT=13773 RYCO_HOST=127.0.0.1 RYCO_MODE=web \
  RYCO_NO_BROWSER=1 RYCO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=1 \
  node apps/server/dist/bin.mjs            # prints a one-time /pair#token=… URL

cd marketing
RYCO_TOKEN=<token> node scripts/app-shots.mjs   # → marketing/app-screenshots/
```
