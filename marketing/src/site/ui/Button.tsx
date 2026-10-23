/**
 * The one button primitive. Hover rolls the label: the visible copy slides up
 * and an identical copy rises from below (pure CSS, so it freezes cleanly under
 * reduced motion). Fine pointers also get a gentle magnetic pull, driven by
 * GSAP quickTo on the element itself, never React state.
 */
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
/* gsap core only, not @/lib/motion: the changelog page uses this button and
   must not pull in the plugins, Lenis and their ticker */
import { gsap } from "gsap";
import { focusRing } from "../theme";

type Variant = "primary" | "ghost" | "light";

export function Button({
  href,
  children,
  icon,
  variant = "primary",
  size = "lg",
  external = false,
  magnetic = true,
  className,
  ariaLabel,
}: {
  href: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  variant?: Variant;
  size?: "lg" | "sm";
  external?: boolean;
  magnetic?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !magnetic) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const xTo = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3" });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.22);
      yTo((e.clientY - (r.top + r.height / 2)) * 0.3);
    };
    const leave = () => {
      xTo(0);
      yTo(0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      /* kill the reusable quickTo tweens, or they keep the detached page alive */
      xTo.tween.kill();
      yTo.tween.kill();
      gsap.set(el, { clearProps: "x,y" });
    };
  }, [magnetic]);

  return (
    <a
      ref={ref}
      href={href}
      aria-label={ariaLabel}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      className={cn(
        "group/btn relative inline-flex shrink-0 items-center justify-center gap-2.5 overflow-hidden whitespace-nowrap rounded-full font-medium transition-[background-color,border-color,color] duration-300 active:scale-[0.97]",
        size === "lg" ? "h-12 px-6 text-[15px]" : "h-9 px-4 text-[13.5px]",
        variant === "primary" && "bg-accent text-accent-ink hover:bg-[#ff7247]",
        variant === "light" && "bg-ink text-canvas hover:bg-white",
        variant === "ghost" &&
          "border border-white/15 text-ink hover:border-white/35 hover:bg-white/[0.04]",
        focusRing,
        className,
      )}
    >
      {icon && <span className="relative z-10 [&_svg]:size-[17px]">{icon}</span>}
      <span className="relative z-10 block overflow-hidden">
        <span className="block transition-transform duration-500 ease-ryco group-hover/btn:-translate-y-full">
          {children}
        </span>
        <span
          aria-hidden
          className="absolute inset-0 block translate-y-full transition-transform duration-500 ease-ryco group-hover/btn:translate-y-0"
        >
          {children}
        </span>
      </span>
    </a>
  );
}
