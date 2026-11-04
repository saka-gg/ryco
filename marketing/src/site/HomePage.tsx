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
import { Nav } from "./Nav";
import { ProductFilm } from "./ProductFilm";
import { Toolkit } from "./Toolkit";

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
        <Gallery />
        <Toolkit />
        <Cloud />
        <Download />
        <Faq />
      </main>
      <Finale />
    </div>
  );
}
