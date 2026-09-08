import { GitHubIcon } from "@/assets/brands";
/**
 * Version 4 — "Kinetic" (motion-led art direction).
 *
 * An awwwards-style, scroll-driven showcase where motion *is* the headline
 * feature: a cinematic hero reveal, a pinned horizontal agent gallery, a sticky
 * scrollytelling sequence that swaps the real product screenshots as the copy
 * changes, a kinetic marquee, parallax depth and a drawn-on timeline.
 *
 * Refined dark canvas (charcoal #0a0b0d), high-contrast white type and ONE
 * confident accent — electric lime #c6ff3a — used sparingly for kinetic
 * punctuation. Everything is transforms/opacity only and degrades to a clean,
 * fully-visible STATIC stacked layout under prefers-reduced-motion: pinned and
 * horizontal sections are simply never constructed, so there is never a blank
 * pinned frame.
 */
import { useEffect, useRef, useState } from "react";
import {
  Zap,
  ShieldCheck,
  Eye,
  Download,
  ArrowRight,
  ArrowUpRight,
  Copy,
  Check,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import {
  SITE,
  PROVIDERS,
  MODEL_PROVIDERS,
  PLATFORMS,
  FEATURE_GROUPS,
  STATS,
  PILLARS,
  STEPS,
  FAQ,
} from "@/data/content";
import { BrandIcon } from "@/assets/brands";
import { RycoWordmark, RycoMark } from "@/assets/RycoLogo";
import { ScreenshotFrame } from "@/components/shared/ScreenshotFrame";
import { useGsapContext, useTilt, prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { STEP_ICONS } from "./process-icons";
import { FEATURE_ICONS } from "./feature-icons";
import { ACCENT, focusRing } from "./theme";
import { ProviderCard } from "./ProviderCard";
import { MagneticButton } from "./MagneticButton";
import { SiteNav } from "./SiteNav";
import { AgentDeck } from "./AgentDeck";
import { Gallery } from "./Gallery";
import { useDownload } from "./useDownload";

const NAV_OFFSET = "scroll-mt-28";

/* Pillars are the only section still using lucide glyphs. */
const ICONS: Record<string, LucideIcon> = {
  Zap,
  ShieldCheck,
  Eye,
};

/* Example named provider instances — Ryco runs several of the same agent at once. */
const INSTANCE_EXAMPLES = [
  "codex_personal",
  "claude_openrouter",
  "copilot_work",
  "opencode_self",
  "cursor_ea",
];

const MARQUEE_ITEMS = [
  "Worktrees",
  "Diff → editor",
  "Multi-terminal",
  "Command palette",
  "Named instances",
  "MCP servers",
  "Remote environments",
  "Custom themes",
  "Rebindable keys",
  "Observability",
];

interface ShowcaseStep {
  shot: string;
  title: string;
  alt: string;
  eyebrow: string;
  heading: string;
  body: string;
  points: string[];
  /** Native width ÷ height of the capture, so the frame hugs it (no letterbox). */
  aspect: number;
}

const SHOWCASE: ShowcaseStep[] = [
  {
    shot: "/shots/model-picker.png",
    title: "Model picker",
    alt: "Ryco model picker listing Fable, Opus, Sonnet and Haiku models with ⌘ shortcuts.",
    eyebrow: "Models",
    heading: "Switch models mid-thread.",
    body: "Open one picker and jump between every model your providers expose — Fable, Opus, Sonnet, Haiku, GPT and more. Reasoning effort, thinking and token budget sit right beside it.",
    points: ["One picker, every provider", "⌘1–9 to jump", "Effort, thinking & budget"],
    aspect: 1594 / 850,
  },
  {
    shot: "/shots/terminal.png",
    title: "Terminal",
    alt: "Ryco multi-terminal drawer running dev servers across split tabs.",
    eyebrow: "Terminal",
    heading: "Real terminals, in a drawer.",
    body: "Split terminal tabs run your dev servers and scripts beside the thread, with clickable file and path links — no window-juggling to see what an agent just ran.",
    points: ["Split tabs", "Clickable paths", "Runs your scripts"],
    aspect: 1782 / 1010,
  },
  {
    shot: "/shots/themes.png",
    title: "Appearance",
    alt: "Ryco theme editor with font pickers, text size, corner radius and a custom accent colour.",
    eyebrow: "Appearance",
    heading: "Make it unmistakably yours.",
    body: "Independent interface and code fonts, text size, corner radius and a pinnable accent — tuned live, with a full custom colour when the presets aren't enough.",
    points: ["Interface & code fonts", "Size & radius", "Custom accent"],
    aspect: 1946 / 1590,
  },
  {
    shot: "/shots/diagnostics.png",
    title: "Diagnostics",
    alt: "Ryco diagnostics — uptime, memory and CPU, resource-history charts and tracing diagnostics.",
    eyebrow: "Observability",
    heading: "See exactly what's happening.",
    body: "Live uptime, memory and CPU, resource-history charts, and tracing diagnostics with span names and duration buckets — full visibility into every agent, all local.",
    points: ["Resource history", "Trace spans", "Duration buckets"],
    aspect: 1946 / 1564,
  },
];

/* ------------------------------- small hook -------------------------------- */

/** Read prefers-reduced-motion once on mount; gates the motion-only layouts. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotion());
  useEffect(() => setReduced(prefersReducedMotion()), []);
  return reduced;
}

/**
 * Magnetic pull: `[data-magnetic]` elements inside the scope translate gently
 * toward the pointer and ease back on leave. Skipped for coarse pointers and
 * under reduced motion (the elements just stay put).
 */
function useMagnetic(scopeRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const root = scopeRef.current ?? document;
    const cleanups: Array<() => void> = [];
    root.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2);
        const y = e.clientY - (r.top + r.height / 2);
        el.style.transform = `translate(${x * 0.18}px, ${y * 0.26}px)`;
      };
      const leave = () => {
        el.style.transform = "";
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      cleanups.push(() => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerleave", leave);
        el.style.transform = "";
      });
    });
    return () => cleanups.forEach((c) => c());
  }, [scopeRef]);
}

