/**
 * A muted product loop (real screen recordings in /public/media). It loads
 * nothing until it nears the viewport, plays only while visible, and under
 * reduced motion stays on its poster frame.
 */
import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/lib/motion";

export function LoopVideo({
  src,
  label,
  className,
  ...rest
}: {
  /** Path without extension; `.webm`, `.mp4` and `-poster.webp` sit beside it. */
  src: string;
  label: string;
  className?: string;
  [k: `data-${string}`]: string | boolean | undefined;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video || reduced) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (video.preload === "none") video.preload = "auto";
          /* autoplay can still be refused (data saver, low power); the poster stays */
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(video);
    return () => {
      io.disconnect();
      video.pause();
    };
  }, [reduced]);

  return (
    <video
      ref={ref}
      {...rest}
      aria-label={label}
      className={className}
      poster={`${src}-poster.webp`}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
    >
      <source src={`${src}.webm`} type="video/webm" />
      <source src={`${src}.mp4`} type="video/mp4" />
    </video>
  );
}
