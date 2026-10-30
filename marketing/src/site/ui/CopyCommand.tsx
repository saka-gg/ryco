/**
 * A copyable shell command. Copy feedback scrambles the label to "Copied" and
 * back, so the acknowledgement happens where your eyes already are.
 */
import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { gsap, prefersReducedMotion } from "@/lib/motion";
import { focusRing } from "../theme";

export function CopyCommand({ command, className }: { command: string; className?: string }) {
  const label = useRef<HTMLSpanElement>(null);
  const [copied, setCopied] = useState(false);

  const flash = (text: string) => {
    const el = label.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = text;
      return;
    }
    gsap.to(el, {
      duration: 0.5,
      scrambleText: { text, chars: "abcdefghijklmnopqrstuvwxyz-_/", speed: 0.6 },
      ease: "none",
    });
  };

  const copy = () => {
    navigator.clipboard?.writeText(command).then(
      () => {
        setCopied(true);
        flash("Copied to clipboard");
        window.setTimeout(() => {
          setCopied(false);
          flash(command);
        }, 1500);
      },
      () => {},
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : `Copy command: ${command}`}
      className={cn(
        "group/copy inline-flex h-12 items-center gap-3 rounded-full border border-white/12 bg-white/[0.03] pl-5 pr-4 font-mono text-[13.5px] text-ink/85 transition-colors hover:border-white/30 hover:bg-white/[0.06]",
        focusRing,
        className,
      )}
    >
      <span className="select-none text-accent">$</span>
      <span ref={label} className="min-w-[17ch] text-left">
        {command}
      </span>
      <span className="text-ink/45 transition-colors group-hover/copy:text-ink/85">
        {copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
      </span>
    </button>
  );
}
