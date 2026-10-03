/**
 * Real captures, no mockups. On wide screens the strip pins and pans
 * horizontally with scroll; each capture drifts inside its frame (window
 * parallax) and the strip leans into fast scrolls. Narrow screens and reduced
 * motion get a native scroll-snap strip instead.
 */
import { SHOTS } from "@/data/content";
import { screenshotImageProps } from "@/lib/screenshotAssets";
import { cn } from "@/lib/cn";
import { gsap, ScrollTrigger, useGsap } from "@/lib/motion";
import { revealText } from "./ui/reveal";
import { SECTION_X } from "./theme";

export function Gallery() {
  const scope = useGsap<HTMLElement>((root) => {
    revealText(root.querySelector("[data-gallery-title]")!, { by: "chars", widen: true });
    revealText(root.querySelector("[data-gallery-sub]")!, { delay: 0.15 });

    const mm = gsap.matchMedia();
    mm.add("(min-width: 1024px)", () => {
      const pin = root.querySelector<HTMLElement>("[data-gallery-pin]")!;
      const track = root.querySelector<HTMLElement>("[data-gallery-track]")!;
      const distance = () => track.scrollWidth - window.innerWidth;

      const pan = gsap.to(track, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: pin,
          start: "top top",
          end: () => `+=${distance()}`,
          pin: true,
          scrub: 0.8,
          invalidateOnRefresh: true,
        },
      });

      /* each capture slides against its frame as it crosses the viewport */
      track.querySelectorAll<HTMLElement>("[data-shot]").forEach((frame) => {
        const img = frame.querySelector("img")!;
        gsap.fromTo(
          img,
          { xPercent: -6 },
          {
            xPercent: 6,
            ease: "none",
            scrollTrigger: {
              trigger: frame,
              containerAnimation: pan,
              start: "left right",
              end: "right left",
              scrub: true,
            },
          },
        );
        /* rotation only: a scale here would make every visible capture
           re-raster on every frame of the pan */
        gsap.from(frame, {
          rotateY: -18,
          transformOrigin: "0% 50%",
          ease: "none",
          scrollTrigger: {
            trigger: frame,
            containerAnimation: pan,
            start: "left right",
            end: "left 55%",
            scrub: true,
          },
        });
      });

      /* lean into velocity, settle back */
      const skewTo = gsap.quickTo(track, "skewX", { duration: 0.5, ease: "power3" });
      const st = ScrollTrigger.create({
        trigger: pin,
        start: "top top",
        end: () => `+=${distance()}`,
        onUpdate: (self) => skewTo(gsap.utils.clamp(-5, 5, self.getVelocity() / -400)),
        onLeave: () => skewTo(0),
        onLeaveBack: () => skewTo(0),
      });
      return () => st.kill();
    });
    return () => mm.revert();
  });

  return (
    <section ref={scope} aria-labelledby="gallery-title" className="relative py-24 sm:py-32">
      <div className={SECTION_X}>
        <h2
          id="gallery-title"
          data-gallery-title
          className="font-display text-[clamp(2.4rem,6vw,5.6rem)] font-bold leading-[0.95] tracking-[-0.035em]"
        >
          Look closer<span className="text-accent">.</span>
        </h2>
        <p data-gallery-sub className="mt-6 max-w-[46ch] text-[17px] leading-relaxed text-ink/60">
          Real captures from the app, nothing mocked up. Models, review, the project overview,
          providers and the settings that tune it all.
        </p>
      </div>

      <div
        data-gallery-pin
        className="lg:flex lg:h-[100svh] lg:items-center"
        style={{ perspective: "1800px" }}
      >
        <div
          data-gallery-track
          className={cn(
            "mt-12 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-6 sm:px-8 lg:mt-0 lg:w-max lg:snap-none lg:gap-10 lg:overflow-visible lg:px-[8vw] lg:pb-0",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {SHOTS.map((shot) => (
            <figure key={shot.src} className="w-[86vw] shrink-0 snap-center sm:w-[60vw] lg:w-auto">
              <div
                data-shot
                className="relative overflow-hidden rounded-[14px] bg-app ring-1 ring-white/[0.12] lg:h-[62svh] lg:will-change-transform"
                style={{ aspectRatio: `${Math.min(Math.max(shot.aspect, 0.95), 1.7)}` }}
              >
                <img
                  /* responsive lossless variants from scripts/optimize-assets.mjs;
                     the image is 114% of its frame for the parallax drift */
                  {...screenshotImageProps(shot.src, "(min-width: 1024px) 80vw, 96vw")}
                  alt={shot.alt}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="absolute inset-y-0 left-[-7%] h-full w-[114%] max-w-none object-cover object-top lg:will-change-transform"
                />
              </div>
              <figcaption className="mt-5 max-w-[42ch]">
                <span className="block font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">
                  {shot.title}
                </span>
                <span className="mt-1 block text-[14.5px] leading-snug text-ink/55">
                  {shot.caption}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
