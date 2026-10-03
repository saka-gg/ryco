/**
 * Questions. Sticky heading on the left, an accordion on the right whose
 * plus folds into a minus and whose answers open on a grid-rows transition.
 */
import { useState } from "react";
import { FAQ, SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { useGsap } from "@/lib/motion";
import { revealText, revealUp } from "./ui/reveal";
import { focusRing, SECTION_X } from "./theme";

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-faq-title]")!, { by: "chars", widen: true });
    revealUp(root.querySelectorAll("[data-faq-item]"), root.querySelector("[data-faq-list]")!, {
      y: 24,
      stagger: 0.06,
    });
  });

  return (
    <section ref={scope} id="faq" aria-labelledby="faq-title" className="relative py-28 sm:py-36">
      <div
        className={cn(
          SECTION_X,
          "grid gap-12 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20",
        )}
      >
        <div className="lg:sticky lg:top-28 lg:self-start">
          <h2
            id="faq-title"
            data-faq-title
            className="font-display text-[clamp(2.4rem,6vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]"
          >
            Questions<span className="text-accent">.</span>
          </h2>
          <p className="mt-6 max-w-[34ch] text-[16px] leading-relaxed text-ink/55">
            Anything else? Ask in the{" "}
            <a
              href={SITE.discord}
              target="_blank"
              rel="noreferrer"
              className={cn("text-ink underline-offset-4 hover:underline", focusRing)}
            >
              Discord
            </a>
            .
          </p>
        </div>

        <ul data-faq-list>
          {FAQ.map((item, i) => {
            const isOpen = open === i;
            return (
              <li key={item.q} data-faq-item className="border-t border-white/12 last:border-b">
                <button
                  type="button"
                  id={`faq-q-${i}`}
                  aria-expanded={isOpen}
                  aria-controls={`faq-a-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className={cn("flex w-full items-center gap-6 py-6 text-left", focusRing)}
                >
                  <span
                    className={cn(
                      "flex-1 font-display text-[clamp(1.15rem,2vw,1.5rem)] font-semibold tracking-[-0.015em] transition-colors duration-300",
                      isOpen ? "text-ink" : "text-ink/75",
                    )}
                  >
                    {item.q}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "relative grid size-9 shrink-0 place-items-center rounded-full border transition-colors duration-500",
                      isOpen
                        ? "border-accent bg-accent text-accent-ink"
                        : "border-white/15 text-ink/80",
                    )}
                  >
                    <span className="absolute h-[1.5px] w-3.5 rounded-full bg-current" />
                    <span
                      className={cn(
                        "absolute h-[1.5px] w-3.5 rounded-full bg-current transition-transform duration-500 ease-ryco",
                        isOpen ? "rotate-0" : "rotate-90",
                      )}
                    />
                  </span>
                </button>
                {/* inert while collapsed: hidden from screen readers and tab
                    order, not merely clipped to zero height */}
                <div
                  id={`faq-a-${i}`}
                  role="region"
                  aria-labelledby={`faq-q-${i}`}
                  inert={!isOpen}
                  className="grid transition-[grid-template-rows] duration-500 ease-ryco"
                  style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
                >
                  <div className="overflow-hidden">
                    <p
                      className={cn(
                        "max-w-[62ch] pb-7 text-[16px] leading-relaxed text-ink/60 transition-[opacity,transform] duration-500 ease-ryco",
                        isOpen ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
                      )}
                    >
                      {item.a}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
