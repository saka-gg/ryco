import { CheckIcon, CloudUploadIcon, SparklesIcon, XIcon, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type Ref } from "react";

import { CheckRing } from "./CheckRing";
import type { CheckRingSegment, CrownHeadline, CrownHeadlineGlyph } from "./crownModel.logic";
import { CROWN_TONE_VAR } from "./crownSections";

const GLYPH_ICON: Partial<Record<CrownHeadlineGlyph, LucideIcon>> = {
  x: XIcon,
  upload: CloudUploadIcon,
  sparkles: SparklesIcon,
  check: CheckIcon,
};

/** Prototype `Crown.face()` glyph entrance: a spring twist in. */
const GLYPH_SWAP_KEYFRAMES: Keyframe[] = [
  { transform: "scale(.3) rotate(-60deg)", opacity: 0 },
  { transform: "none", opacity: 1 },
];
const GLYPH_SWAP_TIMING: KeyframeAnimationOptions = {
  duration: 520,
  easing: "cubic-bezier(.34,1.56,.64,1)",
};

function FaceGlyph(props: { readonly glyph: CrownHeadlineGlyph }) {
  if (props.glyph === "spinner") return <span className="crown-spin" />;
  if (props.glyph === "dot") return <span className="crown-face-dot" />;
  const Icon = GLYPH_ICON[props.glyph];
  return Icon ? <Icon aria-hidden="true" /> : null;
}

/**
 * The crown's resting face: the CI ring, the headline glyph in its tone and
 * the "+N" count of queued alerts. A button: it opens the card on the
 * headline's (or the shown alert's) section, or collapses an open card.
 */
export function CrownFace({
  ref,
  ...props
}: {
  readonly headline: CrownHeadline;
  readonly segments: ReadonlyArray<CheckRingSegment>;
  readonly queuedCount: number;
  readonly expanded: boolean;
  readonly reducedMotion: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  const { headline, reducedMotion } = props;
  const glyphRef = useRef<HTMLSpanElement>(null);
  const glyphKey = `${headline.glyph}:${headline.tone}`;
  const lastGlyphKeyRef = useRef(glyphKey);

  useLayoutEffect(() => {
    if (lastGlyphKeyRef.current === glyphKey) return;
    lastGlyphKeyRef.current = glyphKey;
    if (reducedMotion) return;
    glyphRef.current?.animate(GLYPH_SWAP_KEYFRAMES, GLYPH_SWAP_TIMING);
  }, [glyphKey, reducedMotion]);

  return (
    <button
      ref={ref}
      type="button"
      className="crown-face"
      data-slot="crown-face"
      aria-label={`Overview: ${headline.title}`}
      aria-expanded={props.expanded}
      onClick={props.onClick}
    >
      <CheckRing segments={props.segments} viewBox={48} radius={19} className="crown-face-ring" />
      <span
        ref={glyphRef}
        aria-hidden="true"
        className="crown-face-glyph"
        data-glyph={headline.glyph}
        style={{ "--tone": CROWN_TONE_VAR[headline.tone] } as CSSProperties}
      >
        <FaceGlyph glyph={headline.glyph} />
      </span>
      {props.queuedCount > 0 ? (
        <b aria-hidden="true" className="crown-queue" data-slot="crown-queue">
          +{props.queuedCount}
        </b>
      ) : null}
    </button>
  );
}
