/*
 * The mini-player's few glyphs, drawn here rather than imported from lucide:
 * a lucide icon another lazy chunk also imports joins the shared icon groups,
 * and those shift into chunks the chat route loads at once (see
 * `viteBuild/codeSplitting.ts`). Paths follow lucide (ISC).
 */

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function GripGlyph(props: { readonly className?: string }) {
  return (
    <svg {...SVG_PROPS} className={props.className}>
      <circle cx="12" cy="9" r="1" />
      <circle cx="19" cy="9" r="1" />
      <circle cx="5" cy="9" r="1" />
      <circle cx="12" cy="15" r="1" />
      <circle cx="19" cy="15" r="1" />
      <circle cx="5" cy="15" r="1" />
    </svg>
  );
}

export function DockGlyph(props: { readonly className?: string }) {
  return (
    <svg {...SVG_PROPS} className={props.className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m10 15-3-3 3-3" />
    </svg>
  );
}

export function CloseGlyph(props: { readonly className?: string }) {
  return (
    <svg {...SVG_PROPS} className={props.className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