/* ------------------------------- primitives -------------------------------- */

/* Kinetic terminal — types the real install commands in on scroll, with a
   blinking caret. Renders fully (and instantly) under reduced motion. */
type TermTok = { t: string; tone?: "accent" | "muted" };

const TERM_LINES: TermTok[][] = [
  [{ t: "# try it instantly", tone: "muted" }],
  [{ t: "$ ", tone: "accent" }, { t: SITE.npx }],
  [],
  [{ t: "# or build from source", tone: "muted" }],
  [{ t: "$ ", tone: "accent" }, { t: `git clone ${SITE.repo.replace("https://", "")}` }],
  [{ t: "$ ", tone: "accent" }, { t: "bun install" }],
  [{ t: "$ ", tone: "accent" }, { t: "bun run dev:desktop" }],
];

const TERM_PLAINTEXT = TERM_LINES.map((l) => l.map((t) => t.t).join("")).join("\n");
const termLineLen = (i: number) => TERM_LINES[i].reduce((n, tok) => n + tok.t.length, 0);

function renderTermLine(line: TermTok[], count: number) {
  let n = count;
  return line.map((tok, i) => {
    if (n <= 0) return null;
    const slice = n >= tok.t.length ? tok.t : tok.t.slice(0, n);
    n -= tok.t.length;
    return (
      <span
        key={i}
        className={tok.tone === "muted" ? "text-white/40" : "text-white/85"}
        style={tok.tone === "accent" ? { color: ACCENT } : undefined}
      >
        {slice}
      </span>
    );
  });
}

function KineticTerminal() {
  const ref = useRef<HTMLDivElement>(null);
  const posRef = useRef({ line: 0, char: 0 });
  const doneRef = useRef(false);
  const [, force] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      const last = TERM_LINES.length - 1;
      posRef.current = { line: last, char: termLineLen(last) };
      doneRef.current = true;
      setStarted(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!started || doneRef.current || prefersReducedMotion()) return;
    let cancelled = false;
    let timer = 0;
    const step = () => {
      if (cancelled) return;
      const p = posRef.current;
      if (p.char < termLineLen(p.line)) {
        posRef.current = { line: p.line, char: p.char + 1 };
        timer = window.setTimeout(step, 16 + Math.random() * 34);
      } else if (p.line + 1 < TERM_LINES.length) {
        posRef.current = { line: p.line + 1, char: 0 };
        timer = window.setTimeout(step, 150 + Math.random() * 120);
      } else {
        doneRef.current = true;
      }
      force((n) => n + 1);
    };
    timer = window.setTimeout(step, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [started]);

  const p = posRef.current;
  return (
    <div
      data-reveal
      className="mt-5 overflow-hidden rounded-3xl border border-white/10 bg-black/40 font-['JetBrains_Mono'] text-[13px]"
    >
      <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5 text-white/55">
        <span className="size-2.5 rounded-full bg-white/20" />
        <span className="size-2.5 rounded-full bg-white/20" />
        <span className="size-2.5 rounded-full bg-white/20" />
        <span className="ml-2">zsh</span>
      </div>
      <div ref={ref} aria-hidden className="min-h-[196px] px-5 py-5 leading-relaxed">
        {TERM_LINES.map((line, i) => {
          // Until typing starts, render nothing (every later line would otherwise
          // print in full, then collapse back once the animation kicks in).
          if (!started || i > p.line) return null;
          const isActive = i === p.line;
          const count = isActive && !doneRef.current ? p.char : Number.POSITIVE_INFINITY;
          return (
            <div key={i} className="min-h-[1.5em] whitespace-pre">
              {line.length === 0 ? " " : renderTermLine(line, count)}
              {isActive && (
                <span className="ryco-caret ml-px align-middle" style={{ color: ACCENT }} />
              )}
            </div>
          );
        })}
      </div>
      <pre className="sr-only">{TERM_PLAINTEXT}</pre>
    </div>
  );
}

function Copyable({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          },
          () => {},
        );
      }}
      className={cn(
        "group/c inline-flex items-center gap-3 rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2.5 font-['JetBrains_Mono'] text-[13px] text-white/85 backdrop-blur-sm transition hover:border-[#c6ff3a]/40 hover:bg-white/[0.06]",
        focusRing,
        className,
      )}
      aria-label={copied ? `Copied ${text} to clipboard` : `Copy command: ${text}`}
    >
      <span style={{ color: ACCENT }} className="select-none">
        $
      </span>
      <span className="truncate">{text.replace(/^\$ ?/, "")}</span>
      <span className="ml-1 text-white/50 transition group-hover/c:text-white/80">
        {copied ? (
          <Check className="size-3.5" style={{ color: ACCENT }} />
        ) : (
          <Copy className="size-3.5" />
        )}
      </span>
    </button>
  );
}

function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "inline-flex items-center gap-2 font-['JetBrains_Mono'] text-[11px] font-medium uppercase tracking-[0.22em] text-white/55",
        className,
      )}
    >
      <span aria-hidden className="h-px w-6" style={{ background: ACCENT }} />
      {children}
    </p>
  );
}

/** Section heading with a per-line clip-mask reveal (gated by [data-line-reveal]). */
function SectionHeading({
  children,
  className,
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <h2
      id={id}
      className={cn(
        "font-['Space_Grotesk'] text-4xl font-bold tracking-[-0.02em] sm:text-5xl",
        className,
      )}
    >
      <span className="block overflow-hidden pb-[0.08em]">
        <span data-line-reveal className="block">
          {children}
        </span>
      </span>
    </h2>
  );
}

