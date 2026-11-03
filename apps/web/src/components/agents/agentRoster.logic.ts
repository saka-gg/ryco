/**
 * Pure monogram color for the agent roster surfaces (the Agents panel and the
 * crown's Subagents detail). Row text (elapsed time, status words and what an
 * agent is doing now) is shared from client-runtime (`subagentRoster`), which
 * the phone's agents sheet reads too.
 */

/** Relative luminance of #111827, the dark monogram ink. */
const MONOGRAM_DARK_INK_LUMINANCE = 0.0137;

/**
 * Letter color for a monogram on `hex`: dark on the light palette fills
 * (amber, lime, cyan…), white on the rest, whichever reads with more contrast.
 */
export function monogramInkColor(hex: string): "#111827" | "#ffffff" {
  const channels = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  const onWhite = 1.05 / (luminance + 0.05);
  const onDark = (luminance + 0.05) / (MONOGRAM_DARK_INK_LUMINANCE + 0.05);
  return onDark > onWhite ? "#111827" : "#ffffff";
}
