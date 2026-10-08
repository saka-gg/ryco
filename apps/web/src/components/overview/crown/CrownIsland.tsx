import type { CSSProperties, ReactNode, Ref } from "react";

import type { CrownMode } from "./crownGeometry.logic";
import { CROWN_TONE_VAR, type CrownTone } from "./crownSections";

/**
 * The morphing island at the head of the rail (prototype `.crown`). Its
 * width and height are written by `useCrownGeometry` and animate in CSS; the
 * face, alert and card layers cross-fade inside it. `tone` drives the alert
 * glow and is kept after an alert ends so the glow fades out in its colour.
 */
export function CrownIsland({
  ref,
  ...props
}: {
  readonly mode: CrownMode;
  readonly tone: CrownTone | null;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className="crown-island crown-mat"
      data-slot="crown-island"
      data-mode={props.mode}
      style={props.tone ? ({ "--tone": CROWN_TONE_VAR[props.tone] } as CSSProperties) : undefined}
    >
      {props.children}
    </div>
  );
}