/* Stat figures are spelled out (Zero · Three · Five) rather than digits. */
const NUM_WORDS: Record<string, string> = {
  "0": "Zero",
  "1": "One",
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "6": "Six",
  "7": "Seven",
  "8": "Eight",
  "9": "Nine",
  "10": "Ten",
};

function Stat({ value, label }: { value: string; label: string }) {
  const display = /^\d+$/.test(value) ? (NUM_WORDS[value] ?? value) : value;
  return (
    <div data-reveal className="rounded-3xl border border-white/10 bg-white/[0.02] p-6 sm:p-7">
      <div
        className="font-['Space_Grotesk'] text-4xl font-bold tracking-[-0.02em] sm:text-5xl"
        style={{ color: ACCENT }}
      >
        <span className="block overflow-hidden pb-[0.08em]">
          <span data-stat-word className="block whitespace-nowrap">
            {display}
          </span>
        </span>
      </div>
      <p className="mt-3 text-sm leading-snug text-white/55">{label}</p>
    </div>
  );
}

function FaqRow({
  q,
  a,
  open,
  onToggle,
}: {
  q: string;
  a: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border bg-white/[0.02] transition-colors",
        open ? "border-[#c6ff3a]/35" : "border-white/10",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn("flex w-full items-center gap-4 px-5 py-4 text-left sm:px-6", focusRing)}
      >
        <span className="flex-1 font-['Space_Grotesk'] text-base font-medium text-white sm:text-lg">
          {q}
        </span>
        <span
          className="relative grid size-7 shrink-0 place-items-center transition-colors duration-300"
          style={open ? { color: ACCENT } : { color: "rgba(255,255,255,0.7)" }}
        >
          <span aria-hidden className="absolute h-0.5 w-3 rounded-full bg-current" />
          <span
            aria-hidden
            className={cn(
              "absolute h-0.5 w-3 rounded-full bg-current transition-transform duration-300 ease-out",
              open ? "rotate-0" : "rotate-90",
            )}
          />
        </span>
      </button>
      <div
        className="grid transition-all duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-5 text-sm leading-relaxed text-white/65 sm:px-6 sm:text-[15px]">
            {a}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Fixed, version-agnostic kinetic backdrop: faint grid + a single lime glow. */
function KineticBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[#0a0b0d]"
    >
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(120% 90% at 50% 0%, #000 30%, transparent 80%)",
        }}
      />
      <div
        className="absolute -top-[18%] left-1/2 size-[60vw] max-w-[820px] -translate-x-1/2 rounded-full blur-[140px]"
        style={{ background: `${ACCENT}1f` }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, transparent 45%, rgba(10,11,13,0.6) 100%), linear-gradient(180deg, rgba(10,11,13,0.2), transparent 22%, rgba(10,11,13,0.55))",
        }}
      />
    </div>
  );
}

/* ---------------------------------- page ----------------------------------- */

