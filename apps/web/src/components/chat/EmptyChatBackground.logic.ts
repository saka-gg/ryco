/**
 * The animated background of an empty chat: a grid of short strokes (flow
 * field) or dots (halftone) whose brightness follows drifting value noise and a
 * slow wave, after Synara's empty-chat ASCII field (same noise, wave presets,
 * center falloff and timing). A click drops a vortex that twists the grid
 * around the click point in the accent color, then unwinds.
 *
 * Pure: the component owns the canvas, timing and input; this module turns a
 * moment in time into the cells to draw.
 */

export type EmptyChatBackgroundVariant = "flow" | "halftone";

/** Cell pitch in CSS pixels. */
export const CELL_SIZE: Readonly<Record<EmptyChatBackgroundVariant, number>> = {
  flow: 15,
  halftone: 9,
};

/** Peak opacity of the field (before the vortex), per variant. */
const BASE_ALPHA: Readonly<Record<EmptyChatBackgroundVariant, number>> = {
  flow: 0.42,
  halftone: 0.32,
};

/** Frame interval while idle and while a vortex is playing. */
export const IDLE_FRAME_MS = 1000 / 15;
export const ACTIVE_FRAME_MS = 1000 / 40;
/** The field fades in over this long after the first frame. */
export const FADE_IN_MS = 1200;
/** Canvas pixel budget: the device pixel ratio drops on very large panes. */
export const MAX_CANVAS_PIXELS = 4e6;

const WAVE_CYCLE_MS = 20_000;
const WAVE_BLEND_MS = 4_000;
/** The field is sampled every LATTICE_STEP cells and interpolated between. */
const LATTICE_STEP = 2;
/** Opacity steps the draw batches by; one fill per step and color. */
export const ALPHA_STEPS = 24;

export const VORTEX_LIFE_MS = 3200;
export const MAX_VORTICES = 6;

export interface WavePreset {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly waveX: number;
  readonly waveY: number;
  readonly waveLength: number;
  readonly waveSpeed: number;
  readonly radial: boolean;
}

/** Synara's three presets: diagonal swell, horizontal bands, rings from the center. */
export const WAVE_PRESETS: ReadonlyArray<WavePreset> = [
  {
    scaleX: 190,
    scaleY: 150,
    driftX: 0.1,
    driftY: -0.06,
    waveX: 0.8,
    waveY: 0.6,
    waveLength: 70,
    waveSpeed: 1.3,
    radial: false,
  },
  {
    scaleX: 360,
    scaleY: 80,
    driftX: 0.16,
    driftY: 0.01,
    waveX: 0.25,
    waveY: 1,
    waveLength: 38,
    waveSpeed: 1.8,
    radial: false,
  },
  {
    scaleX: 150,
    scaleY: 150,
    driftX: -0.06,
    driftY: 0.09,
    waveX: 0,
    waveY: 0,
    waveLength: 55,
    waveSpeed: 1.5,
    radial: true,
  },
];

export interface Vortex {
  readonly x: number;
  readonly y: number;
  readonly startMs: number;
}

function hash(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function noisePlane(x: number, y: number, z: number, u: number, v: number): number {
  return lerp(
    lerp(hash(x, y, z), hash(x + 1, y, z), u),
    lerp(hash(x, y + 1, z), hash(x + 1, y + 1, z), u),
    v,
  );
}

/** Smooth 3D value noise in [0, 1). */
export function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const u = smoothstep(0, 1, x - ix);
  const v = smoothstep(0, 1, y - iy);
  return lerp(
    noisePlane(ix, iy, iz, u, v),
    noisePlane(ix, iy, iz + 1, u, v),
    smoothstep(0, 1, z - iz),
  );
}

/** The field at a point: how much shows (`patch`) and the wave's phase there (`wave`), both 0-1. */
export function sampleField(
  preset: WavePreset,
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  seconds: number,
): { readonly patch: number; readonly wave: number } {
  const noise =
    0.68 *
      valueNoise(
        x / preset.scaleX + seconds * preset.driftX,
        y / preset.scaleY + seconds * preset.driftY,
        seconds * 0.18,
      ) +
    0.32 * valueNoise(x / 70 - seconds * 0.08, y / 52, seconds * 0.35 + 17);
  const distance = preset.radial
    ? Math.hypot(x - centerX, y - centerY)
    : x * preset.waveX + y * preset.waveY;
  const wave =
    0.5 + 0.5 * Math.sin(distance / preset.waveLength - seconds * preset.waveSpeed + noise * 5);
  return { patch: smoothstep(0.4, 0.78, noise + 0.1 * (wave - 0.5)), wave };
}

/** A vortex's strength at its center for an age: rises, holds, unwinds to zero at the end. */
export function vortexEnvelope(ageMs: number): number {
  if (ageMs <= 0 || ageMs >= VORTEX_LIFE_MS) return 0;
  return Math.sin(Math.PI * (ageMs / VORTEX_LIFE_MS)) ** 1.4;
}

