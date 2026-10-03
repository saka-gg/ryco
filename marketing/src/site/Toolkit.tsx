/**
 * The toolkit: five live micro-demos, each a small real slice of the product
 * (worktree board, ⌘K, # issue context, theme editor, traces). Every loop only
 * runs while its cell is on screen; under reduced motion each cell renders one
 * composed, readable frame.
 */
import { Command, CornerDownLeft, GitPullRequest, Search } from "lucide-react";
import { BrandIcon, GitHubIcon } from "@/assets/brands";
import { providerById } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, ScrollTrigger, useGsap } from "@/lib/motion";
import { revealText, revealUp } from "./ui/reveal";
import { SECTION_X } from "./theme";

/** Play `tl` only while `cell` is in the viewport. */
function whileVisible(cell: Element, tl: { play: () => unknown; pause: () => unknown }) {
  return ScrollTrigger.create({
    trigger: cell,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
  });
}

const setText = (el: Element, text: string) => {
  el.textContent = text;
};

/* ------------------------------- worktrees -------------------------------- */

const COLUMNS = ["Idle", "In progress", "Review", "Done"];
const CARDS = [
  { branch: "feat/relay-backoff", provider: "claude", note: "+63 −2" },
  { branch: "fix/worktree-flake", provider: "copilot", note: "1 test" },
  { branch: "docs/changelog-0.1.29", provider: "opencode", note: "draft" },
  { branch: "perf/diff-search", provider: "cursor", note: "+38 −22" },
  { branch: "feat/theme-tokens", provider: "codex", note: "+84 −31" },
];
/* initial board: which column each card starts in */
const START_COL = [1, 1, 0, 2, 0];
const CARD_H = 56;
const CARD_GAP = 8;
const COL_HEAD = 34;

