import { GitHubIcon } from "@/assets/brands";
/**
 * SiteNav — a cleaner, floating navigation.
 *
 * Three detached pills (logo · links · actions) sit just below the top edge. A
 * lime/glass indicator slides under whichever link you hover and snaps back to
 * the section you're actually in (scroll-spy). A hairline progress bar tracks
 * page scroll, the pills gain weight once you leave the hero, and small screens
 * get an animated menu. All slides are GSAP; they snap (no tween) under
 * prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Menu, X } from "lucide-react";
import { RycoWordmark, RycoMark } from "@/assets/RycoLogo";
import { SITE } from "@/data/content";
import { gsap, prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { ACCENT, focusRing } from "./theme";
import { MagneticButton } from "./MagneticButton";
import { useDownload } from "./useDownload";

const LINKS = [
  { id: "agents", label: "Agents" },
  { id: "showcase", label: "Workspace" },
  { id: "features", label: "Features" },
  { id: "download", label: "Download" },
  { id: "faq", label: "FAQ" },
] as const;

const pillBase = "rounded-full border backdrop-blur-xl transition-colors duration-300";
/* Once you scroll, pills become a self-contained dark glass so the white text
   stays readable over light screenshots passing beneath — each pill darkens
   whatever is behind it, regardless of the page underneath. */
const pillTone = (scrolled: boolean) =>
  scrolled
    ? "border-white/12 bg-[#0b0c0e]/80 shadow-lg shadow-black/20"
    : "border-white/10 bg-white/[0.05]";