/** The vortex's reach (the Gaussian's sigma), growing for 1.2 s. */
export function vortexRadius(ageMs: number): number {
  return 45 + Math.min(Math.max(ageMs, 0), 1200) * 0.09;
}

function shortestAngleLerp(from: number, to: number, t: number): number {
  const turn = Math.PI * 2;
  const delta = ((((to - from + Math.PI) % turn) + turn) % turn) - Math.PI;
  return from + delta * t;
}

/** One frame's geometry: per cell, position, size, angle and the two opacities. */
export interface BackgroundFrame {
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Field value 0-1 (stroke length / dot area). */
  readonly value: Float32Array;
  readonly angle: Float32Array;
  readonly size: Float32Array;
  /** Opacity in the foreground color. */
  readonly inkAlpha: Float32Array;
  /** Opacity in the accent color. */
  readonly accentAlpha: Float32Array;
}

export interface BackgroundGrid {
  readonly variant: EmptyChatBackgroundVariant;
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly latticeCols: number;
  readonly latticeRows: number;
  readonly patchLattice: Float32Array;
  readonly waveLattice: Float32Array;
  readonly angleLattice: Float32Array;
  readonly frame: BackgroundFrame;
}

export function createBackgroundGrid(
  variant: EmptyChatBackgroundVariant,
  width: number,
  height: number,
): BackgroundGrid {
  const cell = CELL_SIZE[variant];
  const cols = Math.max(1, Math.ceil(width / cell) + 1);
  const rows = Math.max(1, Math.ceil(height / cell) + 1);
  const latticeCols = Math.ceil(cols / LATTICE_STEP) + 1;
  const latticeRows = Math.ceil(rows / LATTICE_STEP) + 1;
  const latticeSize = latticeCols * latticeRows;
  const cells = cols * rows;
  return {
    variant,
    width,
    height,
    cell,
    cols,
    rows,
    latticeCols,
    latticeRows,
    patchLattice: new Float32Array(latticeSize),
    waveLattice: new Float32Array(latticeSize),
    angleLattice: new Float32Array(latticeSize),
    frame: {
      count: 0,
      x: new Float32Array(cells),
      y: new Float32Array(cells),
      value: new Float32Array(cells),
      angle: new Float32Array(cells),
      size: new Float32Array(cells),
      inkAlpha: new Float32Array(cells),
      accentAlpha: new Float32Array(cells),
    },
  };
}

export interface FrameInput {
  /** Milliseconds since the background started. */
  readonly elapsedMs: number;
  /** Noise time in seconds (elapsed plus a per-mount random offset). */
  readonly seconds: number;
  /** Index into WAVE_PRESETS the cycle starts at. */
  readonly firstPreset: number;
  /** 0-1 fade-in. */
  readonly fade: number;
  /** Live vortices, ages computed against `nowMs`. */
  readonly vortices: ReadonlyArray<Vortex>;
  readonly nowMs: number;
}

