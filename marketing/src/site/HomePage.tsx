/**
 * The Ryco landing page. Sections are self-contained motion modules; this file
 * only composes them and owns page-level concerns (smooth scroll, grain).
 */
import { usePauseOffscreenLoops, useRefreshAfterFonts, useSmoothScroll } from "@/lib/motion";
import { Agents } from "./Agents";
import { Cloud } from "./Cloud";
import { Download } from "./Download";
import { Faq } from "./Faq";
import { Finale } from "./Finale";
import { Gallery } from "./Gallery";
import { Latest } from "./Latest";
import { Mobile } from "./Mobile";
import { Nav } from "./Nav";
import { ProductFilm } from "./ProductFilm";
import { Toolkit } from "./Toolkit";

/** The "Look closer" capture gallery is hidden for now: the page already
 *  carries the film, the live demos and the phone. Its captures and SHOTS
 *  stay, so flipping this brings it back. */
const SHOW_GALLERY = false;

export default function HomePage() {
  useSmoothScroll();
  usePauseOffscreenLoops();
  useRefreshAfterFonts();
  return (
    <div className="grain relative min-h-[100dvh] bg-canvas text-ink antialiased">
      <Nav />
      <main>
        <ProductFilm />
        <Agents />
        <Latest />
        {SHOW_GALLERY && <Gallery />}
        <Toolkit />
        <Cloud />
        <Mobile />
        <Download />
        <Faq />
      </main>
      <Finale />
    </div>
  );
}
