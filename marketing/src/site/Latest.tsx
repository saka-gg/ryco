/**
 * What's new: the latest releases at a glance. Five live micro-demos of the
 * headline features (goals and the follow-up queue, Ship with pull request
 * watching, update everything, alerts, speed) and a marquee of the rest.
 *
 * The markup renders each demo's settled frame, which is what reduced motion
 * shows. With motion on, each setup rewinds its demo to the start and loops it
 * only while the cell is on screen; text swaps write straight into the DOM.
 */
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  CornerDownRight,
  GitPullRequest,
  Laptop,
  Rocket,
  SendHorizontal,
  Server,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { BrandIcon } from "@/assets/brands";
import { RycoMark } from "@/assets/RycoLogo";
import { CHANGELOG_RELEASES } from "@/data/changelog";
import { LATEST_MORE } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, useGsap } from "@/lib/motion";
import { Spinner } from "./stage/Stage";
import { setText, whileVisible } from "./ui/loops";
import { revealText, revealUp } from "./ui/reveal";
import { focusRing, SECTION_X } from "./theme";

const OK = "text-[#5fcf86]";
const BAD = "text-[#f0686a]";

/** Three stacked glyphs in one slot: spinner, check, cross. A demo shows one. */
function StatusSlot({ name, settled = "ok" }: { name: string; settled?: "ok" | "spin" | "bad" }) {
  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <span
        data-slot-spin={name}
        className={cn("absolute grid place-items-center", settled !== "spin" && "opacity-0")}
      >
        <Spinner className="size-3.5 text-ink/50" />
      </span>
      <Check
        data-slot-ok={name}
        strokeWidth={2.5}
        className={cn("absolute size-3.5", OK, settled !== "ok" && "opacity-0")}
      />
      <X
        data-slot-bad={name}
        strokeWidth={2.5}
        className={cn("absolute size-3.5", BAD, settled !== "bad" && "opacity-0")}
      />
    </span>
  );
}

/** Tween one StatusSlot to a state at `at` on `tl`. */
function slotTo(
  tl: gsap.core.Timeline,
  cell: HTMLElement,
  name: string,
  state: "ok" | "spin" | "bad",
  at: number | string,
) {
  const q = (k: string) => cell.querySelector(`[data-slot-${k}="${name}"]`);
  const on = q(state);
  const off = (["spin", "ok", "bad"] as const).filter((k) => k !== state).map(q);
  tl.to(off, { opacity: 0, scale: 0.6, duration: 0.2 }, at).fromTo(
    on,
    { opacity: 0, scale: 0.4 },
    { opacity: 1, scale: 1, duration: state === "spin" ? 0.2 : 0.45, ease: "back.out(2.6)" },
    at,
  );
}

/** Resets every slot in `cell` to a spinner, invisibly. */
function slotsToSpin(cell: HTMLElement) {
  gsap.set(cell.querySelectorAll("[data-slot-ok], [data-slot-bad]"), { opacity: 0 });
  gsap.set(cell.querySelectorAll("[data-slot-spin]"), { opacity: 1, scale: 1 });
}

/* ------------------------------- goal + queue ------------------------------ */

const TURNS = [
  { title: "Fix the lint error in relay/backoff.ts", meta: "Turn 1 · 2 files" },
  { title: "Update the reconnect snapshot test", meta: "Turn 2 · 1 file" },
  { title: "All 6 checks pass on #1104", meta: "Turn 3 · CI" },
];
const QUEUE = ["Then bump the changelog", "Ask for a review"];

