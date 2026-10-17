/**
 * Download. The detected platform leads the list; each row floods on hover.
 * A terminal types the two commands that matter (try it, or serve it to
 * Cloud) once it scrolls into view, and prints instantly under reduced motion.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight } from "lucide-react";
import { BrandIcon } from "@/assets/brands";
import { CLOUD, PLATFORMS, SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { prefersReducedMotion, useGsap } from "@/lib/motion";
import { revealText, revealUp } from "./ui/reveal";
import { useDownload } from "./useDownload";
import { focusRing, SECTION_X } from "./theme";

type Tok = { t: string; tone?: "accent" | "muted" };
const LINES: Tok[][] = [
  [{ t: "# try it without installing", tone: "muted" }],
  [{ t: "$ ", tone: "accent" }, { t: SITE.npx }],
  [],
  [{ t: "# or reach this machine from anywhere", tone: "muted" }],
  [{ t: "$ ", tone: "accent" }, { t: CLOUD.serve }],
  [{ t: "$ ", tone: "accent" }, { t: CLOUD.link }],
];
const lineLen = (i: number) => LINES[i].reduce((n, tok) => n + tok.t.length, 0);

function TypingTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ line: -1, char: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setPos({ line: LINES.length - 1, char: lineLen(LINES.length - 1) });
      return;
    }
    let timer = 0;
    let cur = { line: 0, char: 0 };
    const step = () => {
      if (cur.char < lineLen(cur.line)) cur = { line: cur.line, char: cur.char + 1 };
      else if (cur.line + 1 < LINES.length) cur = { line: cur.line + 1, char: 0 };
      else return;
      setPos(cur);
      timer = window.setTimeout(step, cur.char === 0 ? 220 : 18 + Math.random() * 40);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setPos(cur);
        timer = window.setTimeout(step, 350);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0c0c0d] font-mono text-[13px]">
      <div className="flex h-9 items-center gap-1.5 border-b border-white/[0.07] px-4">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="ml-2 text-[11.5px] text-ink/55">zsh</span>
      </div>
      <div ref={ref} aria-hidden className="min-h-[180px] px-5 py-4 leading-[1.75]">
        {LINES.map((line, i) => {
          if (i > pos.line) return null;
          let budget = i === pos.line ? pos.char : Infinity;
          return (
            <div key={i} className="min-h-[1.75em] whitespace-pre-wrap break-all">
              {line.map((tok, k) => {
                if (budget <= 0) return null;
                const text = tok.t.slice(0, budget);
                budget -= tok.t.length;
                return (
                  <span
                    key={k}
                    className={
                      tok.tone === "accent"
                        ? "text-accent"
                        : tok.tone === "muted"
                          ? "text-ink/55"
                          : "text-ink/85"
                    }
                  >
                    {text}
                  </span>
                );
              })}
              {i === pos.line && <span className="ry-block-caret ml-0.5 text-ink/60" />}
            </div>
          );
        })}
      </div>
      <pre className="sr-only">{LINES.map((l) => l.map((t) => t.t).join("")).join("\n")}</pre>
    </div>
  );
}

export function Download() {
  const dl = useDownload();
  const urlFor = (id: string) =>
    id === "macos"
      ? dl.urls?.mac
      : id === "windows"
        ? dl.urls?.win
        : id === "linux"
          ? dl.urls?.linux
          : null;
  const detected = dl.os === "mac" ? "macos" : dl.os;
  const platforms = [...PLATFORMS].sort(
    (a, b) => Number(b.id === detected) - Number(a.id === detected),
  );

  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-dl-title]")!, { by: "chars", widen: true, stagger: 0.04 });
    revealText(root.querySelector("[data-dl-sub]")!, { delay: 0.15 });
    revealUp(root.querySelectorAll("[data-platform]"), root.querySelector("[data-platforms]")!, {
      stagger: 0.1,
      y: 40,
    });
    revealUp(root.querySelector("[data-term]")!, root.querySelector("[data-term]")!, { y: 40 });
  });

  return (
    <section
      ref={scope}
      id="download"
      aria-labelledby="dl-title"
      className="relative py-28 sm:py-32"
    >
      <div
        className={cn(
          SECTION_X,
          "grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20",
        )}
      >
        <div>
          <h2
            id="dl-title"
            data-dl-title
            className="font-display text-[clamp(3.6rem,11vw,10rem)] font-bold leading-[0.88] tracking-[-0.05em]"
          >
            Get Ryco<span className="text-accent">.</span>
          </h2>
          <p data-dl-sub className="mt-6 max-w-[42ch] text-[17px] leading-relaxed text-ink/60">
            Native builds for macOS, Linux and Windows, or run it straight from npm. Free and{" "}
            {SITE.license} licensed.
          </p>
          <div data-term data-loops className="mt-10">
            <TypingTerminal />
          </div>
        </div>

        <div className="lg:pt-6">
          <ul data-platforms>
            {platforms.map((pl) => {
              const url = urlFor(pl.id);
              const isDetected = pl.id === detected;
              return (
                <li key={pl.id} data-platform>
                  <a
                    href={url ?? SITE.releases}
                    {...(url ? {} : { target: "_blank", rel: "noreferrer" })}
                    className={cn(
                      "group/pl relative flex items-center gap-5 overflow-hidden border-t border-white/12 py-7 pr-2",
                      focusRing,
                    )}
                  >
                    <span
                      aria-hidden
                      className="absolute inset-0 origin-left scale-x-0 bg-gradient-to-r from-accent/[0.12] to-transparent transition-transform duration-700 ease-ryco group-hover/pl:scale-x-100"
                    />
                    <span className="relative grid size-14 shrink-0 place-items-center rounded-2xl bg-white/[0.04] text-ink ring-1 ring-inset ring-white/[0.08]">
                      <BrandIcon name={pl.brand} className="size-6" />
                    </span>
                    <span className="relative min-w-0 flex-1">
                      <span className="flex items-center gap-3">
                        <span className="font-display text-[clamp(1.5rem,3vw,2.2rem)] font-semibold tracking-[-0.025em] text-ink">
                          {pl.name}
                        </span>
                        {isDetected && (
                          <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[11.5px] font-medium text-accent">
                            Your system
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block font-mono text-[12.5px] text-ink/55">
                        {pl.format} · {pl.arch}
                      </span>
                      <span className="mt-1 block text-[14px] text-ink/55">{pl.install}</span>
                    </span>
                    <span className="relative grid size-12 shrink-0 place-items-center rounded-full border border-white/15 text-ink transition-colors duration-500 group-hover/pl:border-accent group-hover/pl:bg-accent group-hover/pl:text-accent-ink">
                      {url ? (
                        <ArrowDown className="size-5 transition-transform duration-500 ease-ryco group-hover/pl:translate-y-0.5" />
                      ) : (
                        <ArrowUpRight className="size-5 transition-transform duration-500 ease-ryco group-hover/pl:-translate-y-0.5 group-hover/pl:translate-x-0.5" />
                      )}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-white/12 pt-6 text-[14px] leading-snug text-ink/50">
            {dl.version && <span className="font-mono text-ink/70">{dl.version}. </span>}
            macOS builds are not notarized yet; the DMG ships an installer script that handles
            Gatekeeper.{" "}
            <a
              href={dl.releasesUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "whitespace-nowrap text-ink/80 underline-offset-4 hover:text-ink hover:underline",
                focusRing,
              )}
            >
              All builds and checksums
              <ArrowUpRight className="ml-0.5 inline size-3.5 align-[-0.15em]" />
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