export function SiteNav() {
  const navRef = useRef<HTMLElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const progRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState<string>("agents");
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const dl = useDownload();

  /* Slide the indicator under a link element (snap under reduced motion). */
  const slideTo = (id: string | null) => {
    const nav = navRef.current;
    const ind = indRef.current;
    if (!nav || !ind) return;
    const el = id ? nav.querySelector<HTMLElement>(`[data-id="${id}"]`) : null;
    if (!el) return;
    gsap.to(ind, {
      x: el.offsetLeft,
      width: el.offsetWidth,
      autoAlpha: 1,
      duration: prefersReducedMotion() ? 0 : 0.42,
      ease: "power3.out",
      overwrite: true,
    });
  };

  /* Scroll-spy: the section crossing the upper-middle is "active". */
  useEffect(() => {
    const sections = LINKS.map((l) => document.getElementById(l.id)).filter(
      (s): s is HTMLElement => !!s,
    );
    // Cache the latest ratio per section: a callback batch only carries the
    // sections that changed, so picking the max across the full set (not just
    // this batch) keeps the highlight on whatever is genuinely most visible.
    const ratios = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          ratios.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        }
        let topId: string | null = null;
        let topRatio = 0;
        for (const [id, ratio] of ratios) {
          if (ratio > topRatio) {
            topRatio = ratio;
            topId = id;
          }
        }
        if (topId) setActive(topId);
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: [0, 0.25, 0.5] },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  /* Keep the indicator under the active link (when not hovering) + on resize. */
  useEffect(() => {
    slideTo(active);
    const onResize = () => slideTo(active);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* Scroll progress bar + scrolled state (rAF-throttled). */
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? window.scrollY / max : 0;
      if (progRef.current) gsap.set(progRef.current, { scaleX: Math.min(1, Math.max(0, p)) });
      setScrolled(window.scrollY > 8);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      {/* scroll progress hairline */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-white/[0.06]">
        <span
          ref={progRef}
          className="block h-full origin-left scale-x-0"
          style={{ background: ACCENT, boxShadow: `0 0 12px ${ACCENT}` }}
        />
      </span>

      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-3 pt-3 sm:px-6">
        {/* logo */}
        <a
          href="#top"
          aria-label="Ryco home"
          className={cn(
            "group/logo flex items-center gap-2.5 px-4 py-2.5",
            pillBase,
            pillTone(scrolled),
            focusRing,
          )}
        >
          <RycoMark className="size-7 transition-transform duration-500 ease-out group-hover/logo:rotate-[8deg] group-hover/logo:scale-110" />
          <RycoWordmark className="h-[17px] text-white/90 transition-colors duration-300 group-hover/logo:text-white" />
        </a>

        {/* center links */}
        <nav
          ref={navRef}
          aria-label="Primary"
          onMouseLeave={() => slideTo(active)}
          className={cn(
            "relative hidden items-center gap-1 px-2 py-1.5 text-sm text-white/60 md:flex",
            pillBase,
            pillTone(scrolled),
          )}
        >
          {/* sliding indicator */}
          <span
            ref={indRef}
            aria-hidden
            className="absolute inset-y-1.5 left-0 -z-0 rounded-full bg-white/[0.07] opacity-0 ring-1 ring-white/10"
          />
          {LINKS.map((l) => (
            <a
              key={l.id}
              data-id={l.id}
              href={`#${l.id}`}
              onMouseEnter={() => slideTo(l.id)}
              className={cn(
                "relative z-10 rounded-full px-3.5 py-1.5 transition-colors duration-200",
                active === l.id ? "text-white" : "hover:text-white",
              )}
              style={active === l.id ? { color: "#fff" } : undefined}
            >
              {l.label}
            </a>
          ))}
          <Link
            to="/changelog"
            data-id="changelog"
            onMouseEnter={() => slideTo("changelog")}
            className={cn(
              "relative z-10 rounded-full px-3.5 py-1.5 transition-colors hover:text-white",
              focusRing,
            )}
          >
            Changelog
          </Link>
        </nav>

        {/* actions */}
        <div className={cn("flex items-center gap-1.5 p-1.5", pillBase, pillTone(scrolled))}>
          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer"
            aria-label="Ryco on GitHub"
            className={cn(
              "hidden size-9 place-items-center rounded-full text-white/65 transition hover:bg-white/10 hover:text-white sm:grid",
              focusRing,
            )}
          >
            <GitHubIcon className="size-[18px]" />
          </a>
          <MagneticButton
            href={dl.href}
            external={!dl.isDirect}
            size="sm"
            magnetic
            className="rounded-full"
            ariaLabel={
              dl.osLabel
                ? `Download Ryco for ${dl.osLabel}${dl.archLabel ? ` (${dl.archLabel})` : ""}${dl.version ? ` ${dl.version}` : ""}`
                : "Download Ryco"
            }
          >
            <Download className="size-4" />
            <span>
              Download{dl.osLabel && <span className="hidden sm:inline"> for {dl.osLabel}</span>}
            </span>
          </MagneticButton>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className={cn(
              "grid size-9 place-items-center rounded-full text-white/75 transition hover:bg-white/10 hover:text-white md:hidden",
              focusRing,
            )}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {/* mobile menu — `inert` while closed so the collapsed links stay out of
          the tab order and the a11y tree, not just visually hidden. */}
      <div
        inert={!open}
        className={cn(
          "mx-3 mt-2 grid overflow-hidden transition-all duration-300 ease-out md:hidden",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <nav
            aria-label="Mobile"
            className="flex flex-col gap-1 rounded-3xl border border-white/10 bg-[#0a0b0d]/90 p-2 text-sm backdrop-blur-xl"
          >
            {LINKS.map((l) => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={() => setOpen(false)}
                className={cn(
                  "rounded-2xl px-4 py-3 text-white/75 transition hover:bg-white/[0.06] hover:text-white",
                  active === l.id && "bg-white/[0.05] text-white",
                )}
              >
                {l.label}
              </a>
            ))}
            <Link
              to="/changelog"
              onClick={() => setOpen(false)}
              className={cn(
                "rounded-2xl px-4 py-3 text-white/75 transition hover:bg-white/[0.06] hover:text-white",
                focusRing,
              )}
            >
              Changelog
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}