/** Fills `grid.frame` for one moment; returns the number of cells written. */
export function computeBackgroundFrame(grid: BackgroundGrid, input: FrameInput): number {
  const { cell, cols, rows, latticeCols, latticeRows, width, height, variant } = grid;
  const { patchLattice, waveLattice, angleLattice, frame } = grid;
  const { seconds, fade, vortices, nowMs } = input;
  const cycle = Math.floor(input.elapsedMs / WAVE_CYCLE_MS);
  const presetCount = WAVE_PRESETS.length;
  const preset = WAVE_PRESETS[(input.firstPreset + cycle) % presetCount]!;
  const blend = smoothstep(
    WAVE_CYCLE_MS - WAVE_BLEND_MS,
    WAVE_CYCLE_MS,
    input.elapsedMs % WAVE_CYCLE_MS,
  );
  const nextPreset =
    blend > 0 ? WAVE_PRESETS[(input.firstPreset + cycle + 1) % presetCount]! : null;
  const centerX = width / 2;
  const centerY = height / 2;
  const flow = variant === "flow";

  for (let row = 0; row < latticeRows; row += 1) {
    const y = (row * LATTICE_STEP + 0.5) * cell;
    for (let col = 0; col < latticeCols; col += 1) {
      const x = (col * LATTICE_STEP + 0.5) * cell;
      const index = row * latticeCols + col;
      const sample = sampleField(preset, x, y, centerX, centerY, seconds);
      let patch = sample.patch;
      let wave = sample.wave;
      if (nextPreset) {
        const next = sampleField(nextPreset, x, y, centerX, centerY, seconds);
        patch += (next.patch - patch) * blend;
        wave += (next.wave - wave) * blend;
      }
      patchLattice[index] = patch;
      waveLattice[index] = wave;
      if (flow) angleLattice[index] = valueNoise(x / 170, y / 170, seconds * 0.09);
    }
  }

  const live: Array<{ x: number; y: number; envelope: number; radius: number; reach: number }> = [];
  for (const vortex of vortices) {
    const age = nowMs - vortex.startMs;
    const envelope = vortexEnvelope(age);
    if (envelope <= 0.02) continue;
    const radius = vortexRadius(age);
    live.push({ x: vortex.x, y: vortex.y, envelope, radius, reach: radius * 2.8 });
  }

  const baseAlpha = BASE_ALPHA[variant];
  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    const baseY = (row + 0.5) * cell;
    const latticeRow = Math.floor(row / LATTICE_STEP);
    const fy = (row % LATTICE_STEP) / LATTICE_STEP;
    const dy = (baseY - centerY) / (height * 0.3);
    for (let col = 0; col < cols; col += 1) {
      const baseX = (col + 0.5) * cell;
      const latticeCol = Math.floor(col / LATTICE_STEP);
      const fx = (col % LATTICE_STEP) / LATTICE_STEP;
      const top = latticeRow * latticeCols + latticeCol;
      const bottom = top + latticeCols;
      const patch = lerp(
        lerp(patchLattice[top]!, patchLattice[top + 1]!, fx),
        lerp(patchLattice[bottom]!, patchLattice[bottom + 1]!, fx),
        fy,
      );
      const wave = lerp(
        lerp(waveLattice[top]!, waveLattice[top + 1]!, fx),
        lerp(waveLattice[bottom]!, waveLattice[bottom + 1]!, fx),
        fy,
      );
      const dx = (baseX - centerX) / (width * 0.3);
      // Quieter behind the headline and composer, full strength toward the edges.
      const falloff = Math.min(1, 0.45 + 0.55 * Math.sqrt(dx * dx + dy * dy));
      let value = patch * patch * (0.4 + 0.6 * wave) * falloff * fade;
      let angle = flow
        ? lerp(
            lerp(angleLattice[top]!, angleLattice[top + 1]!, fx),
            lerp(angleLattice[bottom]!, angleLattice[bottom + 1]!, fx),
            fy,
          ) *
          Math.PI *
          4
        : 0;
      let x = baseX;
      let y = baseY;
      let size = 1;
      let tint = 0;

      for (const vortex of live) {
        const ox = baseX - vortex.x;
        const oy = baseY - vortex.y;
        if (Math.abs(ox) > vortex.reach || Math.abs(oy) > vortex.reach) continue;
        const falloffSq = (ox * ox + oy * oy) / (2 * vortex.radius * vortex.radius);
        const strength = Math.exp(-falloffSq) * vortex.envelope;
        if (strength < 0.02) continue;
        const twist = strength * 2.4;
        const cos = Math.cos(twist);
        const sin = Math.sin(twist);
        // Rotate the cell around the click, keeping any earlier vortex's offset.
        x = vortex.x + ox * cos - oy * sin + (x - baseX);
        y = vortex.y + ox * sin + oy * cos + (y - baseY);
        angle = shortestAngleLerp(
          angle,
          Math.atan2(oy, ox) + twist + Math.PI / 2,
          Math.min(1, strength * 1.6),
        );
        value = Math.max(value, strength * 0.7);
        size *= 1 + 0.3 * strength;
        tint = Math.max(tint, strength * 0.6);
      }

      const alpha = value * baseAlpha;
      const inkAlpha = Math.min(1, alpha * (1 - Math.min(1, tint * 1.6)));
      const accentAlpha =
        tint > 0.05 ? Math.min(1, alpha + tint * (0.35 + 0.55 * Math.max(patch, value))) : 0;
      if (inkAlpha < 0.01 && accentAlpha < 0.02) continue;
      frame.x[count] = x;
      frame.y[count] = y;
      frame.value[count] = tint > 0.05 ? Math.max(value, 0.25 * tint) : value;
      frame.angle[count] = angle;
      frame.size[count] = size;
      frame.inkAlpha[count] = inkAlpha >= 0.01 ? inkAlpha : 0;
      frame.accentAlpha[count] = accentAlpha >= 0.02 ? accentAlpha : 0;
      count += 1;
    }
  }
  frame.count = count;
  return count;
}

/** Whether any vortex is still playing at `nowMs`. */
export function hasLiveVortex(vortices: ReadonlyArray<Vortex>, nowMs: number): boolean {
  return vortices.some((vortex) => nowMs - vortex.startMs < VORTEX_LIFE_MS);
}

/** The device pixel ratio for a pane, capped at 2 and by the canvas pixel budget. */
export function canvasPixelRatio(devicePixelRatio: number, width: number, height: number): number {
  return Math.min(
    devicePixelRatio || 1,
    2,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)),
  );
}

/** A stroke's half-length (flow) or a dot's radius (halftone) for a cell. */
export function cellExtent(
  variant: EmptyChatBackgroundVariant,
  value: number,
  size: number,
): number {
  const cell = CELL_SIZE[variant];
  return variant === "flow"
    ? Math.min(cell * 0.9, cell * 0.5 * (0.35 + 0.65 * value) * size)
    : Math.min(cell * 0.8, cell * 0.48 * Math.sqrt(value) * size);
}
