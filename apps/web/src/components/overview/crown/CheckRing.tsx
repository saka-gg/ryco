import { cn } from "~/lib/utils";

import type { CheckRingSegment } from "./crownModel.logic";

/**
 * The CI ring (prototype `segRing`): one `pathLength=100` arc per check run
 * around a faint track. Dash values are presentation attributes, not inline
 * style, so the stylesheet's `@starting-style` can grow new arcs in from zero
 * and changes animate through the `.crown-ring-seg` transition.
 */
export function CheckRing(props: {
  readonly segments: ReadonlyArray<CheckRingSegment>;
  /** viewBox edge; the ring is centred in it. */
  readonly viewBox: number;
  readonly radius: number;
  readonly className?: string;
}) {
  const centre = props.viewBox / 2;
  return (
    <svg
      aria-hidden="true"
      className={cn("crown-ring", props.className)}
      viewBox={`0 0 ${props.viewBox} ${props.viewBox}`}
    >
      <circle className="crown-ring-track" cx={centre} cy={centre} r={props.radius} />
      {props.segments.map((segment) => (
        <circle
          key={segment.key}
          className="crown-ring-seg"
          data-s={segment.state}
          cx={centre}
          cy={centre}
          r={props.radius}
          pathLength={100}
          strokeDasharray={`${segment.len} ${100 - segment.len}`}
          strokeDashoffset={segment.offset}
        />
      ))}
    </svg>
  );
}
