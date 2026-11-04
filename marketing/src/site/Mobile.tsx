/**
 * Mobile: the native iPhone and iPad app, coming soon. Real simulator captures.
 *
 * On wide screens the stage pins and plays as chapters: the phone holds its
 * place while each chapter's capture rises into the screen, the copy steps
 * through on the left and a rail tracks progress. Narrow screens and reduced
 * motion get a swipeable strip of phones with captions instead. Chapters
 * without a capture are listed below the stage.
 */
import { ArrowUpRight } from "lucide-react";
import { BrandIcon } from "@/assets/brands";
import { MOBILE, type MobileChapter, SITE } from "@/data/content";
import { cn } from "@/lib/cn";
import { screenshotImageProps } from "@/lib/screenshotAssets";
import { gsap, useGsap } from "@/lib/motion";
import { Button } from "./ui/Button";
import { LoopVideo } from "./ui/LoopVideo";
import { revealText, revealUp } from "./ui/reveal";
import { focusRing, SECTION_X } from "./theme";

/** iPhone 17 Pro screen, 402 × 874 pt. */
const SCREEN_ASPECT = 402 / 874;

const SHOWN = MOBILE.chapters.filter((c): c is Shown => Boolean(c.shot && c.alt));
const LISTED = MOBILE.chapters.filter((c) => !c.shot);

/** A CSS iPhone: bezel, rounded screen, Dynamic Island. Children fill the screen. */
function PhoneFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative rounded-[15%/6.9%] bg-[#050506] p-[2.6%] shadow-[0_60px_120px_-40px_rgba(0,0,0,0.95),0_0_0_1px_rgba(255,255,255,0.14)_inset]",
        className,
      )}
    >
      <div
        className="relative w-full overflow-hidden rounded-[12.8%/5.9%] bg-app"
        style={{ aspectRatio: `${SCREEN_ASPECT}` }}
      >
        {children}
        {/* the simulator's island, which screenshots leave out and recordings keep */}
        <span
          aria-hidden
          className="absolute left-1/2 top-[1.5%] h-[4.25%] w-[23.7%] -translate-x-1/2 rounded-full bg-black"
        />
      </div>
    </div>
  );
}

type Shown = MobileChapter & { shot: string; alt: string };

function Screen({ chapter, index }: { chapter: Shown; index: number }) {
  /* the settled frame (reduced motion) is the first capture */
  const hidden = index > 0 && "opacity-0";
  if (chapter.video) {
    return (
      <LoopVideo
        data-screen
        src={chapter.video}
        label={chapter.alt}
        className={cn("absolute inset-0 size-full object-cover", hidden)}
      />
    );
  }
  return (
    <img
      data-screen
      {...screenshotImageProps(chapter.shot, "(min-width: 1024px) 380px, 70vw")}
      alt={chapter.alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn("absolute inset-0 size-full object-cover", hidden)}
    />
  );
}

