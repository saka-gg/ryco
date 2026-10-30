/**
 * The roster. Six providers as a typographic index: names open up Archivo's
 * width axis as you hover, the row floods with the vendor's colour, and a live
 * thread preview for that agent trails the cursor. Touch and reduced motion get
 * the same rows, fully expanded and still.
 */
import { useRef } from "react";
import { BrandIcon } from "@/assets/brands";
import { PROVIDERS, providerById } from "@/data/content";
import { cn } from "@/lib/cn";
import { gsap, prefersReducedMotion, useGsap } from "@/lib/motion";
import { PANES, THREADS } from "./stage/script";
import { ToolLine } from "./stage/Stage";
import { revealText, revealUp } from "./ui/reveal";
import { SECTION_X } from "./theme";

const INSTANCES = [
  { name: "codex_personal", provider: "codex" },
  { name: "claude_openrouter", provider: "claude" },
  { name: "copilot_work", provider: "copilot" },
];

function PreviewPane({ providerId }: { providerId: string }) {
  const p = providerById(providerId);
  const t = THREADS.find((x) => x.provider === providerId)!;
  const pane = PANES.find((x) => x.thread === t.id)!;
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-app shadow-[0_40px_80px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3.5 text-[12.5px]">
        <BrandIcon name={p.brand} className="size-3.5" style={{ color: p.accent }} />
        <span className="truncate font-medium text-app-fg">{t.title}</span>
        <span className="ml-auto rounded-full border border-white/[0.08] px-2 py-0.5 text-[10.5px] text-app-muted">
          {pane.model}
        </span>
      </div>
      <div className="px-3.5 pt-3">
        <div className="border-l border-white/[0.08] pl-2.5">
          {pane.rows.map((row) => (
            <ToolLine key={row.verb + row.target} row={row} compact live={false} />
          ))}
        </div>
        <p className="mt-3 text-[12.5px] leading-[1.6] text-app-fg/85">{pane.text}</p>
      </div>
    </div>
  );
}

