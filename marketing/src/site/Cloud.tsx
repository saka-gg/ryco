/**
 * Ryco Cloud (the hosted Hub at app.ryco.space). Optional, free for now.
 *
 * The diagram is a scaled design canvas like the Stage: machines dial *out*
 * to the hub (no inbound ports), the hub relays an encrypted channel to the
 * browser, and threads from both machines land in one inbox, each tagged with
 * where it runs. Scroll draws the network; once live, packets keep flowing.
 */
import { useEffect, useRef } from "react";
import {
  ArrowUpRight,
  Check,
  HardDrive,
  KeyRound,
  Laptop,
  Layers,
  Lock,
  Network,
  Router,
  Server,
} from "lucide-react";
import { BrandIcon } from "@/assets/brands";
import { RycoMark } from "@/assets/RycoLogo";
import { CLOUD, providerById, SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, prefersReducedMotion, useGsap } from "@/lib/motion";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { Spinner } from "./stage/Stage";
import { Button } from "./ui/Button";
import { CopyCommand } from "./ui/CopyCommand";
import { revealText, revealUp } from "./ui/reveal";
import { SECTION_X } from "./theme";

type Box = { x: number; y: number; w: number; h: number };
interface Layout {
  w: number;
  h: number;
  mac: Box;
  box: Box;
  hub: Box;
  web: Box;
  paths: { mac: string; box: string; web: string };
  locks: Array<{ x: number; y: number }>;
}

const WIDE: Layout = {
  w: 1200,
  h: 520,
  mac: { x: 30, y: 70, w: 260, h: 92 },
  box: { x: 30, y: 358, w: 260, h: 92 },
  hub: { x: 480, y: 196, w: 240, h: 128 },
  web: { x: 830, y: 100, w: 350, h: 320 },
  paths: {
    mac: "M290 116 C 390 116, 380 260, 480 260",
    box: "M290 404 C 390 404, 380 260, 480 260",
    web: "M720 260 C 770 260, 780 260, 830 260",
  },
  locks: [
    { x: 385, y: 188 },
    { x: 385, y: 332 },
  ],
};

const TALL: Layout = {
  w: 360,
  h: 760,
  mac: { x: 6, y: 10, w: 168, h: 96 },
  box: { x: 186, y: 10, w: 168, h: 96 },
  hub: { x: 70, y: 220, w: 220, h: 120 },
  web: { x: 10, y: 430, w: 340, h: 320 },
  paths: {
    mac: "M90 106 C 90 170, 180 150, 180 220",
    box: "M270 106 C 270 170, 180 150, 180 220",
    web: "M180 340 C 180 380, 180 390, 180 430",
  },
  locks: [
    { x: 116, y: 162 },
    { x: 244, y: 162 },
  ],
};

const INBOX = [
  { provider: "claude", title: "Relay reconnect backoff", machine: "MacBook Pro", done: true },
  { provider: "codex", title: "Nightly perf sweep", machine: "build-box", done: false },
  { provider: "copilot", title: "Fix flaky worktree test", machine: "MacBook Pro", done: false },
  { provider: "opencode", title: "Draft v0.1.29 changelog", machine: "build-box", done: true },
];

const POINT_ICONS = [KeyRound, Router, HardDrive, Layers];

function Machine({
  box,
  icon,
  name,
  sub,
  side,
}: {
  box: Box;
  icon: React.ReactNode;
  name: string;
  sub: string;
  side: "mac" | "box";
}) {
  return (
    <div
      data-node={side}
      className="absolute flex items-center gap-3.5 rounded-2xl border border-white/10 bg-raise px-4 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/[0.05] text-ink/80 [&_svg]:size-5">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-medium text-ink">{name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ink/45">{sub}</span>
      </span>
    </div>
  );
}