function GoalQueue() {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="rounded-2xl bg-app p-4 ring-1 ring-inset ring-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
            <Target className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink/40">
              Goal
            </span>
            <span className="block truncate text-[13.5px] text-ink/90">Make CI green on #1104</span>
          </span>
          <span
            data-goal-chip
            className="relative isolate inline-grid h-6 shrink-0 place-items-center overflow-hidden rounded-full px-2.5 text-[11.5px] font-medium"
          >
            <span
              data-goal-working
              className="col-start-1 row-start-1 flex items-center gap-1.5 text-ink/60 opacity-0"
            >
              <Spinner className="size-3" /> Working
            </span>
            <span
              data-goal-done
              className={cn("col-start-1 row-start-1 flex items-center gap-1", OK)}
            >
              <Check className="size-3" strokeWidth={2.5} /> Complete
            </span>
            <span
              data-goal-bg
              aria-hidden
              className="absolute inset-0 -z-10 rounded-full bg-[#5fcf86]/12"
            />
          </span>
        </div>
        <ul className="mt-4 space-y-1.5">
          {TURNS.map((t, i) => (
            <li
              key={t.title}
              data-turn
              className="flex h-[46px] items-center gap-3 rounded-xl bg-white/[0.03] px-3 ring-1 ring-inset ring-white/[0.04]"
            >
              <StatusSlot name={`turn${i}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink/85">{t.title}</span>
                <span className="block font-mono text-[10.5px] text-ink/40">{t.meta}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col rounded-2xl bg-app p-4 ring-1 ring-inset ring-white/[0.06]">
        <p className="flex items-center justify-between text-[11.5px] font-medium text-ink/50">
          <span>Follow-up queue</span>
          <span
            data-queue-count
            className="grid h-5 min-w-5 place-items-center rounded-full bg-white/[0.06] px-1.5 font-mono text-[10.5px] text-ink/70"
          >
            1
          </span>
        </p>
        <ul className="relative mt-3 flex-1 space-y-1.5">
          {QUEUE.map((q, i) => (
            <li
              key={q}
              data-q
              /* settled frame: the first follow-up has gone out, the second moved up */
              style={i === 1 ? { transform: "translateY(-46px)" } : undefined}
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg border border-dashed border-white/[0.12] px-2.5",
                i === 0 && "opacity-0",
              )}
            >
              <CornerDownRight className="size-3.5 shrink-0 text-ink/40" />
              <span className="truncate text-[12px] text-ink/75">{q}</span>
            </li>
          ))}
        </ul>
        <div
          data-composer
          className="mt-3 flex h-10 items-center gap-2 rounded-xl bg-white/[0.04] px-3 ring-1 ring-inset ring-white/[0.06]"
        >
          <span data-composer-text className="flex-1 truncate text-[12px] text-ink/80">
            Then bump the changelog
          </span>
          <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-ink">
            <SendHorizontal className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}

function setupGoal(cell: HTMLElement) {
  const turns = cell.querySelectorAll<HTMLElement>("[data-turn]");
  const chips = cell.querySelectorAll<HTMLElement>("[data-q]");
  const count = cell.querySelector<HTMLElement>("[data-queue-count]")!;
  const composer = cell.querySelector<HTMLElement>("[data-composer]")!;
  const composerText = cell.querySelector<HTMLElement>("[data-composer-text]")!;
  const working = cell.querySelector("[data-goal-working]");
  const done = cell.querySelector("[data-goal-done]");
  const goalBg = cell.querySelector("[data-goal-bg]");

  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.6 });
  tl.call(() => {
    slotsToSpin(cell);
    setText(count, "2");
    setText(composerText, "Message the thread…");
  })
    .set(turns, { autoAlpha: 0, y: 10 })
    .set(chips, { autoAlpha: 1, y: 0, x: 0 })
    .set(working, { opacity: 1, y: 0 })
    .set(done, { opacity: 0, y: 10 })
    .set(goalBg, { opacity: 0 })
    .set(composerText, { opacity: 0.45 });

  const beat = 1.05;
  TURNS.forEach((_, i) => {
    const at = 0.3 + i * beat;
    tl.to(turns[i], { autoAlpha: 1, y: 0, duration: 0.5 }, at);
    slotTo(tl, cell, `turn${i}`, "ok", at + 0.75);
  });
  const end = 0.3 + TURNS.length * beat;
  tl.to(working, { opacity: 0, y: -10, duration: 0.3 }, end)
    .to(done, { opacity: 1, y: 0, duration: 0.45, ease: "back.out(2)" }, end)
    .to(goalBg, { opacity: 1, duration: 0.4 }, end)
    /* the goal is met, so the node sends the first queued follow-up */
    .to(chips[0], { y: 92, autoAlpha: 0, duration: 0.6, ease: "ryco.inOut" }, end + 0.55)
    .to(chips[1], { y: -46, duration: 0.6 }, end + 0.75)
    .call(() => setText(count, "1"), [], end + 0.75)
    .call(() => setText(composerText, QUEUE[0]), [], end + 0.95)
    .to(composerText, { opacity: 1, duration: 0.2 }, end + 0.95)
    .fromTo(
      composer,
      { boxShadow: "0 0 0 0 rgba(255,92,40,0)" },
      { boxShadow: "0 0 0 3px rgba(255,92,40,0.35)", duration: 0.25, yoyo: true, repeat: 1 },
      end + 0.95,
    )
    /* hold the settled frame, then fade out for the next round */
    .to(turns, { autoAlpha: 0, duration: 0.4, stagger: 0.05 }, end + 3.4)
    .to(chips[1], { autoAlpha: 0, duration: 0.3 }, end + 3.4);
  return whileVisible(cell, tl);
}

/* -------------------------------- ship + watch ----------------------------- */

const CHECKS = ["lint", "test (ubuntu)", "build"];
const SHIP_STEPS = ["Committing…", "Pushing…", "Opening PR…", "Shipped"];

function ShipWatch() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span
          data-ship-btn
          className="inline-flex h-9 items-center gap-2 rounded-full bg-accent pl-3 pr-4 text-[13px] font-semibold text-accent-ink shadow-[0_10px_30px_-10px_rgba(255,92,40,0.6)]"
        >
          <Rocket className="size-4" />
          <span data-ship-label>Shipped</span>
        </span>
        <span className="truncate font-mono text-[11px] text-ink/45">feat/relay-backoff</span>
      </div>

      <div
        data-pr
        className="flex items-center gap-2.5 rounded-xl bg-app px-3 py-2.5 ring-1 ring-inset ring-white/[0.06]"
      >
        <GitPullRequest className={cn("size-4 shrink-0", OK)} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink/85">
          <span className="font-mono text-ink/50">#1104</span> Relay reconnect backoff
        </span>
        <span className="rounded-full bg-[#5fcf86]/12 px-2 py-0.5 text-[10.5px] font-medium text-[#5fcf86]">
          Open
        </span>
      </div>

      <ul className="space-y-1">
        {CHECKS.map((c, i) => (
          <li key={c} data-check className="flex h-7 items-center gap-2.5 px-1 text-[12px]">
            <StatusSlot name={`check${i}`} />
            <span className="font-mono text-ink/65">{c}</span>
          </li>
        ))}
      </ul>

      <div
        data-autofix
        className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11.5px] text-ink/60 ring-1 ring-inset ring-white/[0.05]"
      >
        <Sparkles className="size-3.5 shrink-0 text-accent" />
        <span className="font-medium text-ink/80">Auto-fix CI</span>
        <span data-autofix-text className="truncate">
          All checks passing
        </span>
      </div>
    </div>
  );
}

function setupShip(cell: HTMLElement) {
  const btn = cell.querySelector<HTMLElement>("[data-ship-btn]")!;
  const label = cell.querySelector<HTMLElement>("[data-ship-label]")!;
  const pr = cell.querySelector<HTMLElement>("[data-pr]")!;
  const checks = cell.querySelectorAll<HTMLElement>("[data-check]");
  const fix = cell.querySelector<HTMLElement>("[data-autofix]")!;
  const fixText = cell.querySelector<HTMLElement>("[data-autofix-text]")!;

  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.4 });
  tl.call(() => {
    slotsToSpin(cell);
    setText(label, "Ship");
    setText(fixText, "Watching #1104");
  })
    .set(pr, { autoAlpha: 0, y: 10 })
    .set(checks, { autoAlpha: 0, x: -8 })
    .set(fix, { autoAlpha: 0.5 });

  tl.to(btn, { scale: 0.93, duration: 0.12, ease: "power2.in" }, 0.6).to(
    btn,
    { scale: 1, duration: 0.5, ease: "back.out(3)" },
    0.72,
  );
  SHIP_STEPS.forEach((step, i) => {
    tl.call(() => setText(label, step), [], 0.75 + i * 0.55);
  });
  tl.to(pr, { autoAlpha: 1, y: 0, duration: 0.5 }, 2.4)
    .to(checks, { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.08 }, 2.6)
    .to(fix, { autoAlpha: 1, duration: 0.3 }, 2.6);
  slotTo(tl, cell, "check0", "ok", 3.3);
  slotTo(tl, cell, "check1", "bad", 3.7);
  tl.call(() => setText(fixText, "Fixing test (ubuntu)…"), [], 4.0).fromTo(
    fix,
    { boxShadow: "inset 0 0 0 1px rgba(255,92,40,0)" },
    { boxShadow: "inset 0 0 0 1px rgba(255,92,40,0.55)", duration: 0.3, yoyo: true, repeat: 3 },
    4.0,
  );
  tl.call(() => setText(fixText, "Fix pushed"), [], 5.3);
  slotTo(tl, cell, "check1", "spin", 5.3);
  slotTo(tl, cell, "check1", "ok", 6.0);
  slotTo(tl, cell, "check2", "ok", 6.25);
  tl.call(() => setText(fixText, "All checks passing"), [], 6.5)
    .to([pr, checks], { autoAlpha: 0, duration: 0.4 }, 9.2)
    .to(fix, { autoAlpha: 0.5, duration: 0.4 }, 9.2);
  return whileVisible(cell, tl);
}

/* ------------------------------ update everything -------------------------- */

const UPDATES = [
  { name: "MacBook Pro", what: "Ryco 0.1.36 → 0.1.37", icon: <Laptop /> },
  { name: "build-box", what: "Node 0.1.36 → 0.1.37", icon: <Server /> },
  { name: "Claude Code", what: "CLI update", brand: "anthropic" as const, color: "#d97757" },
  { name: "Codex", what: "CLI update", brand: "openai" as const, color: "#e8e8e6" },
];

function UpdateAll() {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span data-up-head className="text-[12px] font-medium text-ink/55">
          Everything is up to date
        </span>
        <span
          data-up-btn
          className="inline-flex h-8 items-center rounded-full bg-white/[0.08] px-3.5 text-[12px] font-medium text-ink ring-1 ring-inset ring-white/[0.1]"
        >
          Update everything
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {UPDATES.map((u, i) => (
          <li
            key={u.name}
            className="relative overflow-hidden rounded-xl bg-app px-3 py-2.5 ring-1 ring-inset ring-white/[0.05]"
          >
            <span
              data-up-bar
              aria-hidden
              className="absolute inset-y-0 left-0 w-full origin-left bg-accent/[0.08]"
            />
            <span className="relative flex items-center gap-2.5">
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white/[0.05] text-ink/70 [&_svg]:size-3.5">
                {u.brand ? <BrandIcon name={u.brand} style={{ color: u.color }} /> : u.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink/85">{u.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-ink/40">{u.what}</span>
              </span>
              <StatusSlot name={`up${i}`} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function setupUpdates(cell: HTMLElement) {
  const head = cell.querySelector<HTMLElement>("[data-up-head]")!;
  const btn = cell.querySelector<HTMLElement>("[data-up-btn]")!;
  const bars = cell.querySelectorAll<HTMLElement>("[data-up-bar]");

  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.4 });
  tl.call(() => {
    gsap.set(cell.querySelectorAll("[data-slot-spin], [data-slot-ok], [data-slot-bad]"), {
      opacity: 0,
    });
    setText(head, "4 updates available");
  }).set(bars, { scaleX: 0 });

  tl.to(btn, { scale: 0.93, duration: 0.12, ease: "power2.in" }, 0.7)
    .to(btn, { scale: 1, duration: 0.5, ease: "back.out(3)" }, 0.82)
    .call(() => setText(head, "Updating 4 of 4…"), [], 0.85);
  UPDATES.forEach((_, i) => {
    const at = 0.9 + i * 0.35;
    slotTo(tl, cell, `up${i}`, "spin", at);
    tl.to(bars[i], { scaleX: 1, duration: 1.3, ease: "power1.inOut" }, at);
    slotTo(tl, cell, `up${i}`, "ok", at + 1.3);
  });
  tl.call(() => setText(head, "Everything is up to date"), [], 3.4).to(
    bars,
    { opacity: 0, duration: 0.5 },
    6,
  );
  tl.set(bars, { opacity: 1 }, 6.6);
  return whileVisible(cell, tl);
}

/* ---------------------------------- alerts --------------------------------- */

function Alerts() {
  return (
    <div className="relative mx-auto h-[262px] w-full max-w-[320px] overflow-hidden rounded-t-[38px] bg-[linear-gradient(160deg,#1d1310_0%,#0e0d0f_55%)] ring-1 ring-inset ring-white/[0.09]">
      {/* the Dynamic Island, which grows into a Live Activity */}
      <div
        data-island
        className="absolute left-1/2 top-3 flex h-[64px] w-[268px] -translate-x-1/2 items-center justify-between overflow-hidden rounded-[30px] bg-black px-4"
      >
        <span data-island-in className="flex items-center gap-2">
          <RycoMark className="h-4 text-accent" />
          <span className="text-[12px] text-ink/85">
            <span className="block leading-tight">2 working</span>
            <span className="block text-[10.5px] leading-tight text-ink/45">Ryco agents</span>
          </span>
        </span>
        <span data-island-in className="flex items-center gap-1.5 text-[12px] text-ink/85">
          <span className="size-2 rounded-full bg-accent shadow-[0_0_8px_rgba(255,92,40,0.8)]" />1
          needs you
        </span>
      </div>
      <p className="mt-[92px] text-center font-display text-[52px] font-semibold leading-none text-ink/90">
        9:41
      </p>
      <div
        data-note
        className="absolute inset-x-3 bottom-4 flex gap-3 rounded-[20px] bg-white/[0.09] p-3 backdrop-blur-md ring-1 ring-inset ring-white/[0.08]"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[#0c0c0d] ring-1 ring-white/10">
          <RycoMark className="h-4 text-ink" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between text-[11.5px] text-ink/55">
            <span>Ryco · build-box</span>
            <span>now</span>
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] font-medium text-ink/90">
            Relay reconnect backoff
          </span>
          <span className="block truncate text-[12px] text-ink/60">Claude needs your approval</span>
        </span>
      </div>
    </div>
  );
}

function setupAlerts(cell: HTMLElement) {
  const island = cell.querySelector<HTMLElement>("[data-island]")!;
  const inside = cell.querySelectorAll<HTMLElement>("[data-island-in]");
  const note = cell.querySelector<HTMLElement>("[data-note]")!;

  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.3 });
  tl.set(island, { width: 112, height: 34, borderRadius: 17 })
    .set(inside, { autoAlpha: 0 })
    .set(note, { autoAlpha: 0, y: 30, scale: 0.96 });
  tl.to(
    island,
    { width: 268, height: 64, borderRadius: 30, duration: 0.8, ease: "back.out(1.4)" },
    0.6,
  )
    .to(inside, { autoAlpha: 1, duration: 0.35, stagger: 0.08 }, 0.95)
    .to(note, { autoAlpha: 1, y: 0, scale: 1, duration: 0.7, ease: "back.out(1.6)" }, 1.9)
    .to(note, { autoAlpha: 0, y: 16, duration: 0.45, ease: "power2.in" }, 5.4)
    .to(inside, { autoAlpha: 0, duration: 0.25 }, 5.6)
    .to(
      island,
      { width: 112, height: 34, borderRadius: 17, duration: 0.6, ease: "ryco.inOut" },
      5.75,
    );
  return whileVisible(cell, tl);
}

/* ---------------------------------- speed ---------------------------------- */

const SPEED = [
  { value: 10, unit: "×", label: "faster code highlighting", now: 0.1 },
  { value: 1, unit: " ms", label: "to update a long streaming answer", from: 17, now: 0.07 },
  { value: 50, unit: "%", prefix: "−", label: "less live streaming traffic", now: 0.5 },
];

function Speed() {
  return (
    <div>
      <ul className="space-y-5">
        {SPEED.map((s) => (
          <li key={s.label} data-speed>
            <p className="flex items-baseline gap-2">
              <span className="font-display text-[34px] font-bold leading-none tracking-[-0.03em] text-ink">
                {s.prefix}
                <span data-speed-n>{s.value}</span>
                {s.unit}
              </span>
              <span className="text-[12.5px] leading-snug text-ink/50">{s.label}</span>
            </p>
            <span className="mt-2.5 block h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <span
                data-speed-bar
                className="block h-full origin-left rounded-full bg-accent"
                style={{ transform: `scaleX(${s.now})` }}
              />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11.5px] text-ink/35">Bars: time and traffic against last month.</p>
    </div>
  );
}

function setupSpeed(cell: HTMLElement) {
  const rows = cell.querySelectorAll<HTMLElement>("[data-speed]");
  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 2.4 });
  rows.forEach((row, i) => {
    const s = SPEED[i];
    const n = row.querySelector<HTMLElement>("[data-speed-n]")!;
    const bar = row.querySelector<HTMLElement>("[data-speed-bar]")!;
    const from = s.from ?? (s.unit === "×" ? 1 : 0);
    const proxy = { v: from };
    const at = 0.3 + i * 0.25;
    tl.set(bar, { scaleX: 1 }, 0)
      .call(() => setText(n, String(from)), [], 0)
      .to(bar, { scaleX: s.now, duration: 1.6, ease: "expo.inOut" }, at)
      .fromTo(
        proxy,
        { v: from },
        {
          v: s.value,
          duration: 1.6,
          ease: "expo.inOut",
          onUpdate: () => setText(n, String(Math.round(proxy.v))),
        },
        at,
      );
  });
  return whileVisible(cell, tl);
}

/* ---------------------------------- layout --------------------------------- */

function Cell({
  className,
  title,
  body,
  children,
  demo,
}: {
  className?: string;
  title: string;
  body: string;
  children: React.ReactNode;
  demo: string;
}) {
  return (
    <article
      data-cell={demo}
      className={cn(
        "relative flex flex-col overflow-hidden rounded-[22px] bg-raise p-5 ring-1 ring-inset ring-white/[0.07] sm:p-7",
        className,
      )}
    >
      <div className="flex-1">{children}</div>
      <div className="mt-6">
        <h3 className="font-display text-[20px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h3>
        <p className="mt-1.5 max-w-[50ch] text-[14.5px] leading-snug text-ink/55">{body}</p>
      </div>
    </article>
  );
}

function Marquee({ items, reverse }: { items: readonly string[]; reverse?: boolean }) {
  const row = (copy: number) => (
    <ul
      aria-hidden={copy > 0}
      className={cn("flex shrink-0 gap-2.5 pr-2.5", copy > 0 && "motion-reduce:hidden")}
    >
      {items.map((t) => (
        <li
          key={t}
          className="whitespace-nowrap rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-[13.5px] text-ink/70"
        >
          {t}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="group/mq flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)] motion-reduce:[mask-image:none]">
      <div
        className={cn(
          "flex w-max motion-reduce:w-full motion-reduce:flex-wrap",
          reverse ? "ry-marquee-rev" : "ry-marquee",
          "group-hover/mq:[animation-play-state:paused]",
        )}
      >
        {row(0)}
        {row(1)}
      </div>
    </div>
  );
}

export function Latest() {
  const latest = CHANGELOG_RELEASES[0];

  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-new-title]")!, { by: "chars", widen: true });
    revealText(root.querySelector("[data-new-sub]")!, { delay: 0.15 });
    revealUp(root.querySelectorAll("[data-cell]"), root.querySelector("[data-cells]")!, {
      y: 60,
      stagger: 0.1,
    });
    revealUp(root.querySelectorAll("[data-more]"), root.querySelector("[data-more-wrap]")!, {
      stagger: 0.1,
    });
    const version = root.querySelector<HTMLElement>("[data-new-version]")!;
    gsap.to(version, {
      scrambleText: { text: version.textContent ?? "", chars: "0123456789.", speed: 0.6 },
      duration: 1.2,
      scrollTrigger: { trigger: version, start: "top 85%", once: true },
    });
    const cell = (k: string) => root.querySelector<HTMLElement>(`[data-cell="${k}"]`)!;
    const triggers = [
      setupGoal(cell("goal")),
      setupShip(cell("ship")),
      setupUpdates(cell("update")),
      setupAlerts(cell("alerts")),
      setupSpeed(cell("speed")),
    ];
    return () => triggers.forEach((t) => t.kill());
  });

  return (
    <section ref={scope} id="new" aria-labelledby="new-title" className="relative py-24 sm:py-36">
      <div className={SECTION_X}>
        <Link
          to="/changelog"
          className={cn(
            "group/v inline-flex items-center gap-2.5 rounded-full border border-white/12 py-1 pl-1 pr-3.5 text-[13px] text-ink/75 transition-colors hover:border-accent/40 hover:text-ink",
            focusRing,
          )}
        >
          <span
            data-new-version
            className="rounded-full bg-accent px-2.5 py-0.5 font-mono text-[11.5px] font-semibold text-accent-ink"
          >
            v{latest.version}
          </span>
          Latest release · {latest.date}
          <ArrowUpRight className="size-3.5 transition-transform duration-500 ease-ryco group-hover/v:-translate-y-0.5 group-hover/v:translate-x-0.5" />
        </Link>
        <h2
          id="new-title"
          data-new-title
          className="mt-7 font-display text-[clamp(2.4rem,6vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]"
        >
          <span className="block">
            Set it going<span className="text-accent">.</span>
          </span>
          <span className="block">
            Walk away<span className="text-accent">.</span>
          </span>
        </h2>
        <p data-new-sub className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-ink/60">
          The latest releases moved the work onto your machines. Queues, goals and pull request
          watches keep running with every window closed, and Ryco tells you the moment something
          needs you.
        </p>

        <div data-cells data-loops className="mt-14 grid gap-4 sm:mt-20 md:grid-cols-6">
          <Cell
            demo="goal"
            className="md:col-span-4"
            title="Give it a goal, queue the rest"
            body="A thread keeps working after each clean turn until its goal is met. Follow-ups you queue wait on the machine and go out in order, even with every window closed."
          >
            <GoalQueue />
          </Cell>
          <Cell
            demo="ship"
            className="md:col-span-2"
            title="Ship it, then let it watch"
            body="One click commits, pushes and opens the pull request. The agent watches the checks and fixes what fails."
          >
            <ShipWatch />
          </Cell>
          <Cell
            demo="update"
            className="md:col-span-2"
            title="Update every machine at once"
            body="The app, every node and their provider CLIs in one click. A node that fails to start rolls back, database included."
          >
            <UpdateAll />
          </Cell>
          <Cell
            demo="alerts"
            className="md:col-span-2"
            title="Know when it needs you"
            body="Toasts, notifications, sound and a badge on desktop. On the coming iPhone app, alerts and a Live Activity."
          >
            <Alerts />
          </Cell>
          <Cell
            demo="speed"
            className="md:col-span-2"
            title="Faster than last month"
            body="A WebAssembly highlighter, streaming that re-renders only what changed, and compressed sync."
          >
            <Speed />
          </Cell>
        </div>

        <div data-more-wrap data-loops className="mt-14 space-y-3 sm:mt-16">
          <div data-more>
            <Marquee items={LATEST_MORE[0]} />
          </div>
          <div data-more>
            <Marquee items={LATEST_MORE[1]} reverse />
          </div>
          <p data-more className="pt-5 text-center">
            <Link
              to="/changelog"
              className={cn(
                "inline-flex items-center gap-1.5 text-[14.5px] text-ink/70 underline-offset-4 transition-colors hover:text-ink hover:underline",
                focusRing,
              )}
            >
              Everything in every release, in the changelog
              <ArrowUpRight className="size-4" />
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
