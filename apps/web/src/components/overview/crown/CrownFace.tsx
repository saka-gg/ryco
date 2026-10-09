import { FolderIcon, MessageCircleDashedIcon } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type Ref } from "react";

import { ProjectFavicon } from "../../ProjectFavicon";
import type { CrownFaceLogo, CrownHeadline } from "./crownModel.logic";
import { CROWN_TONE_VAR } from "./crownSections";

/** The status dot pops when the headline changes tone: a spring overshoot. */
const STATUS_POP_KEYFRAMES: Keyframe[] = [
  { transform: "scale(0.4)" },
  { transform: "scale(1.25)" },
  { transform: "none" },
];
const STATUS_POP_TIMING: KeyframeAnimationOptions = {
  duration: 420,
  easing: "cubic-bezier(.34,1.56,.64,1)",
};

/**
 * The crown's resting face: the project's logo (a chat's glyph for a chat), a
 * status dot on its edge in the headline's tone, and the "+N" count of queued
 * alerts. A button: it opens the card on the headline's (or the shown alert's)
 * section, or collapses an open card.
 */
export function CrownFace({
  ref,
  ...props
}: {
  readonly logo: CrownFaceLogo;
  readonly headline: CrownHeadline;
  readonly queuedCount: number;
  readonly expanded: boolean;
  readonly reducedMotion: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  const { logo, headline, reducedMotion } = props;
  const { tone } = headline;
  const statusRef = useRef<HTMLSpanElement>(null);
  const lastToneRef = useRef(tone);

  useLayoutEffect(() => {
    if (lastToneRef.current === tone) return;
    lastToneRef.current = tone;
    // A neutral face hides the dot; there is nothing to pop.
    if (reducedMotion || tone === "neutral") return;
    statusRef.current?.animate(STATUS_POP_KEYFRAMES, STATUS_POP_TIMING);
  }, [tone, reducedMotion]);

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
      <span
        aria-hidden="true"
        className="crown-face-logo"
        data-slot="crown-face-logo"
        data-logo={logo.kind}
      >
        <FaceLogo logo={logo} />
      </span>
      <span
        ref={statusRef}
        aria-hidden="true"
        className="crown-face-status"
        data-slot="crown-face-status"
        data-tone={tone}
        data-pulse={headline.pulse || undefined}
        style={{ "--tone": CROWN_TONE_VAR[tone] } as CSSProperties}
      />
      {props.queuedCount > 0 ? (
        <b aria-hidden="true" className="crown-queue" data-slot="crown-queue">
          +{props.queuedCount}
        </b>
      ) : null}
    </button>
  );
}

function FaceLogo({ logo }: { readonly logo: CrownFaceLogo }) {
  switch (logo.kind) {
    case "project": {
      const { project } = logo;
      return (
        <ProjectFavicon
          key={project.id}
          environmentId={project.environmentId}
          cwd={project.cwd}
          projectId={project.id}
          customAvatarContentHash={project.customAvatarContentHash ?? null}
          fallbackName={project.name}
          fillContainer
        />
      );
    }
    case "chat":
      return <MessageCircleDashedIcon className="crown-face-glyph crown-face-chat" />;
    case "folder":
      return <FolderIcon className="crown-face-glyph crown-face-folder" />;
  }
}
