/**
 * loadSharp - Loads sharp (native libvips) on first use.
 *
 * Avatars, attachment probes and HTML render thumbnails are the only users, so
 * the server never pays sharp's module load and native mapping at boot. The
 * module system caches the import after the first call.
 *
 * @module loadSharp
 */
import type sharp from "sharp";

export type SharpFactory = typeof sharp;

export const loadSharp = (): Promise<SharpFactory> =>
  import("sharp").then((module) => module.default);