/** Wide screens with motion: the pinned chapter player. */
function Stage() {
  return (
    <div
      data-mobile-pin
      className="hidden h-[100svh] items-center motion-safe:lg:flex"
      style={{ perspective: "2000px" }}
    >
      <div
        className={cn(
          SECTION_X,
          "grid grid-cols-[minmax(0,34rem)_auto] items-center justify-center gap-[clamp(4rem,10vw,10rem)]",
        )}
      >
        <div className="flex gap-10">
          <ol aria-hidden className="relative flex flex-col gap-5 pt-1">
            <span className="absolute bottom-0 left-[3px] top-0 w-px bg-white/10" />
            <span
              data-rail
              className="absolute left-[3px] top-0 h-full w-px origin-top scale-y-0 bg-accent"
            />
            {SHOWN.map((c, i) => (
              <li
                key={c.title}
                data-rail-item
                className={cn(
                  "relative flex items-center gap-4 font-mono text-[12px] text-ink transition-none",
                  i > 0 && "opacity-35",
                )}
              >
                <span className="size-[7px] rounded-full bg-current" />
                {String(i + 1).padStart(2, "0")}
              </li>
            ))}
          </ol>
          <div className="grid max-w-[30rem] flex-1">
            {SHOWN.map((c, i) => (
              <div
                key={c.title}
                data-chapter
                className={cn("col-start-1 row-start-1", i > 0 && "opacity-0")}
              >
                <h3 className="font-display text-[clamp(2rem,3.4vw,3.2rem)] font-bold leading-[1] tracking-[-0.03em] text-ink">
                  {c.title}
                  <span className="text-accent">.</span>
                </h3>
                <p className="mt-5 text-[17px] leading-relaxed text-ink/60">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
        <div data-phone className="w-[min(380px,calc((100svh-9rem)*0.46))] will-change-transform">
          <PhoneFrame>
            {SHOWN.map((c, i) => (
              <Screen key={c.shot} chapter={c} index={i} />
            ))}
          </PhoneFrame>
        </div>
      </div>
    </div>
  );
}

/** Narrow screens and reduced motion: a swipeable strip of phones. */
function Strip() {
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="iPhone app screens"
      className={cn(
        "mt-12 flex snap-x snap-mandatory gap-6 overflow-x-auto px-4 pb-6 sm:px-8 motion-safe:lg:hidden",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        focusRing,
      )}
    >
      {SHOWN.map((c, i) => (
        <figure key={c.title} className="w-[64vw] max-w-[300px] shrink-0 snap-center">
          <PhoneFrame>
            {c.video ? (
              <LoopVideo
                src={c.video}
                label={c.alt}
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              <img
                {...screenshotImageProps(c.shot, "(max-width: 768px) 64vw, 300px")}
                alt={c.alt}
                loading={i === 0 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
                className="absolute inset-0 size-full object-cover"
              />
            )}
          </PhoneFrame>
          <figcaption className="mt-5">
            <span className="block font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">
              {c.title}
            </span>
            <span className="mt-1 block text-[14.5px] leading-snug text-ink/55">{c.body}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function Mobile() {
  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-mobile-title]")!, { by: "chars", widen: true });
    revealText(root.querySelector("[data-mobile-sub]")!, { delay: 0.15 });
    revealUp(root.querySelectorAll("[data-listed]"), root.querySelector("[data-listed-wrap]")!, {
      stagger: 0.08,
    });

    const mm = gsap.matchMedia();
    mm.add("(min-width: 1024px)", () => {
      const pin = root.querySelector<HTMLElement>("[data-mobile-pin]")!;
      const phone = pin.querySelector<HTMLElement>("[data-phone]")!;
      const screens = pin.querySelectorAll<HTMLElement>("[data-screen]");
      const chapters = pin.querySelectorAll<HTMLElement>("[data-chapter]");
      const items = pin.querySelectorAll<HTMLElement>("[data-rail-item]");
      const rail = pin.querySelector<HTMLElement>("[data-rail]")!;
      const n = SHOWN.length;

      /* the phone swings in as the stage arrives */
      gsap.from(phone, {
        rotateY: -24,
        rotateX: 10,
        yPercent: 18,
        ease: "none",
        scrollTrigger: { trigger: pin, start: "top bottom", end: "top top", scrub: 0.8 },
      });

      const tl = gsap.timeline({
        defaults: { ease: "ryco.inOut", duration: 0.5 },
        scrollTrigger: {
          trigger: pin,
          start: "top top",
          end: () => `+=${n * window.innerHeight * 0.75}`,
          pin: true,
          scrub: 0.6,
          invalidateOnRefresh: true,
          /* sort by document position, like the film and gallery pins */
          refreshPriority: 0,
        },
      });
      gsap.set(screens, { autoAlpha: 0 });
      gsap.set(screens[0], { autoAlpha: 1 });
      gsap.set(chapters, { autoAlpha: 0 });
      gsap.set(chapters[0], { autoAlpha: 1 });
      tl.to(rail, { scaleY: 1, ease: "none", duration: n }, 0).to(
        phone,
        { yPercent: -3, ease: "none", duration: n },
        0,
      );
      for (let i = 1; i < n; i++) {
        const at = i - 0.25;
        tl.to(screens[i - 1], { autoAlpha: 0, scale: 0.94, duration: 0.45 }, at)
          .fromTo(
            screens[i],
            { autoAlpha: 0, yPercent: 10, scale: 1.02 },
            { autoAlpha: 1, yPercent: 0, scale: 1 },
            at,
          )
          .to(chapters[i - 1], { autoAlpha: 0, y: -36, duration: 0.4 }, at)
          .fromTo(chapters[i], { autoAlpha: 0, y: 36 }, { autoAlpha: 1, y: 0 }, at + 0.1)
          .to(items[i - 1], { opacity: 0.35, duration: 0.3 }, at)
          .to(items[i], { opacity: 1, duration: 0.3 }, at);
      }
      /* a short hold on the last chapter before the pin releases */
      tl.to({}, { duration: 0.35 });
    });
    return () => mm.revert();
  });

  return (
    <section
      ref={scope}
      id="mobile"
      aria-labelledby="mobile-title"
      className="relative overflow-hidden py-24 sm:py-36"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-10%] top-[30%] -z-10 h-[70%] w-[60%] opacity-60"
        style={{ background: "radial-gradient(closest-side, rgba(255,92,40,0.10), transparent)" }}
      />
      <div className={SECTION_X}>
        <p className="inline-flex items-center gap-2 rounded-full border border-white/12 py-1 pl-2.5 pr-3.5 text-[13px] text-ink/80">
          <BrandIcon name="apple" className="size-3.5" />
          {MOBILE.status}
        </p>
        <h2
          id="mobile-title"
          data-mobile-title
          className="mt-7 font-display text-[clamp(2.6rem,7vw,6.6rem)] font-bold leading-[0.93] tracking-[-0.04em]"
        >
          Ryco in your pocket<span className="text-accent">.</span>
        </h2>
        <p data-mobile-sub className="mt-6 max-w-[54ch] text-[17px] leading-relaxed text-ink/60">
          A native app for every thread on every machine: live, with approvals, pull requests and a
          real terminal. It goes through Cloud, or straight to your machines over your network or
          Tailscale.
        </p>
      </div>

      <Stage />
      <Strip />

      <div className={SECTION_X}>
        <ul
          data-listed-wrap
          className="mt-16 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:mt-8 lg:grid-cols-4"
        >
          {LISTED.map((c) => (
            <li key={c.title} data-listed className="border-t border-white/12 pt-5">
              <h3 className="font-display text-[18px] font-semibold tracking-[-0.01em] text-ink">
                {c.title}
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-snug text-ink/55">{c.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-4">
          <Button href={SITE.discord} external icon={<ArrowUpRight />}>
            Hear first on Discord
          </Button>
          <p className="max-w-[46ch] text-[13.5px] leading-snug text-ink/50">
            Not in the App Store yet. Cloud stays optional on the phone too.
          </p>
        </div>
      </div>
    </section>
  );
}