function WorktreeBoard() {
  return (
    <div data-board className="relative h-[300px] w-full">
      <div className="absolute inset-0 grid grid-cols-4 gap-2.5">
        {COLUMNS.map((c) => (
          <div key={c} className="rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.05]">
            <p className="flex h-[34px] items-center px-3 text-[12px] font-medium text-ink/55">
              {c}
            </p>
          </div>
        ))}
      </div>
      {CARDS.map((card, i) => {
        const p = providerById(card.provider);
        const col = START_COL[i];
        const slot = START_COL.slice(0, i).filter((c) => c === col).length;
        return (
          <div
            key={card.branch}
            data-card
            className="absolute left-0 top-0 px-1.5"
            style={{
              width: "25%",
              transform: `translate(${col * 100}%, ${COL_HEAD + slot * (CARD_H + CARD_GAP)}px)`,
            }}
          >
            <div className="flex h-[56px] flex-col justify-center gap-1 rounded-lg border border-white/[0.08] bg-app-card px-2.5 shadow-[0_8px_20px_-12px_rgba(0,0,0,0.8)]">
              <span className="flex items-center gap-1.5">
                <BrandIcon name={p.brand} className="size-3 shrink-0" style={{ color: p.accent }} />
                <span className="truncate font-mono text-[11px] text-ink/85">{card.branch}</span>
              </span>
              <span className="text-[10.5px] text-ink/45">{card.note}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function setupBoard(cell: HTMLElement) {
  const cards = Array.from(cell.querySelectorAll<HTMLElement>("[data-card]"));
  const cols = [...START_COL];
  const place = (animate: boolean) => {
    const slots = [0, 0, 0, 0];
    cards.forEach((card, i) => {
      const c = cols[i];
      const y = COL_HEAD + slots[c]++ * (CARD_H + CARD_GAP);
      gsap.to(card, {
        xPercent: c * 100,
        x: 0,
        y,
        duration: animate ? 0.9 : 0,
        ease: "ryco",
        overwrite: "auto",
      });
    });
  };
  gsap.set(cards, { clearProps: "transform" });
  place(false);

  /* Each beat, advance the card that has waited longest; Done recycles. */
  const order = cards.map((_, i) => i);
  let running = false;
  let call: gsap.core.Tween | null = null;
  const beat = () => {
    const i = order.shift()!;
    order.push(i);
    const card = cards[i];
    if (cols[i] === 3) {
      cols[i] = 0;
      gsap.fromTo(card, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.6, delay: 0.3 });
    } else {
      cols[i] += 1;
      gsap.fromTo(card, { scale: 1.06 }, { scale: 1, duration: 0.7, ease: "ryco" });
    }
    place(true);
    call = gsap.delayedCall(1.5, () => running && beat());
  };
  const loop = {
    play: () => {
      if (running) return;
      running = true;
      call = gsap.delayedCall(0.8, beat);
    },
    pause: () => {
      running = false;
      call?.kill();
    },
  };
  return whileVisible(cell, loop);
}

/* ------------------------------ command (⌘K) ------------------------------ */

const COMMANDS = [
  { label: "New thread", keys: "⌘N" },
  { label: "Toggle terminal", keys: "⌘J" },
  { label: "Toggle diff", keys: "⌘D" },
  { label: "Open files", keys: "⌘P" },
  { label: "Switch model", keys: "⇧⌘M" },
  { label: "Jump to thread 3", keys: "⌘3" },
];
const QUERIES = ["term", "model", "diff", "thread 3"];
const ROW_H = 34;

function Palette() {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-app-pop shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex h-11 items-center gap-2.5 border-b border-white/[0.07] px-3.5 text-[13.5px]">
        <Search className="size-4 text-ink/40" />
        <span data-q className="text-ink">
          term
        </span>
        <span className="ry-caret -ml-1.5 text-ink/70" />
      </div>
      <div className="relative p-1.5">
        <span
          data-hl
          className="absolute inset-x-1.5 top-1.5 rounded-lg bg-white/[0.07] ring-1 ring-inset ring-white/10"
          style={{ height: ROW_H, transform: `translateY(${ROW_H}px)` }}
        />
        {COMMANDS.map((c) => (
          <div
            key={c.label}
            data-cmd={c.label.toLowerCase()}
            className="relative flex items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink/85"
            style={{ height: ROW_H }}
          >
            <Command className="size-3.5 text-ink/35" />
            {c.label}
            <span className="ml-auto font-mono text-[11px] text-ink/40">{c.keys}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function setupPalette(cell: HTMLElement) {
  const q = cell.querySelector<HTMLElement>("[data-q]")!;
  const hl = cell.querySelector<HTMLElement>("[data-hl]")!;
  const rows = Array.from(cell.querySelectorAll<HTMLElement>("[data-cmd]"));
  const tl = gsap.timeline({ repeat: -1, paused: true });
  setText(q, "");
  QUERIES.forEach((query) => {
    const proxy = { n: 0 };
    const match = rows.findIndex((r) => r.dataset.cmd!.includes(query));
    tl.to(proxy, {
      n: query.length,
      duration: query.length * 0.09,
      ease: "none",
      onUpdate: () => setText(q, query.slice(0, Math.round(proxy.n))),
    });
    tl.to(
      rows,
      { opacity: (i) => (rows[i].dataset.cmd!.includes(query) ? 1 : 0.28), duration: 0.3 },
      "<+0.15",
    );
    tl.to(hl, { y: match * ROW_H, duration: 0.45, ease: "ryco" }, "<");
    tl.to(
      hl,
      { backgroundColor: "rgba(255,92,40,0.22)", duration: 0.12, yoyo: true, repeat: 1 },
      "+=0.7",
    );
    tl.to(
      proxy,
      {
        n: 0,
        duration: 0.25,
        ease: "none",
        onUpdate: () => setText(q, query.slice(0, Math.round(proxy.n))),
      },
      "+=0.35",
    );
    tl.to(rows, { opacity: 1, duration: 0.25 }, "<");
  });
  return whileVisible(cell, tl);
}

/* ------------------------------- # context -------------------------------- */

const ISSUES = [
  { n: 139, title: "Broaden PR and workflow status refresh" },
  { n: 132, title: "Desktop dev restarts after GPU crash" },
  { n: 103, title: "Show all worktree sessions on open" },
];
const HOSTS = ["GitHub", "GitLab", "Forgejo", "Bitbucket", "Azure DevOps"];

function IssueContext() {
  return (
    <div className="relative">
      <div className="rounded-2xl border border-white/10 bg-app-card p-3.5 text-[13px] leading-[1.6]">
        <span className="text-ink/85">Fix the restart loop from </span>
        <span
          data-chip
          className="inline-flex translate-y-[2px] items-center gap-1 rounded-md bg-[#2a2f45] px-1.5 text-[12px] text-[#a9b8ff]"
        >
          <GitHubIcon className="size-3" />
          #132
        </span>
        <span data-hash className="text-ink/85" />
        <span className="ry-caret text-ink/70" />
      </div>
      <div
        data-pop
        className="absolute inset-x-6 top-[58px] rounded-xl border border-white/10 bg-app-pop p-1.5 shadow-[0_24px_50px_-20px_rgba(0,0,0,0.9)]"
      >
        {ISSUES.map((iss, i) => (
          <div
            key={iss.n}
            data-issue={i}
            className={cn(
              "flex h-8 items-center gap-2 rounded-md px-2 text-[12px]",
              i === 1 ? "bg-white/[0.07] text-ink" : "text-ink/65",
            )}
          >
            <GitPullRequest className="size-3.5 shrink-0 text-[#5fcf86]" />
            <span className="font-mono text-ink/45">#{iss.n}</span>
            <span className="truncate">{iss.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function setupIssues(cell: HTMLElement) {
  const hash = cell.querySelector<HTMLElement>("[data-hash]")!;
  const chip = cell.querySelector<HTMLElement>("[data-chip]")!;
  const pop = cell.querySelector<HTMLElement>("[data-pop]")!;
  const items = Array.from(cell.querySelectorAll<HTMLElement>("[data-issue]"));
  gsap.set(chip, { display: "none" });
  gsap.set(pop, { autoAlpha: 0, y: -6 });
  gsap.set(items, { backgroundColor: "rgba(255,255,255,0)", color: "rgba(241,240,236,0.65)" });
  const tl = gsap.timeline({ repeat: -1, paused: true, repeatDelay: 0.6 });
  const typed = { n: 0 };
  const word = "#13";
  tl.to(
    typed,
    {
      n: word.length,
      duration: 0.45,
      ease: "none",
      onUpdate: () => setText(hash, word.slice(0, Math.round(typed.n))),
    },
    0.4,
  )
    .to(pop, { autoAlpha: 1, y: 0, duration: 0.35, ease: "ryco" }, 0.55)
    .to(
      items[0],
      { backgroundColor: "rgba(255,255,255,0.07)", color: "#f1f0ec", duration: 0.15 },
      1.0,
    )
    .to(
      items[0],
      { backgroundColor: "rgba(255,255,255,0)", color: "rgba(241,240,236,0.65)", duration: 0.15 },
      1.45,
    )
    .to(
      items[1],
      { backgroundColor: "rgba(255,255,255,0.07)", color: "#f1f0ec", duration: 0.15 },
      1.45,
    )
    .to(pop, { autoAlpha: 0, y: -6, duration: 0.25 }, 2.1)
    .call(
      () => {
        setText(hash, "");
        chip.style.display = "inline-flex";
      },
      [],
      2.15,
    )
    .fromTo(chip, { scale: 0.6 }, { scale: 1, duration: 0.5, ease: "back.out(2.5)" }, 2.15)
    .to({}, { duration: 1.8 })
    .call(() => {
      chip.style.display = "none";
      gsap.set(items[1], {
        backgroundColor: "rgba(255,255,255,0)",
        color: "rgba(241,240,236,0.65)",
      });
    });
  return whileVisible(cell, tl);
}

/* --------------------------------- themes --------------------------------- */

const PRESETS = [
  { name: "Ember", accent: "#ff5c28", radius: 14, font: "DM Sans" },
  { name: "Indigo", accent: "#6466f1", radius: 6, font: "Geist Mono" },
  { name: "Teal", accent: "#2cc5b0", radius: 20, font: "DM Sans" },
  { name: "Rose", accent: "#ec6aa0", radius: 10, font: "Archivo" },
];

function ThemeEditor() {
  const first = PRESETS[0];
  return (
    <div
      data-theme-demo
      className="flex h-[200px] overflow-hidden border border-white/10 bg-app"
      style={
        {
          "--t-accent": first.accent,
          "--t-radius": `${first.radius}px`,
          borderRadius: "var(--t-radius)",
        } as React.CSSProperties
      }
    >
      <div className="w-[34%] border-r border-white/[0.06] bg-app-side p-2.5">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="mb-1.5 h-6"
            style={{
              borderRadius: "calc(var(--t-radius) * 0.5)",
              background:
                i === 0
                  ? "color-mix(in srgb, var(--t-accent) 22%, transparent)"
                  : "rgba(255,255,255,0.04)",
            }}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p data-font className="text-[13px] text-ink/85" style={{ fontFamily: first.font }}>
          The quick agent ships the fix.
        </p>
        <p className="mt-1 text-[11px] text-ink/45">
          <span data-preset>{first.name}</span>, radius <span data-radius>{first.radius}</span>
        </p>
        <div
          className="mt-auto flex h-9 items-center justify-between border border-white/10 bg-app-card pl-3 pr-1.5 text-[11.5px] text-ink/45"
          style={{ borderRadius: "var(--t-radius)" }}
        >
          Ask anything
          <span
            className="grid size-6 place-items-center rounded-full"
            style={{ background: "var(--t-accent)" }}
          >
            <CornerDownLeft className="size-3 text-white" />
          </span>
        </div>
      </div>
    </div>
  );
}

function setupThemes(cell: HTMLElement) {
  const demo = cell.querySelector<HTMLElement>("[data-theme-demo]")!;
  const font = cell.querySelector<HTMLElement>("[data-font]")!;
  const preset = cell.querySelector<HTMLElement>("[data-preset]")!;
  const radius = cell.querySelector<HTMLElement>("[data-radius]")!;
  const tl = gsap.timeline({ repeat: -1, paused: true });
  [...PRESETS.slice(1), PRESETS[0]].forEach((p) => {
    tl.to(
      demo,
      { "--t-accent": p.accent, "--t-radius": `${p.radius}px`, duration: 0.8, ease: "ryco" },
      "+=1.3",
    );
    tl.call(
      () => {
        font.style.fontFamily = p.font;
        preset.textContent = p.name;
        radius.textContent = String(p.radius);
      },
      [],
      "<+0.2",
    );
    tl.fromTo(font, { autoAlpha: 0.2, y: 4 }, { autoAlpha: 1, y: 0, duration: 0.4 }, "<");
  });
  return whileVisible(cell, tl);
}

/* --------------------------------- traces --------------------------------- */

const SPANS = [
  { name: "provider.turn", at: 0, w: 100, ms: "4.2s" },
  { name: "tool.read", at: 4, w: 7, ms: "38ms" },
  { name: "tool.edit", at: 14, w: 12, ms: "120ms" },
  { name: "tool.exec", at: 30, w: 46, ms: "612ms" },
  { name: "persist", at: 80, w: 6, ms: "9ms" },
];

function Traces() {
  return (
    <div className="space-y-2">
      <svg viewBox="0 0 300 60" className="h-14 w-full overflow-visible" fill="none" aria-hidden>
        <path
          data-spark
          d="M0 44 C 20 40, 30 46, 45 38 S 75 20, 95 28 S 125 46, 145 34 S 175 10, 200 18 S 240 40, 260 26 S 290 14, 300 16"
          stroke="#ff5c28"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M0 44 C 20 40, 30 46, 45 38 S 75 20, 95 28 S 125 46, 145 34 S 175 10, 200 18 S 240 40, 260 26 S 290 14, 300 16 L300 60 L0 60Z"
          fill="url(#spark)"
          opacity="0.25"
        />
        <defs>
          <linearGradient id="spark" x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="#ff5c28" />
            <stop offset="1" stopColor="#ff5c28" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      {SPANS.map((s) => (
        <div
          key={s.name}
          className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2.5 text-[11px]"
        >
          <span className="truncate font-mono text-ink/55">{s.name}</span>
          <span className="relative h-[14px]">
            <span
              data-span
              className="absolute inset-y-0 origin-left rounded-[3px] bg-white/[0.14]"
              style={{ left: `${s.at}%`, width: `${s.w}%` }}
            />
            <span
              className="absolute top-1/2 -translate-y-1/2 font-mono text-[10px] text-ink/45"
              style={{ left: `calc(${Math.min(s.at + s.w, 86)}% + 6px)` }}
            >
              {s.ms}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function setupTraces(cell: HTMLElement) {
  const spark = cell.querySelector<SVGPathElement>("[data-spark]")!;
  const spans = cell.querySelectorAll<HTMLElement>("[data-span]");
  const tl = gsap.timeline({ repeat: -1, paused: true, repeatDelay: 1.2 });
  tl.fromTo(spark, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.6, ease: "power2.inOut" })
    .fromTo(spans, { scaleX: 0 }, { scaleX: 1, duration: 0.7, stagger: 0.14, ease: "ryco" }, 0.2)
    .to(spans[3], { backgroundColor: "rgba(255,92,40,0.55)", duration: 0.3 }, 1.4)
    .to(spans[3], { backgroundColor: "rgba(255,255,255,0.14)", duration: 0.5 }, 3.2);
  return whileVisible(cell, tl);
}

/* --------------------------------- section -------------------------------- */

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
        <p className="mt-1.5 max-w-[46ch] text-[14.5px] leading-snug text-ink/55">{body}</p>
      </div>
    </article>
  );
}

export function Toolkit() {
  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-tool-title]")!, { by: "chars", widen: true });
    revealText(root.querySelector("[data-tool-sub]")!, { delay: 0.15 });
    revealUp(root.querySelectorAll("[data-cell]"), root.querySelector("[data-cells]")!, {
      y: 60,
      stagger: 0.1,
    });
    const cell = (k: string) => root.querySelector<HTMLElement>(`[data-cell="${k}"]`)!;
    const triggers = [
      setupBoard(cell("board")),
      setupPalette(cell("palette")),
      setupIssues(cell("issues")),
      setupThemes(cell("themes")),
      setupTraces(cell("traces")),
    ];
    return () => triggers.forEach((t) => t.kill());
  });

  return (
    <section
      ref={scope}
      id="features"
      aria-labelledby="toolkit-title"
      className="relative py-24 sm:py-36"
    >
      <div className={SECTION_X}>
        <h2
          id="toolkit-title"
          data-tool-title
          className="max-w-[14ch] font-display text-[clamp(2.4rem,6vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]"
        >
          Everything else, wired in<span className="text-accent">.</span>
        </h2>
        <p data-tool-sub className="mt-6 max-w-[50ch] text-[17px] leading-relaxed text-ink/60">
          Worktrees, a command palette, issue context, a full theme editor and traces. Plus MCP
          servers, five source-control hosts and rebindable keys.
        </p>

        <div data-cells data-loops className="mt-14 grid gap-4 md:grid-cols-6 sm:mt-20">
          <Cell
            demo="board"
            className="md:col-span-4"
            title="A worktree for every branch"
            body="Each branch, PR, issue or Jira item gets its own worktree, tracked from idle to done."
          >
            <WorktreeBoard />
          </Cell>
          <Cell
            demo="palette"
            className="md:col-span-2"
            title="Everything on ⌘K"
            body="Commands, threads and models a few keys away. Every binding is yours to change."
          >
            <Palette />
          </Cell>
          <Cell
            demo="issues"
            className="md:col-span-2"
            title="Issues as context"
            body="Type # to attach an issue or PR. Title, body and recent comments go to the agent."
          >
            <IssueContext />
            <div className="mt-[150px] flex flex-wrap gap-1.5">
              {HOSTS.map((h) => (
                <span
                  key={h}
                  className="rounded-full border border-white/10 px-2.5 py-1 text-[11.5px] text-ink/55"
                >
                  {h}
                </span>
              ))}
            </div>
          </Cell>
          <Cell
            demo="themes"
            className="md:col-span-2"
            title="Make it unmistakably yours"
            body="Fonts, radius, size and accent, tuned live in a full theme editor."
          >
            <ThemeEditor />
          </Cell>
          <Cell
            demo="traces"
            className="md:col-span-2"
            title="See what every agent did"
            body="Provider event logs, local trace files and optional OTLP export."
          >
            <Traces />
          </Cell>
        </div>
      </div>
    </section>
  );
}
