// Run after the repository's frozen install; reuse its pinned image encoder.
import { createRequire } from "node:module";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const sharp = require("sharp");
const shots = new URL("../public/shots/", import.meta.url);
const manifest = {};
for (const name of (await readdir(shots)).filter((name) => name.endsWith(".png")).toSorted()) {
  const source = fileURLToPath(new URL(name, shots));
  const { width, height } = await sharp(source).metadata();
  const sizes = [...new Set([Math.min(640, width), Math.min(1280, width), width])];
  for (const size of sizes) {
    await sharp(source)
      .resize({ width: size })
      .webp({ lossless: true, effort: 6 })
      .toFile(fileURLToPath(new URL(`${name.slice(0, -4)}-${size}.webp`, shots)));
  }
  manifest[`/shots/${name}`] = {
    width,
    height,
    src: `/shots/${name.slice(0, -4)}-${width}.webp`,
    srcSet: sizes.map((size) => `/shots/${name.slice(0, -4)}-${size}.webp ${size}w`).join(", "),
  };
}
await writeFile(
  new URL("../src/lib/screenshotAssets.json", import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
// Preserve the production favicon's rounded white background and existing
// artwork, replacing its embedded 1 MB raster with the original vector paths.
const logo = await readFile(new URL("../../assets/logo_with_text.svg", import.meta.url), "utf8");
const favicon = logo.replace(
  /(<svg[^>]*>)/,
  '$1<rect width="1254" height="1254" rx="376.2" fill="white"/>',
);
for (const relative of [
  "../../assets/prod/favicon/favicon.svg",
  "../../apps/web/public/favicon.svg",
  "../public/favicon.svg",
]) {
  await writeFile(new URL(relative, import.meta.url), favicon);
}
