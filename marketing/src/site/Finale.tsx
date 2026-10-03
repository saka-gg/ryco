/**
 * The close: one statement, two actions, then a footer whose giant wordmark
 * rises letter by letter out of the bottom edge as you arrive.
 */
import { Link } from "react-router-dom";
import { ArrowUpRight, Download, MessagesSquare } from "lucide-react";
import { GitHubIcon } from "@/assets/brands";
import { RycoMark, RycoWordmark } from "@/assets/RycoLogo";
import { SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, scrollToId, useGsap } from "@/lib/motion";
import { Button } from "./ui/Button";
import { revealText } from "./ui/reveal";
import { useDownload } from "./useDownload";
import { focusRing, SECTION_X } from "./theme";

const linkCls = cn("text-[15px] text-ink/60 transition-colors hover:text-ink", focusRing);

export function Finale() {
  const dl = useDownload();

  const scope = useGsap<HTMLDivElement>((root) => {
    revealText(root.querySelector("[data-finale-title]")!, {
      by: "words",
      widen: true,
      stagger: 0.06,
    });
    gsap.from(root.querySelectorAll("[data-finale-cta]"), {
      autoAlpha: 0,
      y: 24,
      stagger: 0.08,
      scrollTrigger: {
        trigger: root.querySelector("[data-finale-title]"),
        start: "top 70%",
        once: true,
      },
    });
    gsap.from(root.querySelectorAll<SVGPathElement>("[data-wordmark] path"), {
      /* resolved once at creation (one getBBox per glyph); yPercent on SVG
         would re-measure the box on every scrubbed frame */
      y: (_: number, el: SVGPathElement) => el.getBBox().height * 1.05,
      stagger: 0.09,
      ease: "none",
      scrollTrigger: {
        trigger: root.querySelector("[data-wordmark]"),
        start: "top bottom",
        end: "bottom 101%",
        scrub: 1,
      },
    });
  });

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    scrollToId(id);
  };

  return (
    <div ref={scope}>
      <section
        aria-labelledby="finale-title"
        className={cn(SECTION_X, "py-32 text-center sm:py-44")}
      >
        <h2
          id="finale-title"
          data-finale-title
          className="mx-auto max-w-[14ch] font-display text-[clamp(2.8rem,8vw,7.6rem)] font-bold leading-[0.92] tracking-[-0.045em]"
        >
          Bring your agents. Keep your code<span className="text-accent">.</span>
        </h2>
        <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
          <span data-finale-cta>
            <Button
              href={dl.href}
              external={!dl.isDirect}
              icon={<Download />}
              ariaLabel={dl.osLabel ? `Download Ryco for ${dl.osLabel}` : "Download Ryco"}
            >
              {dl.osLabel ? `Download for ${dl.osLabel}` : "Download Ryco"}
            </Button>
          </span>
          <span data-finale-cta>
            <Button href={SITE.discord} external variant="ghost" icon={<MessagesSquare />}>
              Join the Discord
            </Button>
          </span>
        </div>
      </section>

      <footer className="relative overflow-hidden border-t border-white/10 pt-16">
        <div
          className={cn(
            SECTION_X,
            "grid gap-12 md:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,0.6fr))]",
          )}
        >
          <div className="max-w-[40ch]">
            <RycoMark className="h-6 text-ink" />
            <p className="mt-5 text-[15px] leading-relaxed text-ink/55">{SITE.longDescription}</p>
          </div>
          <nav aria-label="Product" className="flex flex-col gap-3">
            <span className="mb-1 text-[13px] font-medium text-ink/40">Product</span>
            <a href="#agents" onClick={go("agents")} className={linkCls}>
              Agents
            </a>
            <a href="#cloud" onClick={go("cloud")} className={linkCls}>
              Cloud
            </a>
            <a href="#download" onClick={go("download")} className={linkCls}>
              Download
            </a>
            <Link to="/changelog" className={linkCls}>
              Changelog
            </Link>
          </nav>
          <nav aria-label="Community" className="flex flex-col gap-3">
            <span className="mb-1 text-[13px] font-medium text-ink/40">Community</span>
            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer"
              className={cn(linkCls, "inline-flex items-center gap-2")}
            >
              <GitHubIcon className="size-4" /> GitHub
            </a>
            <a href={SITE.discord} target="_blank" rel="noreferrer" className={linkCls}>
              Discord
            </a>
            <a href={SITE.releases} target="_blank" rel="noreferrer" className={linkCls}>
              Releases
            </a>
            <a href={SITE.cloud} target="_blank" rel="noreferrer" className={linkCls}>
              {SITE.cloudHost}
            </a>
          </nav>
        </div>

        <div
          className={cn(
            SECTION_X,
            "mt-16 flex flex-col gap-3 text-[13px] text-ink/45 sm:flex-row sm:items-center sm:justify-between",
          )}
        >
          <p>
            {SITE.license} licensed. © {SITE.company}
          </p>
          <p>
            Built by{" "}
            <a
              href={SITE.maintainer.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "group/by inline-flex items-center gap-0.5 font-medium text-ink/75 hover:text-accent",
                focusRing,
              )}
            >
              {SITE.maintainer.name}
              <ArrowUpRight className="size-3 transition-transform duration-300 group-hover/by:-translate-y-0.5 group-hover/by:translate-x-0.5" />
            </a>
          </p>
        </div>

        <div aria-hidden className={cn(SECTION_X, "mt-10")}>
          <RycoWordmark
            data-wordmark
            className="block w-full text-ink"
            role="presentation"
            aria-label={undefined}
          />
        </div>
      </footer>
    </div>
  );
}