export default function Version4() {
  const reduced = useReducedMotion();
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [activeShot, setActiveShot] = useState(0);
  const dl = useDownload();

  const heroShotRef = useRef<HTMLDivElement>(null);

  const scope = useGsapContext(({ gsap, ScrollTrigger }) => {
    /* Refresh trigger positions as the large screenshots finish decoding. */
    gsap.utils.toArray<HTMLImageElement>("img").forEach((img) => {
      if (!img.complete)
        img.addEventListener("load", () => ScrollTrigger.refresh(), { once: true });
    });

    /* Hero — kinetic load entrance. */
    gsap.from("[data-hero-line]", {
      yPercent: 118,
      duration: 1,
      ease: "power4.out",
      stagger: 0.09,
    });
    gsap.from("[data-hero-fade]", {
      opacity: 0,
      y: 18,
      duration: 0.9,
      ease: "power3.out",
      stagger: 0.07,
      delay: 0.35,
    });

    /* Hero screenshot — cinematic clip-reveal on load + gentle parallax. */
    if (heroShotRef.current) {
      gsap.from(heroShotRef.current, {
        autoAlpha: 0,
        scale: 1.06,
        clipPath: "inset(9% 5% 12% 5% round 20px)",
        duration: 1.3,
        ease: "power3.out",
        delay: 0.45,
      });
      gsap.to(heroShotRef.current, {
        yPercent: -6,
        ease: "none",
        scrollTrigger: {
          trigger: heroShotRef.current,
          start: "top bottom",
          end: "bottom top",
          scrub: 0.6,
        },
      });
    }

    /* Hero accent underline draws in under "agents." */
    gsap.from("[data-hero-underline]", {
      scaleX: 0,
      transformOrigin: "left",
      duration: 0.9,
      ease: "power3.inOut",
      delay: 1.05,
    });

    /* Section headings — per-line clip-mask reveal. */
    gsap.utils.toArray<HTMLElement>("[data-line-reveal]").forEach((el) => {
      gsap.from(el, {
        yPercent: 120,
        duration: 0.95,
        ease: "power4.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      });
    });

    /* Marquee — seamless loop (content is duplicated, so -50% wraps cleanly),
       kinetic: it speeds up with scroll velocity and eases back when you stop. */
    const marqueeTweens = gsap.utils
      .toArray<HTMLElement>("[data-marquee]")
      .map((track) => gsap.to(track, { xPercent: -50, duration: 26, ease: "none", repeat: -1 }));
    if (marqueeTweens.length) {
      const speed = { ts: 1 };
      const applyTs = () => marqueeTweens.forEach((tw) => tw.timeScale(speed.ts));
      const tsTo = gsap.quickTo(speed, "ts", { duration: 0.5, ease: "power2", onUpdate: applyTs });
      let settle: ReturnType<typeof gsap.delayedCall> | undefined;
      ScrollTrigger.create({
        onUpdate: (self) => {
          tsTo(gsap.utils.clamp(1, 6, 1 + Math.abs(self.getVelocity()) / 520));
          settle?.kill();
          settle = gsap.delayedCall(0.2, () => tsTo(1));
        },
      });
    }

    /* Sticky scrollytelling — swap the active screenshot per step. */
    gsap.utils.toArray<HTMLElement>("[data-shot-step]").forEach((el, i) => {
      ScrollTrigger.create({
        trigger: el,
        start: "top 55%",
        end: "bottom 55%",
        onEnter: () => setActiveShot(i),
        onEnterBack: () => setActiveShot(i),
      });
    });

    /* How-it-works progress line draws as you scroll the timeline. */
    const prog = document.querySelector<HTMLElement>("[data-timeline-progress]");
    const timeline = document.querySelector<HTMLElement>("[data-timeline]");
    if (prog && timeline) {
      gsap.fromTo(
        prog,
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: "none",
          transformOrigin: "top",
          scrollTrigger: { trigger: timeline, start: "top 70%", end: "bottom 80%", scrub: true },
        },
      );
    }

    /* Spelled-out stat figures rise in behind a clip mask. */
    gsap.utils.toArray<HTMLElement>("[data-stat-word]").forEach((el) => {
      gsap.from(el, {
        yPercent: 115,
        duration: 0.9,
        ease: "power4.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
    });

    /* Generic on-scroll reveals. */
    gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
      gsap.from(el, {
        opacity: 0,
        y: 28,
        duration: 0.8,
        ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 86%", once: true },
      });
    });

    /* Chip clusters pop in with a springy stagger. */
    gsap.utils.toArray<HTMLElement>("[data-chip-stagger]").forEach((wrap) => {
      gsap.from(Array.from(wrap.children), {
        opacity: 0,
        y: 12,
        scale: 0.92,
        duration: 0.5,
        ease: "back.out(1.6)",
        stagger: 0.04,
        scrollTrigger: { trigger: wrap, start: "top 90%", once: true },
      });
    });

    /* Icon stroke draw-on — feature & pillar glyphs trace themselves in as they
       enter view, then quickly re-trace when you hover the card. lucide marks are
       stroke-only, so getTotalLength is defined on every child. The whole block
       no-ops under reduced motion (and nothing is CSS-hidden), so the static
       layout always ships the icons fully drawn. */
    gsap.utils.toArray<HTMLElement>("[data-draw-icon]").forEach((wrap) => {
      const shapes = Array.from(
        wrap.querySelectorAll<SVGGeometryElement>(
          "path, line, polyline, circle, rect, ellipse, polygon",
        ),
      ).filter((s) => typeof s.getTotalLength === "function" && s.getTotalLength() > 0);
      if (!shapes.length) return;

      const trace = (duration: number) =>
        shapes.forEach((s) => {
          const len = s.getTotalLength();
          gsap.set(s, { strokeDasharray: len });
          gsap.fromTo(
            s,
            { strokeDashoffset: len },
            { strokeDashoffset: 0, duration, ease: "power2.out", overwrite: "auto" },
          );
        });

      // start undrawn, then trace on first reveal …
      shapes.forEach((s) => {
        const len = s.getTotalLength();
        gsap.set(s, { strokeDasharray: len, strokeDashoffset: len });
      });
      ScrollTrigger.create({
        trigger: wrap,
        start: "top 90%",
        once: true,
        onEnter: () => trace(0.85),
      });

      // … and re-trace on hover of the enclosing card
      const card = wrap.closest<HTMLElement>("article");
      card?.addEventListener("mouseenter", () => trace(0.5));
    });

    ScrollTrigger.refresh();
  });

  useMagnetic(scope);
  useTilt(scope);

  return (
    <div ref={scope} className="relative min-h-screen bg-[#0a0b0d] text-white antialiased">
      <KineticBackground />

      {/* ---------------------------------- nav --------------------------------- */}
      <SiteNav />

      <main id="top">
        {/* --------------------------------- hero -------------------------------- */}
        <section className="relative mx-auto max-w-7xl px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
          <div className="mx-auto max-w-5xl text-center">
            <h1 className="font-['Space_Grotesk'] text-[clamp(2.9rem,9vw,7rem)] font-bold leading-[0.88] tracking-[-0.04em]">
              <span className="block overflow-hidden pb-[0.06em]">
                <span data-hero-line className="block">
                  Every coding agent,
                </span>
              </span>
              <span className="block overflow-hidden pb-[0.06em]">
                <span data-hero-line className="block">
                  <span className="relative inline-block" style={{ color: ACCENT }}>
                    side by side.
                    <span
                      data-hero-underline
                      aria-hidden
                      className="absolute -bottom-1 left-0 h-[3px] w-full rounded-full"
                      style={{ background: ACCENT, boxShadow: `0 0 16px ${ACCENT}` }}
                    />
                  </span>
                </span>
              </span>
              <span className="block overflow-hidden pb-[0.06em]">
                <span data-hero-line className="block">
                  On your machine.
                </span>
              </span>
            </h1>

            <p
              data-hero-fade
              className="mx-auto mt-7 max-w-2xl text-pretty text-base leading-relaxed text-white/65 sm:text-lg"
            >
              {SITE.oneLiner}
            </p>

            <div data-hero-fade className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <MagneticButton href={dl.href} external={!dl.isDirect} variant="primary">
                <Download className="size-[18px]" /> Download{" "}
                {dl.osLabel ? `for ${dl.osLabel}` : "for desktop"}
              </MagneticButton>
              <MagneticButton href={SITE.repo} external variant="ghost">
                <GitHubIcon className="size-[18px]" /> View source
                <ArrowRight className="size-4 transition-transform duration-300 group-hover/btn:translate-x-0.5" />
              </MagneticButton>
            </div>

            {/* detected target + escape hatch */}
            <p data-hero-fade className="mt-4 text-xs text-white/45">
              {dl.osLabel && (
                <span className="text-white/55">
                  {dl.osLabel}
                  {dl.archLabel ? ` · ${dl.archLabel}` : ""}
                  {dl.version ? ` · ${dl.version}` : ""}
                  {" · "}
                </span>
              )}
              <a
                href={dl.releasesUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "underline-offset-2 transition-colors hover:text-white/80 hover:underline",
                  focusRing,
                )}
              >
                {dl.osLabel ? "other builds" : "All builds & platforms"}
              </a>
            </p>

            <div data-hero-fade className="mt-5 flex justify-center">
              <Copyable text={SITE.npx} />
            </div>

            {/* the six agents — one row on desktop, wraps centered on smaller screens */}
            <div
              data-hero-fade
              className="mx-auto mt-12 flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-4"
            >
              {PROVIDERS.map((p) => (
                <span
                  key={p.id}
                  className="group/v inline-flex items-center gap-2 text-white/55 transition hover:text-white"
                  title={`${p.name} — ${p.vendor}`}
                >
                  <BrandIcon
                    name={p.brand}
                    className="size-5 opacity-70 transition group-hover/v:opacity-100"
                    style={{ color: p.accent }}
                  />
                  <span className="text-[15px] font-medium">{p.name}</span>
                </span>
              ))}
            </div>
          </div>

          {/* hero screenshot — parallax (outer) + pointer 3D tilt & glare (inner) */}
          <div ref={heroShotRef} className="relative mx-auto mt-16 max-w-5xl will-change-transform">
            <div data-tilt data-tilt-max="6" className="relative rounded-xl will-change-transform">
              <ScreenshotFrame
                src="/shots/overview.png"
                alt="The Ryco project overview — open issues, pull requests, Actions and Jira at a glance."
                theme="dark"
                chrome={false}
                loading="eager"
                className="shadow-[0_50px_140px_-40px_rgba(0,0,0,0.9)]"
              />
              <span
                data-glare
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-xl opacity-0 mix-blend-soft-light"
                style={{
                  background:
                    "radial-gradient(420px circle at var(--gx,50%) var(--gy,50%), rgba(255,255,255,0.55), transparent 60%)",
                }}
              />
            </div>
          </div>
        </section>

        {/* ------------------------------- marquee ------------------------------- */}
        <section aria-hidden className="relative border-y border-white/10 py-5">
          <div className="flex overflow-hidden">
            <div data-marquee className="flex w-max shrink-0 items-center gap-8 pr-8">
              {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
                <span
                  key={i}
                  className="flex items-center gap-8 font-['Space_Grotesk'] text-2xl font-medium text-white/30 sm:text-3xl"
                >
                  {item}
                  <span style={{ color: ACCENT }}>/</span>
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------- agents -------------------------------- */}
        <section id="agents" className={cn("relative", NAV_OFFSET)}>
          <div className="mx-auto max-w-7xl px-5 pt-24 sm:px-8">
            <div data-reveal className="max-w-2xl">
              <Eyebrow>Six agents · one workspace</Eyebrow>
              <SectionHeading className="mt-5">Every coding agent, side by side.</SectionHeading>
              <p className="mt-5 text-white/60 sm:text-lg">
                Codex, Claude, GitHub Copilot, OpenCode, Cursor and Grok — each through its native
                SDK or protocol, using the subscription you already pay for. Switch per thread
                without losing context.
              </p>
            </div>
          </div>

          {reduced ? (
            /* Static fallback — a clean responsive grid, all agents visible. */
            <div className="mx-auto max-w-7xl px-5 pt-12 sm:px-8">
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {PROVIDERS.map((p, i) => (
                  <ProviderCard key={p.id} p={p} index={i} />
                ))}
              </div>
              <div className="mt-5">
                <ScreenshotFrame
                  src="/shots/providers.png"
                  alt="Ryco settings showing provider instances authenticated with live version and subscription status."
                  theme="dark"
                  chrome={false}
                  className="shadow-[0_40px_120px_-55px_rgba(0,0,0,0.9)]"
                />
              </div>
            </div>
          ) : (
            /* Motion — a pinned horizontal 3D coverflow of the six agents. */
            <div className="mt-12">
              <AgentDeck />
            </div>
          )}
        </section>

        {/* -------------------------- model providers ---------------------------- */}
        <section className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.05fr] lg:items-center">
            <div data-reveal>
              <Eyebrow>Model providers & routing</Eyebrow>
              <SectionHeading className="mt-5">Same agent, your choice of backend.</SectionHeading>
              <p className="mt-5 max-w-md text-white/60">
                Named provider instances let you run, say,{" "}
                <span className="font-['JetBrains_Mono']" style={{ color: ACCENT }}>
                  claude_openrouter
                </span>{" "}
                and{" "}
                <span className="font-['JetBrains_Mono']" style={{ color: ACCENT }}>
                  codex_personal
                </span>{" "}
                at once — each with independent config, env vars, auth identity, models and accent
                colour.
              </p>
            </div>

            <div
              data-reveal
              className="rounded-3xl border border-white/10 bg-white/[0.02] p-7 sm:p-8"
            >
              <p className="font-['JetBrains_Mono'] text-[11px] uppercase tracking-[0.2em] text-white/55">
                Model providers
              </p>
              <div data-chip-stagger className="mt-4 flex flex-wrap gap-2.5">
                {MODEL_PROVIDERS.map((m) => (
                  <span
                    key={m}
                    className="rounded-lg border border-white/12 bg-white/[0.04] px-3 py-1.5 font-['JetBrains_Mono'] text-[13px] text-white/80"
                  >
                    {m}
                  </span>
                ))}
              </div>
              <p className="mt-7 font-['JetBrains_Mono'] text-[11px] uppercase tracking-[0.2em] text-white/55">
                Named instances
              </p>
              <div data-chip-stagger className="mt-4 flex flex-wrap gap-2.5">
                {INSTANCE_EXAMPLES.map((n) => (
                  <span
                    key={n}
                    className="rounded-lg border px-3 py-1.5 font-['JetBrains_Mono'] text-[13px]"
                    style={{ color: ACCENT, borderColor: `${ACCENT}33`, background: `${ACCENT}0f` }}
                  >
                    {n}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------- showcase ------------------------------ */}
        <section
          id="showcase"
          className={cn("relative mx-auto max-w-7xl px-5 py-24 sm:px-8", NAV_OFFSET)}
        >
          <div data-reveal className="max-w-2xl">
            <Eyebrow>The workspace</Eyebrow>
            <SectionHeading className="mt-5">Built for the way you actually ship.</SectionHeading>
            <p className="mt-5 text-white/60 sm:text-lg">
              Not a chat box bolted onto a terminal — a real workspace. Models, terminals, theming
              and full observability, a keystroke apart.
            </p>
          </div>

          {reduced ? (
            /* Static fallback — every step stacked with its screenshot, fully visible. */
            <div className="mt-16 space-y-20">
              {SHOWCASE.map((s, i) => (
                <div key={s.shot} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                  <div className={cn(i % 2 === 1 && "lg:order-2")}>
                    <Eyebrow>{s.eyebrow}</Eyebrow>
                    <h3 className="mt-4 font-['Space_Grotesk'] text-2xl font-semibold tracking-[-0.01em] sm:text-3xl">
                      {s.heading}
                    </h3>
                    <p className="mt-4 max-w-md text-white/60">{s.body}</p>
                    <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/65">
                      {s.points.map((pt) => (
                        <li key={pt} className="inline-flex items-center gap-1.5">
                          <Check className="size-3.5" style={{ color: ACCENT }} /> {pt}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className={cn(i % 2 === 1 && "lg:order-1")}>
                    <ScreenshotFrame
                      src={s.shot}
                      alt={s.alt}
                      theme="dark"
                      chrome={false}
                      className="shadow-[0_40px_120px_-55px_rgba(0,0,0,0.9)]"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Motion — sticky screenshot that swaps as the copy scrolls by. */
            <div className="mt-16 grid gap-12 lg:grid-cols-2 lg:gap-16">
              <div className="hidden lg:block">
                <div className="sticky top-[14vh]">
                  <div className="relative">
                    {/* the frame morphs to the active shot's native aspect, so each
                        capture fills it edge-to-edge — no letterbox bands */}
                    <div
                      className="relative w-full overflow-hidden rounded-xl border border-white/14 bg-[#0d0d10] shadow-[0_50px_140px_-50px_rgba(0,0,0,0.9)]"
                      style={{
                        paddingBottom: `${100 / SHOWCASE[activeShot].aspect}%`,
                        transition: "padding-bottom 0.6s cubic-bezier(0.22, 1, 0.36, 1)",
                      }}
                    >
                      {SHOWCASE.map((s, i) => (
                        <img
                          key={s.shot}
                          src={s.shot}
                          alt={s.alt}
                          loading={i === activeShot ? "eager" : "lazy"}
                          draggable={false}
                          aria-hidden={i !== activeShot}
                          className={cn(
                            "absolute inset-0 h-full w-full select-none object-cover transition-all duration-700 ease-out",
                            i === activeShot
                              ? "scale-100 opacity-100 blur-0"
                              : "pointer-events-none scale-[1.03] opacity-0 blur-[2px]",
                          )}
                        />
                      ))}
                    </div>
                    {/* step counter */}
                    <div className="pointer-events-none absolute -top-7 right-0 font-['JetBrains_Mono'] text-xs tabular-nums text-white/35">
                      <span style={{ color: ACCENT }}>
                        {String(activeShot + 1).padStart(2, "0")}
                      </span>
                      <span> / {String(SHOWCASE.length).padStart(2, "0")}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                {SHOWCASE.map((s, i) => (
                  <div
                    key={s.shot}
                    data-shot-step
                    className={cn(
                      "flex min-h-[78vh] flex-col justify-center border-l-2 pl-6 transition-all duration-500 lg:min-h-[80vh]",
                      i === activeShot ? "opacity-100" : "lg:opacity-40",
                    )}
                    style={{ borderColor: i === activeShot ? ACCENT : "rgba(255,255,255,0.1)" }}
                  >
                    <Eyebrow>{s.eyebrow}</Eyebrow>
                    <h3 className="mt-4 font-['Space_Grotesk'] text-3xl font-semibold tracking-[-0.015em] sm:text-4xl">
                      {s.heading}
                    </h3>
                    <p className="mt-5 max-w-md text-white/60 sm:text-lg">{s.body}</p>
                    <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/65">
                      {s.points.map((pt) => (
                        <li key={pt} className="inline-flex items-center gap-1.5">
                          <Check className="size-3.5" style={{ color: ACCENT }} /> {pt}
                        </li>
                      ))}
                    </ul>

                    {/* on small screens the screenshot rides inline with the copy */}
                    <div className="mt-7 lg:hidden">
                      <ScreenshotFrame
                        src={s.shot}
                        alt={s.alt}
                        theme="dark"
                        chrome={false}
                        className="shadow-[0_40px_120px_-55px_rgba(0,0,0,0.9)]"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* ------------------------------- features ------------------------------ */}
        <section
          id="features"
          className={cn("relative mx-auto max-w-7xl px-5 py-24 sm:px-8", NAV_OFFSET)}
        >
          <div data-reveal className="max-w-2xl">
            <Eyebrow>The toolkit</Eyebrow>
            <SectionHeading className="mt-5">
              Everything wired into one local surface.
            </SectionHeading>
            <p className="mt-5 text-white/60 sm:text-lg">
              Worktrees, terminals, diffs, MCP, source control and observability — no cloud
              round-trips you didn't ask for.
            </p>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURE_GROUPS.map((f) => {
              const FeatIcon = FEATURE_ICONS[f.id];
              return (
                <article
                  key={f.id}
                  data-reveal
                  data-tilt
                  data-tilt-max="5"
                  className="group relative flex flex-col gap-5 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-7 transition-colors duration-300 hover:border-white/20 hover:bg-white/[0.035]"
                >
                  <span
                    data-glare
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-2xl opacity-0"
                    style={{
                      background:
                        "radial-gradient(260px circle at var(--gx,50%) var(--gy,50%), rgba(198,255,58,0.10), transparent 60%)",
                    }}
                  />
                  <FeatIcon className="relative size-12 text-[#c6ff3a]/85 transition-colors duration-300 group-hover:text-[#c6ff3a]" />
                  <div className="relative">
                    <h3 className="font-['Space_Grotesk'] text-lg font-semibold text-white">
                      {f.title}
                    </h3>
                    <p className="mt-2.5 text-[14px] leading-relaxed text-white/55">{f.blurb}</p>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* ------------------------------ deep dive ------------------------------ */}
        <section className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <div data-reveal className="max-w-2xl">
            <Eyebrow>A closer look</Eyebrow>
            <SectionHeading className="mt-5">Under the hood.</SectionHeading>
            <p className="mt-5 text-white/60 sm:text-lg">
              Files, diffs, named instances, token plugins, CI and project config — the depth that
              makes Ryco a workspace, not a chat box.
            </p>
          </div>
          <Gallery />
        </section>

        {/* --------------------------- pillars + stats --------------------------- */}
        <section className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <div className="grid gap-5 lg:grid-cols-3">
            {PILLARS.map((pillar) => {
              const Icon = ICONS[pillar.icon];
              return (
                <article
                  key={pillar.title}
                  data-reveal
                  className="group rounded-3xl border border-white/10 bg-white/[0.02] p-7 transition-colors duration-300 hover:border-white/20 sm:p-8"
                >
                  <span
                    data-draw-icon
                    className="grid size-12 place-items-center rounded-2xl border"
                    style={{ color: ACCENT, borderColor: `${ACCENT}33`, background: `${ACCENT}10` }}
                  >
                    {Icon ? (
                      <Icon className="size-6 transition-transform duration-300 ease-out group-hover:scale-110" />
                    ) : null}
                  </span>
                  <h3 className="mt-5 font-['Space_Grotesk'] text-xl font-semibold text-white">
                    {pillar.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-white/60">{pillar.body}</p>
                </article>
              );
            })}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {STATS.map((s) => (
              <Stat key={s.label} value={s.value} label={s.label} />
            ))}
          </div>
        </section>

        {/* ----------------------------- how it works ---------------------------- */}
        <section className="relative mx-auto max-w-5xl px-5 py-24 sm:px-8">
          <div data-reveal className="max-w-2xl">
            <Eyebrow>From zero to shipped</Eyebrow>
            <SectionHeading className="mt-5">How it works.</SectionHeading>
          </div>

          <ol data-timeline className="relative mt-14 space-y-10 pl-10">
            {/* base rail + drawn progress */}
            <span aria-hidden className="absolute left-[14px] top-2 bottom-2 w-px bg-white/10" />
            <span
              aria-hidden
              data-timeline-progress
              className="absolute left-[14px] top-2 bottom-2 w-px"
              style={{ background: ACCENT, transformOrigin: "top" }}
            />
            {STEPS.map((step, i) => {
              const StepIcon = STEP_ICONS[i];
              return (
                <li
                  key={step.n}
                  data-reveal
                  className="relative flex items-start justify-between gap-6"
                >
                  <span
                    className="absolute -left-10 grid size-7 place-items-center rounded-full border bg-[#0a0b0d] font-['JetBrains_Mono'] text-[11px] font-semibold"
                    style={{ color: ACCENT, borderColor: `${ACCENT}55` }}
                  >
                    {step.n}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-['Space_Grotesk'] text-xl font-semibold text-white">
                      {step.title}
                    </h3>
                    <p className="mt-2 max-w-xl text-white/60">{step.body}</p>
                  </div>
                  {StepIcon && (
                    <span
                      aria-hidden
                      className="hidden shrink-0 self-center sm:block"
                      style={{ color: ACCENT }}
                    >
                      <StepIcon className="size-16 opacity-80" />
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        {/* ------------------------------- download ------------------------------ */}
        <section
          id="download"
          className={cn("relative mx-auto max-w-7xl px-5 py-24 sm:px-8", NAV_OFFSET)}
        >
          <div data-reveal className="max-w-2xl">
            <Eyebrow>Cross-platform · {SITE.license} licensed</Eyebrow>
            <SectionHeading className="mt-5">Download Ryco.</SectionHeading>
            <p className="mt-5 text-white/60 sm:text-lg">
              Native builds for supported desktop platforms, or kick the tires instantly with the{" "}
              <span className="font-['JetBrains_Mono'] text-white/80">{SITE.npx}</span> web CLI.
              Local-first, no cloud required.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {PLATFORMS.map((pl) => {
              const assetUrl =
                pl.id === "macos"
                  ? dl.urls?.mac
                  : pl.id === "windows"
                    ? dl.urls?.win
                    : pl.id === "linux"
                      ? dl.urls?.linux
                      : null;
              const direct = !!assetUrl;
              return (
                <a
                  key={pl.id}
                  href={assetUrl ?? SITE.releases}
                  {...(direct ? {} : { target: "_blank", rel: "noreferrer" })}
                  data-reveal
                  data-tilt
                  data-tilt-max="6"
                  className={cn(
                    "group flex flex-col gap-5 rounded-3xl border border-white/10 bg-white/[0.02] p-7 transition-colors duration-300 hover:border-white/25",
                    focusRing,
                  )}
                >
                  <div className="flex items-center gap-4">
                    <span className="grid size-12 place-items-center rounded-2xl border border-white/12 bg-white/[0.03] text-white">
                      <BrandIcon name={pl.brand} className="size-6" />
                    </span>
                    <div>
                      <h3 className="font-['Space_Grotesk'] text-lg font-semibold text-white">
                        {pl.name}
                      </h3>
                      <p className="font-['JetBrains_Mono'] text-xs text-white/55">
                        {pl.format} · {pl.arch}
                      </p>
                    </div>
                  </div>
                  <p className="text-[14px] leading-relaxed text-white/55">{pl.install}</p>
                  <span
                    className="mt-auto inline-flex items-center gap-2 text-sm font-semibold transition-colors group-hover:text-[#c6ff3a]"
                    style={{ color: ACCENT }}
                  >
                    <Download className="size-4" /> Get the {pl.format}
                    <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </a>
              );
            })}
          </div>

          <p className="mt-6 text-sm text-white/50">
            {dl.version && (
              <span className="font-['JetBrains_Mono'] text-white/60">{dl.version}</span>
            )}{" "}
            <a
              href={dl.releasesUrl}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "underline-offset-2 transition-colors hover:text-white hover:underline",
                focusRing,
              )}
            >
              All builds &amp; checksums on GitHub
              <ArrowUpRight className="ml-0.5 inline size-3.5 align-[-0.1em]" />
            </a>
          </p>

          <KineticTerminal />
        </section>

        {/* --------------------------------- faq --------------------------------- */}
        <section
          id="faq"
          className={cn("relative mx-auto max-w-3xl px-5 py-24 sm:px-8", NAV_OFFSET)}
        >
          <div data-reveal className="mb-10">
            <Eyebrow>Questions</Eyebrow>
            <SectionHeading className="mt-5">Frequently asked.</SectionHeading>
          </div>
          <div className="space-y-3">
            {FAQ.map((item, i) => (
              <div key={item.q} data-reveal>
                <FaqRow
                  q={item.q}
                  a={item.a}
                  open={openFaq === i}
                  onToggle={() => setOpenFaq(openFaq === i ? null : i)}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------- final CTA ----------------------------- */}
        <section className="relative mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <div
            data-reveal
            className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.02] px-6 py-16 text-center sm:px-12 sm:py-20"
          >
            <div
              aria-hidden
              className="absolute -top-1/3 left-1/2 size-[60vw] max-w-[640px] -translate-x-1/2 rounded-full blur-[130px]"
              style={{ background: `${ACCENT}1a` }}
            />
            <h2 className="relative mx-auto max-w-3xl font-['Space_Grotesk'] text-[clamp(2rem,5vw,3.6rem)] font-bold leading-[1.02] tracking-[-0.025em]">
              Stop tab-switching. <span style={{ color: ACCENT }}>Start shipping</span> — with every
              agent at once.
            </h2>
            <p className="relative mx-auto mt-5 max-w-xl text-white/60">
              Local-first, {SITE.license}, and honest about being early. Install a provider, open a
              worktree, and let the agents loose.
            </p>
            <div className="relative mt-9 flex flex-wrap items-center justify-center gap-3">
              <MagneticButton href={dl.href} external={!dl.isDirect} variant="primary">
                <Download className="size-[18px]" /> Download{" "}
                {dl.osLabel ? `for ${dl.osLabel}` : "Ryco"}
              </MagneticButton>
              <MagneticButton href={SITE.discord} external variant="ghost">
                <MessagesSquare className="size-[18px]" /> Join the Discord
              </MagneticButton>
            </div>
          </div>
        </section>
      </main>

      {/* --------------------------------- footer ------------------------------- */}
      <footer className="relative border-t border-white/10 pb-16 pt-14">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-sm">
              <div className="flex items-center gap-2.5">
                <RycoMark className="size-7" />
                <RycoWordmark className="h-[18px] text-white" />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-white/55">{SITE.longDescription}</p>
            </div>
            <nav aria-label="Footer" className="flex flex-wrap gap-x-12 gap-y-8 text-sm">
              <div className="flex flex-col gap-3">
                <span className="font-['JetBrains_Mono'] text-xs uppercase tracking-widest text-white/55">
                  Project
                </span>
                <a
                  href={SITE.repo}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "inline-flex items-center gap-1.5 text-white/65 transition hover:text-white",
                    focusRing,
                  )}
                >
                  <GitHubIcon className="size-4" /> GitHub
                </a>
                <a
                  href={SITE.releases}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/65 transition hover:text-white"
                >
                  Releases
                </a>
                <a href="/changelog" className="text-white/65 transition hover:text-white">
                  Changelog
                </a>
                <a
                  href={SITE.discord}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "inline-flex items-center gap-1.5 text-white/65 transition hover:text-white",
                    focusRing,
                  )}
                >
                  <MessagesSquare className="size-4" /> Discord
                </a>
              </div>
              <div className="flex flex-col gap-3">
                <span className="font-['JetBrains_Mono'] text-xs uppercase tracking-widest text-white/55">
                  Get started
                </span>
                <a href="#download" className="text-white/65 transition hover:text-white">
                  Download
                </a>
                <a href="#agents" className="text-white/65 transition hover:text-white">
                  Agents
                </a>
                <a href="#features" className="text-white/65 transition hover:text-white">
                  Features
                </a>
              </div>
            </nav>
          </div>

          <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-white/55 sm:flex-row sm:items-center sm:justify-between">
            <p>
              {SITE.license} licensed · © {SITE.company}
            </p>
            <p className="hidden md:block">A fast local workspace for coding agents.</p>
            <p>
              Built &amp; maintained by{" "}
              <a
                href={SITE.maintainer.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "group/by inline-flex items-center gap-0.5 font-medium text-white/75 transition hover:text-[#c6ff3a]",
                  focusRing,
                )}
              >
                {SITE.maintainer.name}
                <ArrowUpRight className="size-3 transition-transform duration-300 group-hover/by:translate-x-0.5 group-hover/by:-translate-y-0.5" />
              </a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
