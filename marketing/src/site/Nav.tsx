/**
 * Floating navigation. A single glass bar that tucks away while you scroll
 * down and slides back on the way up, with a hairline scroll-progress rule in
 * the accent and a scroll-spy that tracks the section you're reading.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Menu, X } from "lucide-react";
import { GitHubIcon } from "@/assets/brands";
import { RycoMark, RycoWordmark } from "@/assets/RycoLogo";
import { SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, prefersReducedMotion, ScrollTrigger, scrollToId } from "@/lib/motion";
import { Button } from "./ui/Button";
import { useDownload } from "./useDownload";
import { focusRing } from "./theme";

export const NAV_LINKS = [
  { id: "product", label: "Product" },
  { id: "agents", label: "Agents" },
  { id: "cloud", label: "Cloud" },
  { id: "download", label: "Download" },
  { id: "faq", label: "FAQ" },
] as const;

export function Nav() {
  const bar = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const dl = useDownload();

  useEffect(() => {
    const reduce = prefersReducedMotion();
    /* a context, so StrictMode's mount/unmount/mount reverts the entrance
       instead of tweening "from" an already-hidden state */
    const ctx = gsap.context(() => {
      if (!reduce && bar.current) {
        gsap.from(bar.current, {
          yPercent: -140,
          autoAlpha: 0,
          duration: 1.2,
          delay: 0.6,
          ease: "ryco",
        });
      }
    });
    /* hide on scroll down, reveal on scroll up; progress hairline. The bar
       only tweens when its state flips, never once per scroll frame. */
    let hidden = false;
    const setHidden = (hide: boolean) => {
      if (hide === hidden || !bar.current) return;
      hidden = hide;
      gsap.to(bar.current, {
        yPercent: hide ? -150 : 0,
        duration: 0.5,
        ease: "ryco",
        overwrite: "auto",
      });
    };
    const st = ScrollTrigger.create({
      start: 0,
      end: "max",
      onUpdate: (self) => {
        if (progress.current) progress.current.style.transform = `scaleX(${self.progress})`;
        if (reduce || !bar.current) return;
        /* never tuck away while keyboard focus is inside the bar */
        if (bar.current.contains(document.activeElement)) return setHidden(false);
        setHidden(self.direction === 1 && self.scroll() > 240);
      },
    });
    const onFocusIn = () => setHidden(false);
    const barEl = bar.current;
    barEl?.addEventListener("focusin", onFocusIn);
    /* scroll-spy */
    const spies = NAV_LINKS.filter((l) => document.getElementById(l.id)).map((l) =>
      ScrollTrigger.create({
        trigger: `#${l.id}`,
        start: "top 45%",
        end: "bottom 45%",
        onToggle: (self) => {
          if (self.isActive) setActive(l.id);
        },
      }),
    );
    return () => {
      barEl?.removeEventListener("focusin", onFocusIn);
      ctx.revert();
      st.kill();
      spies.forEach((s) => s.kill());
    };
  }, []);

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setOpen(false);
    scrollToId(id);
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5">
      <div
        ref={bar}
        className="relative mx-auto max-w-[1360px] rounded-[18px] border border-white/[0.08] bg-[#0c0c0d]/70 backdrop-blur-xl backdrop-saturate-150"
      >
        <div className="flex h-[52px] items-center gap-3 pl-4 pr-1.5">
          <a
            href="#top"
            onClick={go("top")}
            aria-label="Ryco home"
            className={cn("flex items-center gap-2", focusRing)}
          >
            <RycoMark className="h-[18px] text-ink" />
            <RycoWordmark className="h-[15px] translate-y-[3px] text-ink" />
          </a>

          <nav
            aria-label="Primary"
            className="mx-auto hidden items-center gap-0.5 text-[14px] lg:flex"
          >
            {NAV_LINKS.map((l) => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={go(l.id)}
                className={cn(
                  "relative rounded-full px-3.5 py-1.5 transition-colors duration-300",
                  active === l.id ? "text-ink" : "text-ink/55 hover:text-ink",
                  focusRing,
                )}
              >
                {l.label}
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3.5 -bottom-px h-px origin-left bg-accent transition-transform duration-500 ease-ryco",
                    active === l.id ? "scale-x-100" : "scale-x-0",
                  )}
                />
              </a>
            ))}
            <Link
              to="/changelog"
              className={cn(
                "rounded-full px-3.5 py-1.5 text-ink/55 transition-colors hover:text-ink",
                focusRing,
              )}
            >
              Changelog
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-1 lg:ml-0">
            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer"
              aria-label="Ryco on GitHub"
              className={cn(
                "hidden size-9 place-items-center rounded-full text-ink/60 transition hover:bg-white/[0.06] hover:text-ink sm:grid",
                focusRing,
              )}
            >
              <GitHubIcon className="size-[18px]" />
            </a>
            <Button
              href={dl.href}
              external={!dl.isDirect}
              size="sm"
              magnetic={false}
              icon={<Download />}
              ariaLabel={dl.osLabel ? `Download Ryco for ${dl.osLabel}` : "Download Ryco"}
            >
              Download
            </Button>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              className={cn(
                "grid size-9 place-items-center rounded-full text-ink/75 transition hover:bg-white/[0.06] lg:hidden",
                focusRing,
              )}
            >
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        <div
          inert={!open}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-500 ease-ryco lg:hidden",
            open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            {/* scrolls on short screens (landscape phones) instead of clipping */}
            <nav
              aria-label="Mobile"
              className="flex max-h-[calc(100svh-5rem)] flex-col overflow-y-auto overscroll-contain px-2 pb-2"
            >
              {NAV_LINKS.map((l) => (
                <a
                  key={l.id}
                  href={`#${l.id}`}
                  onClick={go(l.id)}
                  className="rounded-xl px-3 py-3 font-display text-[22px] font-semibold tracking-[-0.02em] text-ink/85 hover:bg-white/[0.05]"
                >
                  {l.label}
                </a>
              ))}
              <Link
                to="/changelog"
                className="rounded-xl px-3 py-3 font-display text-[22px] font-semibold tracking-[-0.02em] text-ink/85 hover:bg-white/[0.05]"
              >
                Changelog
              </Link>
            </nav>
          </div>
        </div>

        <span aria-hidden className="absolute inset-x-5 bottom-0 h-px overflow-hidden">
          <span
            ref={progress}
            className="block h-full origin-left scale-x-0 bg-accent/80 will-change-transform"
          />
        </span>
      </div>
    </header>
  );
}
