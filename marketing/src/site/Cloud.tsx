/**
 * Ryco Cloud (the hosted Hub at app.ryco.space): optional, free during an
 * invite-only beta, for a limited number of devices per account.
 *
 * The diagram is a scaled design canvas like the Stage: machines dial *out*
 * to the hub (no inbound ports), the hub relays encrypted channels to a
 * browser and to the coming iPhone app, and threads from both machines land in
 * one inbox, each tagged with where it runs. Scroll draws the network; once
 * live, packets keep flowing.
 */
import { useEffect, useRef } from "react";
import {
  ArrowUpRight,
  BellRing,
  Check,
  Gift,
  HardDrive,
  KeyRound,
  Laptop,
  Lock,
  LogIn,
  Network,
  Router,
  Server,
  ShieldCheck,
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
type Wire = "mac" | "box" | "web" | "phone";
const WIRES: Wire[] = ["mac", "box", "web", "phone"];

interface Layout {
  w: number;
  h: number;
  mac: Box;
  box: Box;
  hub: Box;
  web: Box;
  phone: Box;
  paths: Record<Wire, string>;
  /** one lock at the midpoint of every wire: every hop runs over TLS (the
   *  payload inside is end-to-end encrypted only when both ends support it) */
  locks: Array<{ x: number; y: number }>;
}

const WIDE: Layout = {
  w: 1200,
  h: 560,
  mac: { x: 30, y: 70, w: 260, h: 92 },
  box: { x: 30, y: 398, w: 260, h: 92 },
  hub: { x: 450, y: 216, w: 240, h: 128 },
  web: { x: 770, y: 40, w: 330, h: 300 },
  phone: { x: 1030, y: 250, w: 150, h: 270 },
  paths: {
    mac: "M290 116 C 370 116, 370 280, 450 280",
    box: "M290 444 C 370 444, 370 280, 450 280",
    web: "M690 250 C 730 250, 730 190, 770 190",
    phone: "M690 310 C 760 330, 840 460, 1030 460",
  },
  locks: [
    { x: 370, y: 198 },
    { x: 370, y: 362 },
    { x: 730, y: 220 },
    { x: 815, y: 393 },
  ],
};

const TALL: Layout = {
  w: 360,
  h: 820,
  mac: { x: 6, y: 10, w: 168, h: 96 },
  box: { x: 186, y: 10, w: 168, h: 96 },
  hub: { x: 70, y: 210, w: 220, h: 120 },
  web: { x: 6, y: 440, w: 224, h: 290 },
  phone: { x: 210, y: 506, w: 144, h: 264 },
  paths: {
    mac: "M90 106 C 90 160, 180 150, 180 210",
    box: "M270 106 C 270 160, 180 150, 180 210",
    web: "M150 330 C 150 380, 118 390, 118 440",
    phone: "M210 330 C 210 400, 282 430, 282 506",
  },
  locks: [
    { x: 135, y: 156 },
    { x: 225, y: 156 },
    { x: 133, y: 385 },
    { x: 246, y: 418 },
  ],
};

const INBOX = [
  { provider: "claude", title: "Relay reconnect backoff", machine: "MacBook Pro", done: true },
  { provider: "codex", title: "Nightly perf sweep", machine: "build-box", done: false },
  { provider: "copilot", title: "Fix flaky worktree test", machine: "MacBook Pro", done: false },
  { provider: "opencode", title: "Changelog for v0.1.37", machine: "build-box", done: true },
];

const POINT_ICONS = [Gift, KeyRound, ShieldCheck, Router, HardDrive, BellRing];

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

/** The coming iPhone app: the same inbox, in a pocket. */
function Phone({ box }: { box: Box }) {
  return (
    <div
      data-node="phone"
      className="absolute"
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <span className="absolute -right-2 -top-3 z-10 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-ink shadow-[0_6px_16px_-6px_rgba(255,92,40,0.7)]">
        Soon
      </span>
      <div className="flex h-full flex-col overflow-hidden rounded-[30px] border-[5px] border-[#050505] bg-app shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95)] ring-1 ring-white/15">
        <div className="relative flex h-8 shrink-0 items-center justify-between px-4 text-[9.5px] font-semibold text-ink/80">
          <span>9:41</span>
          <span className="absolute left-1/2 top-1.5 h-[18px] w-[52px] -translate-x-1/2 rounded-full bg-black" />
          <span className="flex gap-0.5">
            <span className="h-2 w-0.5 rounded-full bg-ink/70" />
            <span className="h-2 w-0.5 rounded-full bg-ink/70" />
            <span className="h-2 w-0.5 rounded-full bg-ink/40" />
          </span>
        </div>
        <p className="px-3 pt-1 text-[14px] font-semibold text-ink">Inbox</p>
        <div className="mt-2 space-y-1 px-2">
          {[INBOX[1], INBOX[2], INBOX[0]].map((row) => {
            const p = providerById(row.provider);
            return (
              <div
                key={row.title}
                data-phone-row
                className="flex h-[38px] items-center gap-2 rounded-[10px] bg-white/[0.035] px-2"
              >
                <BrandIcon name={p.brand} className="size-3 shrink-0" style={{ color: p.accent }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10.5px] text-ink/90">{row.title}</span>
                  <span className="block truncate font-mono text-[8.5px] text-ink/40">
                    {row.machine}
                  </span>
                </span>
                {row.done ? (
                  <Check className="size-3 shrink-0 text-[#5fcf86]" />
                ) : (
                  <Spinner className="size-3 shrink-0 text-ink/50" />
                )}
              </div>
            );
          })}
        </div>
        <div className="mx-2 mb-2 mt-auto flex h-8 items-center rounded-full bg-white/[0.05] px-3 text-[10px] text-ink/40 ring-1 ring-inset ring-white/[0.06]">
          Message…
        </div>
      </div>
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
    WIRES.forEach((k, wire) => {
      const path = root.querySelector<SVGPathElement>(`[data-wire="${k}"]`);
      if (!path) return;
      const len = path.getTotalLength();
      const frames: Keyframe[] = Array.from({ length: STEPS + 1 }, (_, i) => {
        const pt = path.getPointAtLength((len * i) / STEPS);
        const edge = Math.min(i, STEPS - i);
        return { transform: `translate(${pt.x}px, ${pt.y}px)`, opacity: Math.min(1, edge / 4) };
      });
      root.querySelectorAll<HTMLElement>(`[data-packet="${k}"]`).forEach((dot, j) => {
        const duration = k === "web" || k === "phone" ? 1600 : 2400;
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
          {WIRES.map((k) => (
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
          {WIRES.flatMap((k) =>
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
        <Machine side="box" box={L.box} icon={<Server />} name="build-box" sub="ryco service" />

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
              {INBOX.slice(0, 3).map((row) => {
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
            <Network className="size-3.5 shrink-0 text-accent" /> Relayed live from your machines
          </div>
        </div>

        <Phone box={L.phone} />
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
        .fromTo(
          wire("phone"),
          { drawSVG: "0%" },
          { drawSVG: "100%", duration: 0.6, ease: "power2.inOut" },
          1.7,
        )
        .from(
          node("phone"),
          { autoAlpha: 0, y: narrow ? 40 : 60, rotate: narrow ? 0 : 6, duration: 0.8 },
          2.05,
        )
        .from(
          root.querySelectorAll("[data-phone-row]"),
          { autoAlpha: 0, y: 10, duration: 0.4, stagger: 0.1 },
          2.4,
        )
        .to(packets, { opacity: 1, duration: 0.4 }, 2.6);
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
          {CLOUD.badge}
        </p>
        <h2
          id="cloud-title"
          data-cloud-title
          className="mt-7 max-w-[13ch] font-display text-[clamp(2.6rem,7vw,6.6rem)] font-bold leading-[0.93] tracking-[-0.04em]"
        >
          Your machines, from anywhere<span className="text-accent">.</span>
        </h2>
        <p data-cloud-sub className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-ink/60">
          Connect the machines you already run Ryco on, then pick up any thread from a browser at{" "}
          <span className="font-mono text-[15px] text-ink/85">{SITE.cloudHost}</span>, and soon from
          your phone. It's optional, free during the beta, and your code stays on your machines.
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
          className="mt-16 grid gap-x-8 gap-y-10 sm:mt-24 sm:grid-cols-2 lg:grid-cols-3"
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
            <div className="flex flex-wrap gap-3">
              <Button href={SITE.cloudRequestAccess} external icon={<ArrowUpRight />}>
                Request access
              </Button>
              <Button href={SITE.cloud} external variant="ghost" icon={<LogIn />}>
                Sign in
              </Button>
            </div>
            <p className="mt-4 max-w-[34ch] text-[13.5px] leading-snug text-ink/50">
              Cloud is invite-only while it's in beta. Ask in the Discord and we'll send you an
              invite.
            </p>
          </div>
          <div data-cloud-cta className="text-[14.5px] leading-snug text-ink/60">
            <p>
              In the desktop app, click <span className="text-ink/85">Connect Ryco account</span>.
              On a server or a headless box, the guided setup installs the background service and
              links the machine to your account. A machine that's already running links on its own:
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <CopyCommand command={CLOUD.setup} />
              <CopyCommand command={CLOUD.link} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