export function Agents() {
  const preview = useRef<HTMLDivElement>(null);

  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-agents-title]")!, { by: "chars", widen: true });
    revealText(root.querySelector("[data-agents-sub]")!, { delay: 0.2 });
    root.querySelectorAll<HTMLElement>("[data-agent-name]").forEach((el) =>
      /* transform-only rise: animating the width axis on six huge names
           re-shapes and re-rasters them every frame (the hover keeps it) */
      revealText(el, { by: "chars", stagger: 0.03, start: "top 92%" }),
    );
    revealUp(root.querySelectorAll("[data-agent-meta]"), root.querySelector("[data-roster]")!, {
      y: 16,
      stagger: 0.06,
    });

    /* instance chips decode themselves */
    const chips = Array.from(root.querySelectorAll<HTMLElement>("[data-instance]"));
    const names = chips.map((el) => el.textContent ?? "");
    chips.forEach((el, i) => {
      const text = names[i];
      el.textContent = "\u00a0".repeat(text.length);
      gsap.to(el, {
        scrambleText: { text, chars: "abcdefghijklmnopqrstuvwxyz_", speed: 0.4 },
        duration: 1.1,
        delay: i * 0.15,
        ease: "none",
        scrollTrigger: { trigger: el, start: "top 92%", once: true },
      });
    });

    const restoreChips = () => chips.forEach((el, i) => (el.textContent = names[i]));

    /* cursor-trailing preview (fine pointers only) */
    const fine = window.matchMedia("(pointer: fine)").matches;
    const card = preview.current;
    if (!fine || !card) return restoreChips;
    gsap.set(card, { xPercent: -50, yPercent: -50, scale: 0.6, autoAlpha: 0 });
    const xTo = gsap.quickTo(card, "x", { duration: 0.65, ease: "power3" });
    const yTo = gsap.quickTo(card, "y", { duration: 0.65, ease: "power3" });
    const rTo = gsap.quickTo(card, "rotation", { duration: 0.8, ease: "power3" });
    let lastX = 0;
    const roster = root.querySelector<HTMLElement>("[data-roster]")!;
    /* the card is position:fixed, so pointer coordinates are enough: no
       per-move layout reads while the names are mid-tween */
    const move = (e: PointerEvent) => {
      xTo(e.clientX);
      yTo(e.clientY);
      rTo(gsap.utils.clamp(-8, 8, (e.clientX - lastX) * 0.35));
      lastX = e.clientX;
    };
    const enter = () => gsap.to(card, { autoAlpha: 1, scale: 1, duration: 0.5, ease: "ryco" });
    const leave = () => gsap.to(card, { autoAlpha: 0, scale: 0.6, duration: 0.4, ease: "ryco" });
    roster.addEventListener("pointermove", move);
    roster.addEventListener("pointerenter", enter);
    roster.addEventListener("pointerleave", leave);
    return () => {
      restoreChips();
      roster.removeEventListener("pointermove", move);
      roster.removeEventListener("pointerenter", enter);
      roster.removeEventListener("pointerleave", leave);
    };
  });

  /* Hover is DOM-only (data attributes drive the colours in CSS, GSAP the
     width and flood), so rows sliding under a still cursor while scrolling
     never re-render React. Reduced motion keeps the colours, skips the motion. */
  const hover = (id: string | null) => {
    const root = scope.current;
    const roster = root?.querySelector<HTMLElement>("[data-roster]");
    if (!root || !roster || (roster.dataset.active ?? null) === id) return;
    if (id) roster.dataset.active = id;
    else delete roster.dataset.active;
    root.querySelectorAll<HTMLElement>("[data-preview-pane]").forEach((pane) => {
      pane.toggleAttribute("data-on", pane.dataset.previewPane === id);
    });
    const reduce = prefersReducedMotion();
    root.querySelectorAll<HTMLElement>("[data-agent-row]").forEach((row) => {
      const on = row.dataset.agentRow === id;
      row.toggleAttribute("data-on", on);
      if (reduce) return;
      gsap.to(row.querySelector("[data-agent-name]"), {
        fontVariationSettings: on ? "'wdth' 118" : "'wdth' 100",
        x: on ? 18 : 0,
        duration: 0.7,
        ease: "ryco",
        overwrite: "auto",
      });
      gsap.to(row.querySelector("[data-agent-flood]"), {
        scaleY: on ? 1 : 0,
        duration: 0.6,
        ease: "ryco",
        overwrite: "auto",
      });
    });
  };

  return (
    <section ref={scope} id="agents" className="relative py-32 sm:py-44">
      <div className={SECTION_X}>
        <h2
          data-agents-title
          className="max-w-[16ch] font-display text-[clamp(2.4rem,6vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]"
        >
          Bring the agents you already pay for<span className="text-accent">.</span>
        </h2>
        <p data-agents-sub className="mt-6 max-w-[52ch] text-[17px] leading-relaxed text-ink/60">
          Each one runs through its own SDK or protocol, on the subscription you already have.
          Switch agents per thread without losing the context.
        </p>
      </div>

      <div
        data-roster
        className={cn(SECTION_X, "relative mt-16 sm:mt-20")}
        onPointerLeave={() => hover(null)}
      >
        <ul>
          {PROVIDERS.map((p) => (
            <li
              key={p.id}
              data-agent-row={p.id}
              onPointerEnter={() => hover(p.id)}
              style={{ "--brand": p.accent } as React.CSSProperties}
              className="group/row relative grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 border-t border-white/10 py-6 last:border-b sm:py-8 md:grid-cols-[64px_minmax(0,1fr)_minmax(0,320px)] md:gap-x-8"
            >
              <span
                data-agent-flood
                aria-hidden
                className="pointer-events-none absolute inset-0 origin-bottom scale-y-0"
                style={{ background: `linear-gradient(to top, ${p.accent}1f, ${p.accent}05)` }}
              />
              <span className="relative grid size-11 place-items-center sm:size-16">
                <BrandIcon
                  name={p.brand}
                  className="size-7 text-ink/55 transition-colors duration-500 group-data-[on]/row:text-[var(--brand)] sm:size-10"
                />
              </span>
              <span className="relative flex min-w-0 items-baseline gap-4">
                <span
                  data-agent-name
                  className="block whitespace-nowrap font-display text-[clamp(2.3rem,7vw,6.4rem)] font-semibold leading-[1] tracking-[-0.04em] text-ink transition-colors duration-500 in-data-[active]:text-ink/30 group-data-[on]/row:text-ink"
                >
                  {p.name}
                </span>
                {p.earlyAccess && (
                  <span className="hidden shrink-0 rounded-full border border-white/15 px-2.5 py-1 text-[11px] font-medium text-ink/60 lg:inline-block">
                    Early access
                  </span>
                )}
              </span>
              <span data-agent-meta className="relative col-span-2 md:col-span-1">
                <span className="block font-mono text-[12.5px] text-ink/50">
                  {p.vendor} · {p.via}
                </span>
                <span className="mt-1.5 block text-[15px] leading-snug text-ink/75">
                  {p.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>

        {/* cursor-trailing preview of the hovered agent's thread */}
        <div
          ref={preview}
          aria-hidden
          className="pointer-events-none invisible fixed left-0 top-0 z-10 hidden h-[230px] w-[340px] opacity-0 lg:block"
        >
          {PROVIDERS.map((p) => (
            <div
              key={p.id}
              data-preview-pane={p.id}
              className="absolute inset-0 scale-95 opacity-0 transition-[opacity,transform] duration-500 ease-ryco data-[on]:scale-100 data-[on]:opacity-100"
            >
              <PreviewPane providerId={p.id} />
            </div>
          ))}
        </div>
      </div>

      <div className={cn(SECTION_X, "mt-14 flex flex-wrap items-center gap-x-5 gap-y-3")}>
        <p className="text-[15px] text-ink/60">Need two of the same? Named instances:</p>
        {INSTANCES.map((inst) => {
          const p = providerById(inst.provider);
          return (
            <span
              key={inst.name}
              className="inline-flex items-center gap-2 rounded-full border border-white/12 px-3.5 py-1.5 font-mono text-[13px] text-ink/85"
            >
              <BrandIcon name={p.brand} className="size-3.5" style={{ color: p.accent }} />
              <span data-instance>{inst.name}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
