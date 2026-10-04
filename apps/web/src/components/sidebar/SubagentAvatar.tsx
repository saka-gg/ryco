import { useMemo } from "react";
import { fnv1a32 } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

/**
 * Vivid, mutually distinguishable accent colors that read well on both the dark
 * and light card surfaces. Each subagent is deterministically mapped to one so
 * its identicon stays stable across renders and surfaces.
 */
const SUBAGENT_AVATAR_PALETTE = [
  "#f97316", // orange
  "#a855f7", // purple
  "#6366f1", // indigo
  "#3b82f6", // blue
  "#0ea5e9", // sky
  "#06b6d4", // cyan
  "#14b8a6", // teal
  "#22c55e", // green
  "#84cc16", // lime
  "#eab308", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#f43f5e", // rose
  "#8b5cf6", // violet
] as const;

const AVATAR_GRID = 5;
const AVATAR_CELL = 4;
const AVATAR_DIM = AVATAR_GRID * AVATAR_CELL;
const AVATAR_CELL_INSET = 0.4;
const AVATAR_CELL_SIZE = AVATAR_CELL - AVATAR_CELL_INSET * 2;

export function subagentAvatarColor(seed: string): string {
  return SUBAGENT_AVATAR_PALETTE[fnv1a32(seed) % SUBAGENT_AVATAR_PALETTE.length]!;
}

interface SubagentAvatarShape {
  color: string;
  cells: boolean[];
}

function buildSubagentAvatar(seed: string): SubagentAvatarShape {
  const color = subagentAvatarColor(seed);
  // A second, decorrelated hash drives the pixel pattern so two seeds that share
  // a color still get visually distinct glyphs.
  const patternHash = fnv1a32(`avatar:${seed}`);
  const cells: boolean[] = [];
  for (let row = 0; row < AVATAR_GRID; row += 1) {
    for (let col = 0; col < AVATAR_GRID; col += 1) {
      // Mirror the left half onto the right for a balanced, identicon-like glyph.
      const sourceCol = col < 3 ? col : AVATAR_GRID - 1 - col;
      const bitIndex = row * 3 + sourceCol;
      cells.push(((patternHash >>> bitIndex) & 1) === 1);
    }
  }
  // Guarantee a visible glyph even for the rare all-empty hash.
  if (!cells.some(Boolean)) {
    for (let row = 0; row < AVATAR_GRID; row += 1) {
      cells[row * AVATAR_GRID + 2] = true;
    }
  }
  return { color, cells };
}

export function SubagentAvatar({ name, className }: { name: string; className?: string }) {
  const { color, cells } = useMemo(() => buildSubagentAvatar(name), [name]);
  return (
    <svg
      viewBox={`0 0 ${AVATAR_DIM} ${AVATAR_DIM}`}
      className={cn("size-5 shrink-0", className)}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      {cells.map((on, index) => {
        if (!on) {
          return null;
        }
        const row = Math.floor(index / AVATAR_GRID);
        const col = index % AVATAR_GRID;
        return (
          <rect
            key={`${row}-${col}`}
            x={col * AVATAR_CELL + AVATAR_CELL_INSET}
            y={row * AVATAR_CELL + AVATAR_CELL_INSET}
            width={AVATAR_CELL_SIZE}
            height={AVATAR_CELL_SIZE}
            rx={0.6}
            fill={color}
          />
        );
      })}
    </svg>
  );
}

export default SubagentAvatar;
