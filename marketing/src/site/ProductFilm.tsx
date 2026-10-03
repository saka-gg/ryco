/**
 * Hero + the pinned product film. They are one choreography: the kinetic
 * headline lands, the app window rises tilted below it, flattens as you scroll,
 * then pins while the film plays a complete Ryco run, chapter by chapter.
 */
import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { getLenis, gsap, ScrollTrigger, SplitText, useGsap, useReducedMotion } from "@/lib/motion";
import { NARROW_CROP, Stage } from "./stage/Stage";
import { NARROW_QUERY, useMediaQuery } from "@/lib/useMediaQuery";
import { buildFilm, CHAPTER_AT, CHAPTERS } from "./stage/film";
import { Button } from "./ui/Button";
import { CopyCommand } from "./ui/CopyCommand";
import { useDownload } from "./useDownload";
import { focusRing, SECTION_X } from "./theme";

const STARTS = CHAPTERS.map((c) => CHAPTER_AT[c.id]);
const ENDS = [...STARTS.slice(1), CHAPTER_AT.end];

/** Archivo width range the hero letters breathe within under the pointer. */
const WDTH_REST = 100;
const WDTH_PEAK = 122;

export function ProductFilm() {
  const reduced = useReducedMotion();
  const narrow = useMediaQuery(NARROW_QUERY);
  const dl = useDownload();
  const [chapter, setChapter] = useState(0);
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  const filmTrigger = useRef<ScrollTrigger | null>(null);

  const scope = useGsap<HTMLDivElement>((root) => {
    const h1 = root.querySelector<HTMLElement>("[data-hero-title]")!;
    const pin = root.querySelector<HTMLElement>("[data-film-pin]")!;
    const lift = root.querySelector<HTMLElement>("[data-stage-lift]")!;
    const stage = root.querySelector<HTMLElement>('[data-s="stage"]')!;

    /* ---------------------------- hero entrance ---------------------------- */
    const split = SplitText.create(h1, {
      type: "lines,chars",
      mask: "lines",
      linesClass: "split-line",
    });
    const chars = split.chars as HTMLElement[];
    const intro = gsap.timeline({ paused: true });
    intro
      .from(chars, {
        yPercent: 120,
        fontVariationSettings: "'wdth' 62",
        duration: 1.25,
        stagger: 0.022,
        ease: "ryco",
      })
      .from(
        "[data-hero-dot]",
        { scale: 0, duration: 0.7, stagger: 0.12, ease: "back.out(3)" },
        0.75,
      )
      .from("[data-hero-fade]", { autoAlpha: 0, y: 22, duration: 1, stagger: 0.08 }, 0.55)
      .from(lift, { y: 140, autoAlpha: 0, duration: 1.6, ease: "ryco" }, 0.45);

    /* Hold the entrance (letters wait hidden under their masks) until the web
       fonts and the load-time ScrollTrigger refresh have landed: each costs a
       long frame, and landing mid-entrance made the first letters visibly
       skip. Capped, so a slow network still gets its motion. */
    let started = false;
    const play = () => {
      if (started) return;
      started = true;
      requestAnimationFrame(() => requestAnimationFrame(() => intro.play()));
    };
    const loaded =
      document.readyState === "complete"
        ? Promise.resolve()
        : new Promise<void>((r) => window.addEventListener("load", () => r(), { once: true }));
    void Promise.all([document.fonts?.ready, loaded]).then(play);
    const cap = window.setTimeout(play, 1200);

    /* Pointer-reactive width: letters near the cursor stretch, pushing their
       neighbours along the line like a living word. */
    let rects: Array<{ x: number; y: number }> = [];
    const measure = () => {
      rects = chars.map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    };
    const setters = chars.map((c) => {
      const proxy = { w: WDTH_REST };
      const to = gsap.quickTo(proxy, "w", {
        duration: 0.6,
        ease: "power3",
        onUpdate: () => {
          c.style.fontVariationSettings = `'wdth' ${proxy.w.toFixed(1)}`;
        },
      });
      return to;
    });
    const fine = window.matchMedia("(pointer: fine)").matches;
    const onMove = (e: PointerEvent) => {
      if (!rects.length) measure();
      rects.forEach((r, i) => {
        const d = Math.hypot(e.clientX - r.x, (e.clientY - r.y) * 1.6);
        const k = Math.max(0, 1 - d / 260);
        setters[i](WDTH_REST + (WDTH_PEAK - WDTH_REST) * k * k);
      });
    };
    const onLeave = () => setters.forEach((s) => s(WDTH_REST));
    if (fine) {
      intro.eventCallback("onComplete", () => {
        h1.addEventListener("pointerenter", measure);
        h1.addEventListener("pointermove", onMove);
        h1.addEventListener("pointerleave", onLeave);
      });
    }

    /* Headline drifts up and dims as the window takes over. */
    gsap.to("[data-hero-copy]", {
      yPercent: -18,
      autoAlpha: 0.15,
      ease: "none",
      scrollTrigger: {
        trigger: "[data-hero-section]",
        start: "top top",
        end: "bottom 15%",
        scrub: true,
      },
    });

    /* --------------------------------- film -------------------------------- */
    const mm = gsap.matchMedia();
    mm.add({ narrow: "(max-width: 767px)", wide: "(min-width: 768px)" }, (ctx) => {
      const narrow = !!ctx.conditions?.narrow;

      /* The window lies back, then flattens as it reaches the top. */
      gsap.fromTo(
        stage,
        { rotateX: narrow ? 14 : 26, scale: narrow ? 0.94 : 0.86, transformOrigin: "50% 0%" },
        {
          rotateX: 0,
          scale: 1,
          ease: "none",
          scrollTrigger: { trigger: pin, start: "top bottom", end: "top top", scrub: true },
        },
      );

      const film = buildFilm(stage, { narrow });
      const total = film.duration();
      let current = -1;
      filmTrigger.current = ScrollTrigger.create({
        trigger: pin,
        start: "top top",
        end: () => `+=${window.innerHeight * (narrow ? 4.4 : 5.4)}`,
        pin: true,
        scrub: 0.75,
        animation: film,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const t = self.progress * total;
          let idx = 0;
          STARTS.forEach((s, i) => {
            if (t >= s - 0.01) idx = i;
          });
          /* React only hears about chapter changes, not every frame */
          if (idx !== current) {
            current = idx;
            setChapter(idx);
          }
          bars.current.forEach((bar, i) => {
            if (!bar) return;
            const k = gsap.utils.clamp(0, 1, (t - STARTS[i]) / (ENDS[i] - STARTS[i]));
            bar.style.transform = `scaleX(${k})`;
          });
        },
      });
      return () => {
        filmTrigger.current = null;
      };
    });

    return () => {
      started = true;
      window.clearTimeout(cap);
      h1.removeEventListener("pointerenter", measure);
      h1.removeEventListener("pointermove", onMove);
      h1.removeEventListener("pointerleave", onLeave);
      mm.revert();
    };
  });

  /* The window is as large as the pinned frame allows next to the chapter rail. */
  const stageMax = reduced
    ? 1180
    : narrow
      ? `min(calc(100vw - 32px), calc((100svh - 250px) * ${NARROW_CROP.w / 800}))`
      : "min(1180px, calc((100svh - 190px) * 1.6), calc(100vw - 32px))";

  /* Clicking a chapter scrolls the film to it. */
  const jump = (i: number) => {
    const st = filmTrigger.current;
    if (!st) return;
    const at = st.start + (st.end - st.start) * ((STARTS[i] + 0.05) / CHAPTER_AT.end);
    const lenis = getLenis();
    if (lenis) lenis.scrollTo(at, { duration: 1.4 });
    else window.scrollTo({ top: at, behavior: "smooth" });
  };

  return (
    <div ref={scope} id="top">
      {/* --------------------------------- hero -------------------------------- */}
      <section data-hero-section className={cn(SECTION_X, "relative pt-28 sm:pt-32")}>
        <div data-hero-copy>
          <h1
            data-hero-title
            className="font-display text-[clamp(3.1rem,10.2vw,10.4rem)] font-[760] leading-[0.9] tracking-[-0.045em] text-ink"
          >
            <span className="block whitespace-nowrap">
              Every agent
              <span data-hero-dot className="inline-block text-accent">
                .
              </span>
            </span>
            <span className="block whitespace-nowrap">
              One workspace
              <span data-hero-dot className="inline-block text-accent">
                .
              </span>
            </span>
          </h1>

          <div className="mt-8 grid gap-7 md:mt-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <p
              data-hero-fade
              className="max-w-[34ch] text-pretty text-[17px] leading-relaxed text-ink/65 sm:text-[19px]"
            >
              {SITE.oneLiner}
            </p>
            <div data-hero-fade className="flex flex-wrap items-center gap-3">
              <Button
                href={dl.href}
                external={!dl.isDirect}
                icon={<Download />}
                ariaLabel={dl.osLabel ? `Download Ryco for ${dl.osLabel}` : "Download Ryco"}
              >
                {dl.osLabel ? `Download for ${dl.osLabel}` : "Download Ryco"}
              </Button>
              <CopyCommand command={SITE.npx} />
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------- film --------------------------------- */}
      <section id="product" aria-label="Ryco in motion" className="relative mt-10 sm:mt-14">
        {/* one soft ember wash behind the product, nothing more */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-[8%] -z-10 mx-auto h-[70vh] max-w-[1200px] opacity-60"
          style={{
            background:
              "radial-gradient(closest-side, rgba(255,92,40,0.13), rgba(255,92,40,0.04) 55%, transparent)",
          }}
        />
        <div
          data-film-pin
          className={cn(
            "flex flex-col items-center px-4",
            reduced ? "gap-10 pb-10" : "h-[100svh] justify-center gap-6 sm:gap-7",
          )}
          style={{ perspective: "1600px" }}
        >
          <div data-stage-lift className="w-full" style={{ maxWidth: stageMax }}>
            <Stage
              crop={narrow ? NARROW_CROP : undefined}
              className="shadow-[0_60px_140px_-40px_rgba(0,0,0,0.95)]"
            />
          </div>

          {/* chapter rail */}
          <div className="w-full" style={{ maxWidth: stageMax }}>
            {/* wide: all five; narrow: the active one */}
            <ol className="hidden grid-cols-5 gap-6 md:grid">
              {CHAPTERS.map((c, i) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => jump(i)}
                    disabled={reduced}
                    className={cn(
                      "group/ch block w-full text-left transition-opacity duration-500",
                      reduced || i === chapter ? "opacity-100" : "opacity-40 hover:opacity-75",
                      focusRing,
                    )}
                  >
                    <span className="block h-px overflow-hidden bg-white/15">
                      <span
                        ref={(el) => {
                          bars.current[i] = el;
                        }}
                        className="block h-full origin-left bg-accent will-change-transform"
                        style={{ transform: reduced ? "scaleX(1)" : "scaleX(0)" }}
                      />
                    </span>
                    <span className="mt-3 block font-display text-[15px] font-semibold tracking-[-0.01em] text-ink">
                      {c.title}
                    </span>
                    <span className="mt-1 block text-[13px] leading-snug text-ink/55">
                      {c.line}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {reduced ? (
              <ol className="grid gap-4 md:hidden">
                {CHAPTERS.map((c) => (
                  <li key={c.id}>
                    <p className="font-display text-[17px] font-semibold text-ink">{c.title}</p>
                    <p className="text-[14px] text-ink/60">{c.line}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="md:hidden" aria-live="polite">
                <div className="flex gap-1.5">
                  {CHAPTERS.map((c, i) => (
                    <span
                      key={c.id}
                      className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/15"
                    >
                      <span
                        className="block h-full origin-left bg-accent transition-transform duration-300"
                        style={{
                          transform: `scaleX(${i < chapter ? 1 : i === chapter ? 0.5 : 0})`,
                        }}
                      />
                    </span>
                  ))}
                </div>
                <p className="mt-4 font-display text-[26px] font-bold tracking-[-0.02em] text-ink">
                  {CHAPTERS[chapter].title}
                  <span className="text-accent">.</span>
                </p>
                <p className="mt-1 text-[15px] leading-snug text-ink/60">
                  {CHAPTERS[chapter].line}
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
