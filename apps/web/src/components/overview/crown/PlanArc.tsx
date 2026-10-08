import { SparklesIcon } from "lucide-react";

/**
 * The Plan icon: a progress arc around the sparkles glyph. Like the check
 * ring, the dash is a presentation attribute so the first paint grows in from
 * `@starting-style` and later steps ease along the arc.
 */
export function PlanArc(props: { readonly pct: number }) {
  const pct = Math.min(100, Math.max(0, props.pct));
  return (
    <>
      <svg aria-hidden="true" className="crown-ring" viewBox="0 0 32 32">
        <circle className="crown-ring-track" cx={16} cy={16} r={12.5} />
        <circle
          className="crown-arc"
          cx={16}
          cy={16}
          r={12.5}
          pathLength={100}
          strokeDasharray={`${pct} 100`}
        />
      </svg>
      <SparklesIcon aria-hidden="true" className="crown-plan-glyph" />
    </>
  );
}