function Diagram({ L }: { L: Layout }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const fit = inner.current;
    if (!el || !fit) return;
    const ro = new ResizeObserver(([e]) => {
      fit.style.transform = `scale(${e.contentRect.width / L.w})`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [L]);

  /* Packets ride each wire as Web Animations on transform + opacity, which
     run entirely on the compositor (a dashed stroke-dashoffset loop repainted
     the SVG, and re-layerized the page, every frame). Paused off screen. */
  useEffect(() => {
    const root = inner.current;
    if (!root || prefersReducedMotion()) return;
    const STEPS = 36;
    const anims: Animation[] = [];
    (Object.keys(L.paths) as Array<keyof Layout["paths"]>).forEach((k, wire) => {
      const path = root.querySelector<SVGPathElement>(`[data-wire="${k}"]`);
      if (!path) return;
      const len = path.getTotalLength();
      const frames: Keyframe[] = Array.from({ length: STEPS + 1 }, (_, i) => {
        const pt = path.getPointAtLength((len * i) / STEPS);
        const edge = Math.min(i, STEPS - i);
        return { transform: `translate(${pt.x}px, ${pt.y}px)`, opacity: Math.min(1, edge / 4) };
      });
      root.querySelectorAll<HTMLElement>(`[data-packet="${k}"]`).forEach((dot, j) => {
        const duration = k === "web" ? 1600 : 2400;
        anims.push(
          dot.animate(frames, {
            duration,
            iterations: Infinity,
            delay: -((j / 3) * duration + wire * 300),
            easing: "linear",
          }),
        );
      });
    });
    const io = new IntersectionObserver(([e]) =>
      anims.forEach((a) => (e.isIntersecting ? a.play() : a.pause())),
    );
    io.observe(root);
    return () => {
      io.disconnect();
      anims.forEach((a) => a.cancel());
    };
  }, [L]);

  return (
    <div ref={box} className="relative w-full" style={{ aspectRatio: `${L.w} / ${L.h}` }}>
      <div
        ref={inner}
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: L.w, height: L.h }}
      >
        <svg
          className="absolute inset-0 overflow-visible"
          width={L.w}
          height={L.h}
          fill="none"
          aria-hidden
        >
          {(["mac", "box", "web"] as const).map((k) => (
            <g key={k}>
              <path
                data-wire={k}
                d={L.paths[k]}
                stroke="rgba(241,240,236,0.18)"
                strokeWidth="1.5"
              />
            </g>
          ))}
        </svg>

        {/* relay packets: plain dots moved by compositor-only animations */}
        <div data-packets className="absolute inset-0 opacity-0">
          {(["mac", "box", "web"] as const).flatMap((k) =>
            [0, 1, 2].map((j) => (
              <span
                key={`${k}${j}`}
                data-packet={k}
                className="absolute left-0 top-0 -ml-[3.5px] -mt-[3.5px] size-[7px] rounded-full bg-accent shadow-[0_0_10px_2px_rgba(255,92,40,0.55)] will-change-transform"
              />
            )),
          )}
        </div>

        {L.locks.map((p, i) => (
          <span
            key={i}
            data-lock
            className="absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/12 bg-canvas text-ink/70"
            style={{ left: p.x, top: p.y }}
          >
            <Lock className="size-3.5" />
          </span>
        ))}

        <Machine side="mac" box={L.mac} icon={<Laptop />} name="MacBook Pro" sub="Desktop app" />
        <Machine
          side="box"
          box={L.box}
          icon={<Server />}
          name="build-box"
          sub={L === TALL ? "serve --hub" : "ryco serve --hub"}
        />

        {/* the hub */}
        <div
          data-node="hub"
          className="absolute grid place-items-center"
          style={{ left: L.hub.x, top: L.hub.y, width: L.hub.w, height: L.hub.h }}
        >
          {/* pulse rings: HTML boxes, so transform + opacity stay composited */}
          <span
            aria-hidden
            className="ry-pulse pointer-events-none absolute inset-0 rounded-[28px] border border-accent/50"
          />
          <span
            aria-hidden
            className="ry-pulse pointer-events-none absolute inset-0 rounded-[28px] border border-accent/50"
            style={{ animationDelay: "1.2s" }}
          />
          <div className="relative flex h-full w-full flex-col items-center justify-center rounded-[28px] border border-accent/40 bg-[#160c08] shadow-[0_0_0_6px_rgba(255,92,40,0.06),0_30px_80px_-30px_rgba(255,92,40,0.45)]">
            <RycoMark className="h-7 text-accent" />
            <span className="mt-3 text-[15px] font-semibold text-ink">Ryco Cloud</span>
            <span className="mt-0.5 font-mono text-[11.5px] text-ink/50">{SITE.cloudHost}</span>
          </div>
        </div>

        {/* a browser anywhere: one inbox across machines */}
        <div
          data-node="web"
          className="absolute flex flex-col overflow-hidden rounded-2xl border border-white/12 bg-app shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95)]"
          style={{ left: L.web.x, top: L.web.y, width: L.web.w, height: L.web.h }}
        >
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-3.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="mx-auto flex h-6 items-center gap-1.5 rounded-md bg-white/[0.05] px-3 font-mono text-[11px] text-ink/60">
              <Lock className="size-3" /> {SITE.cloudHost}
            </span>
          </div>
          <div className="flex-1 px-3.5 pt-3.5">
            <p className="text-[12px] font-medium text-ink/50">Inbox, all machines</p>
            <div className="mt-2.5 space-y-1.5">
              {INBOX.map((row) => {
                const p = providerById(row.provider);
                return (
                  <div
                    key={row.title}
                    data-inbox
                    className="flex h-[46px] items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 ring-1 ring-inset ring-white/[0.05]"
                  >
                    <BrandIcon
                      name={p.brand}
                      className="size-3.5 shrink-0"
                      style={{ color: p.accent }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-ink/90">{row.title}</span>
                      <span className="block font-mono text-[10.5px] text-ink/40">
                        {row.machine}
                      </span>
                    </span>
                    {row.done ? (
                      <Check className="size-3.5 shrink-0 text-[#5fcf86]" />
                    ) : (
                      <Spinner className="size-3.5 shrink-0 text-ink/50" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex h-10 shrink-0 items-center gap-2 border-t border-white/[0.06] px-3.5 text-[11.5px] text-ink/50">
            <Network className="size-3.5 text-accent" /> Relayed live from your machines, stored
            nowhere
          </div>
        </div>
      </div>
    </div>
  );
}

export function Cloud() {
  /* the wide canvas would shrink below readable sizes under 1024px */
  const narrow = useMediaQuery("(max-width: 1023px)");
  const L = narrow ? TALL : WIDE;

  const scope = useGsap<HTMLElement>(
    (root) => {
      revealText(root.querySelector("[data-cloud-title]")!, { by: "chars", widen: true });
      revealText(root.querySelector("[data-cloud-sub]")!, { delay: 0.15 });
      revealUp(root.querySelectorAll("[data-point]"), root.querySelector("[data-points]")!, {
        stagger: 0.08,
      });
      revealUp(root.querySelectorAll("[data-cloud-cta]"), root.querySelector("[data-points]")!, {
        stagger: 0.08,
      });

      const diagram = root.querySelector<HTMLElement>("[data-diagram]")!;
      const node = (k: string) => root.querySelector<HTMLElement>(`[data-node="${k}"]`)!;
      const wire = (k: string) => root.querySelector<SVGPathElement>(`[data-wire="${k}"]`)!;
      const packets = root.querySelector<HTMLElement>("[data-packets]")!;

      const tl = gsap.timeline({
        defaults: { ease: "ryco" },
        scrollTrigger: {
          trigger: diagram,
          start: "top 80%",
          end: narrow ? "bottom 85%" : "center 45%",
          scrub: 0.8,
        },
      });
      tl.from([node("mac"), node("box")], {
        autoAlpha: 0,
        x: narrow ? 0 : -40,
        y: narrow ? -20 : 0,
        duration: 0.6,
        stagger: 0.12,
      })
        .fromTo(
          [wire("mac"), wire("box")],
          { drawSVG: "0%" },
          { drawSVG: "100%", duration: 0.8, ease: "power2.inOut" },
          0.35,
        )
        .from(
          root.querySelectorAll("[data-lock]"),
          { scale: 0, autoAlpha: 0, duration: 0.35, stagger: 0.1, ease: "back.out(3)" },
          0.8,
        )
        .from(node("hub"), { autoAlpha: 0, scale: 0.7, duration: 0.6, ease: "back.out(1.6)" }, 0.9)
        .fromTo(
          wire("web"),
          { drawSVG: "0%" },
          { drawSVG: "100%", duration: 0.5, ease: "power2.inOut" },
          1.35,
        )
        .from(
          node("web"),
          { autoAlpha: 0, x: narrow ? 0 : 50, y: narrow ? 30 : 0, duration: 0.7 },
          1.6,
        )
        .from(
          root.querySelectorAll("[data-inbox]"),
          { autoAlpha: 0, x: (i) => (i % 2 ? 24 : -24), duration: 0.45, stagger: 0.12 },
          1.9,
        )
        .to(packets, { opacity: 1, duration: 0.4 }, 2.2);
    },
    [narrow],
  );

  return (
    <section
      ref={scope}
      id="cloud"
      aria-labelledby="cloud-title"
      className="relative overflow-hidden py-28 sm:py-40"
    >
      {/* a lifted band so Cloud reads as its own chapter, same theme */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[42%] -z-10 h-[60%] w-[80%] -translate-x-1/2 opacity-70"
        style={{ background: "radial-gradient(closest-side, rgba(255,92,40,0.12), transparent)" }}
      />

      <div className={SECTION_X}>
        <p className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/[0.07] py-1 pl-1 pr-3.5 text-[13px] text-ink/85">
          <span className="rounded-full bg-accent px-2 py-0.5 text-[11.5px] font-semibold text-accent-ink">
            New
          </span>
          Ryco Cloud is optional, and free for now
        </p>
        <h2
          id="cloud-title"
          data-cloud-title
          className="mt-7 max-w-[13ch] font-display text-[clamp(2.6rem,7vw,6.6rem)] font-bold leading-[0.93] tracking-[-0.04em]"
        >
          Your machines, from anywhere<span className="text-accent">.</span>
        </h2>
        <p data-cloud-sub className="mt-6 max-w-[50ch] text-[17px] leading-relaxed text-ink/60">
          Connect the machines you already run Ryco on, then pick up any thread from a browser at{" "}
          <span className="font-mono text-[15px] text-ink/85">{SITE.cloudHost}</span>. Your code
          stays on your machines.
        </p>

        <div
          data-diagram
          data-loops
          className={cn("mx-auto mt-16 sm:mt-20", narrow ? "max-w-[460px]" : "max-w-[1200px]")}
        >
          <Diagram L={L} />
        </div>

        <ul
          data-points
          className="mt-16 grid gap-x-8 gap-y-10 sm:mt-24 sm:grid-cols-2 lg:grid-cols-4"
        >
          {CLOUD.points.map((pt, i) => {
            const Icon = POINT_ICONS[i];
            return (
              <li key={pt.title} data-point className="border-t border-white/12 pt-5">
                <Icon className="size-5 text-accent" strokeWidth={1.75} />
                <h3 className="mt-4 font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">
                  {pt.title}
                </h3>
                <p className="mt-1.5 text-[14.5px] leading-snug text-ink/55">{pt.body}</p>
              </li>
            );
          })}
        </ul>

        <div className="mt-14 grid gap-10 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:gap-16">
          <div data-cloud-cta>
            <Button href={SITE.cloud} external icon={<ArrowUpRight />}>
              Open Ryco Cloud
            </Button>
          </div>
          <div data-cloud-cta className="text-[14.5px] leading-snug text-ink/60">
            <p>
              In the desktop app, click <span className="text-ink/85">Connect Ryco account</span>.
              On a server or a headless box, start Ryco with the relay on, then link the machine to
              your account:
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <CopyCommand command={CLOUD.serve} />
              <CopyCommand command={CLOUD.link} />
            </div>
            <p className="mt-3 text-[13.5px] text-ink/55">
              No password on your account? Run <span className="font-mono">hub enroll</span> instead
              and approve the code in Cloud.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
