import type { ProjectId } from "@ryco/contracts";
import { FolderIcon, MessageCircleDashedIcon } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type Ref,
} from "react";

import { fitArtwork, type ArtworkFit } from "../../../lib/artworkFit.logic";
import { readArtworkAnalysis } from "../../../lib/readArtwork";
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

/** The logo disc's diameter (island.css) and a bare mark's inset from its edge, in px. */
const LOGO_SIZE = 38;
const LOGO_MARK_INSET = 6;

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
      <FaceLogo logo={logo} />
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

/**
 * The logo disc. Loaded artwork is framed by its pixels: an icon with its own
 * background is zoomed past any transparent margin, drop shadow or matte to
 * fill the disc edge to edge (ringed when its edge is too dark to show); a
 * bare glyph is inset on a plate that contrasts with it.
 */
function FaceLogo({ logo }: { readonly logo: CrownFaceLogo }) {
  const [framing, setFraming] = useState<{
    readonly projectId: ProjectId;
    readonly fit: ArtworkFit;
  } | null>(null);
  const fit =
    logo.kind === "project" && framing?.projectId === logo.project.id ? framing.fit : null;
  return (
    <span
      aria-hidden="true"
      className="crown-face-logo"
      data-slot="crown-face-logo"
      data-logo={logo.kind}
      data-fit={fit?.mode}
      data-plate={fit?.plate}
      data-ring={fit?.ring || undefined}
      style={fit ? logoFitStyle(fit) : undefined}
    >
      <FaceLogoContent
        logo={logo}
        onArtworkLoad={(projectId, image) =>
          setFraming({
            projectId,
            fit: fitArtwork({
              analysis: readArtworkAnalysis(image),
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              size: LOGO_SIZE,
              markInset: LOGO_MARK_INSET,
            }),
          })
        }
      />
    </span>
  );
}

function logoFitStyle(fit: ArtworkFit): CSSProperties {
  return {
    "--logo-w": `${fit.width}px`,
    "--logo-h": `${fit.height}px`,
    "--logo-x": `${fit.left}px`,
    "--logo-y": `${fit.top}px`,
  } as CSSProperties;
}

function FaceLogoContent({
  logo,
  onArtworkLoad,
}: {
  readonly logo: CrownFaceLogo;
  readonly onArtworkLoad: (projectId: ProjectId, image: HTMLImageElement) => void;
}) {
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
          onImageLoad={(image) => onArtworkLoad(project.id, image)}
        />
      );
    }
    case "chat":
      return <MessageCircleDashedIcon className="crown-face-glyph crown-face-chat" />;
    case "folder":
      return <FolderIcon className="crown-face-glyph crown-face-folder" />;
  }
}
