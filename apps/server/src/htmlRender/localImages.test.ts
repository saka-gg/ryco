import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HTML_RENDER_MAX_IMAGE_BYTES } from "@ryco/shared/htmlRender";
import { Effect, FileSystem, Path } from "effect";

import { imageMimeType, inlineLocalImages } from "./localImages.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const posix = process.platform !== "win32";

/** A workspace root with files in it, and a sibling directory outside every root. */
const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-html-images-" });
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  yield* fs.makeDirectory(root);
  yield* fs.makeDirectory(outside);
  return { fs, path, root, outside };
});

it.layer(NodeServices.layer)("inlineLocalImages", (it) => {
  it.effect("inlines images by absolute path and leaves URLs and relative paths alone", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const png = path.join(root, "shot.png");
      const svg = path.join(root, "nested", "logo.svg");
      yield* fs.writeFile(png, PNG_BYTES);
      yield* fs.makeDirectory(path.dirname(svg));
      yield* fs.writeFileString(svg, "<svg/>");
      const kept = [
        "https://example.com/a.png",
        "//cdn.example.com/b.png",
        "./c.png",
        "data:image/png;base64,AAAA",
      ];

      const inlined = yield* inlineLocalImages(
        [
          `<img src="${png}"><div style="background:url(${svg})"></div>`,
          `<script>const shots = ['${png}', \`${svg}\`];</script>`,
          ...kept.map((src) => `<img src="${src}">`),
        ].join(""),
        [root],
      );

      const pngUri = `data:image/png;base64,${base64(PNG_BYTES)}`;
      const svgUri = `data:image/svg+xml;base64,${base64("<svg/>")}`;
      expect(inlined.missing).toEqual([]);
      expect(inlined.html).toContain(`<img src="${pngUri}">`);
      expect(inlined.html).toContain(`url(${svgUri})`);
      expect(inlined.html).toContain(`['${pngUri}', \`${svgUri}\`]`);
      expect(inlined.html).not.toContain(root);
      for (const src of kept) expect(inlined.html).toContain(`<img src="${src}">`);
    }).pipe(Effect.scoped),
  );

  it.effect("types a data URI by the bytes, not the file name", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const renamed = path.join(root, "actually-a-png.jpg");
      yield* fs.writeFile(renamed, PNG_BYTES);
      const inlined = yield* inlineLocalImages(`<img src="${renamed}">`, [root]);
      expect(inlined.html).toBe(`<img src="data:image/png;base64,${base64(PNG_BYTES)}">`);
    }).pipe(Effect.scoped),
  );

  it.effect("inlines an SVG behind processing instructions and a doctype subset", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const svg = path.join(root, "styled.svg");
      const source = [
        '<?xml version="1.0"?>',
        '<?xml-stylesheet href="theme.css"?>',
        '<!DOCTYPE svg [ <!ENTITY fill "red"> ]>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
      ].join("\n");
      yield* fs.writeFileString(svg, source);

      const inlined = yield* inlineLocalImages(`<img src="${svg}">`, [root]);

      expect(inlined.html).toContain(`data:image/svg+xml;base64,${base64(source)}`);
    }).pipe(Effect.scoped),
  );

  it.effect("lists every image it cannot read, including non-image bytes", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const folder = path.join(root, "folder.png");
      yield* fs.makeDirectory(folder);
      const missing = path.join(root, "missing.jpg");
      // Named like an image, but a symlink or renamed file must not carry other data.
      const secret = path.join(root, "secret.png");
      yield* fs.writeFileString(secret, "API_KEY=abc123");
      const report = path.join(root, "report.svg");
      yield* fs.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      // An <svg> inside a quoted entity, and a prolog shaped to stall a backtracking matcher.
      const config = path.join(root, "config.svg");
      yield* fs.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );
      const stalling = path.join(root, "stalling.svg");
      yield* fs.writeFileString(stalling, `${"<?p?>".repeat(40)}<config><svg/></config>`);
      const unclosed = path.join(root, "unclosed.svg");
      yield* fs.writeFileString(unclosed, '<!DOCTYPE svg [<!ENTITY a "x><svg/>');
      // Roots named SVG or svgé are other elements.
      const upper = path.join(root, "upper.svg");
      yield* fs.writeFileString(upper, "<SVG/>API_KEY=abc123");
      const longer = path.join(root, "longer.svg");
      yield* fs.writeFileString(longer, "<svg\u00e9/>API_KEY=abc123");
      const references = [
        missing,
        folder,
        "C:\\nope\\shot.webp",
        secret,
        report,
        config,
        stalling,
        unclosed,
        upper,
        longer,
      ];

      const inlined = yield* inlineLocalImages(
        references.map((reference) => `<img src="${reference}">`).join(""),
        [root],
      );

      expect(inlined.missing).toEqual([
        { path: missing, reason: "not-found" },
        { path: folder, reason: "not-a-file" },
        // Not an absolute path on POSIX; on Windows a drive outside every root.
        { path: "C:\\nope\\shot.webp", reason: "outside-roots" },
        ...[secret, report, config, stalling, unclosed, upper, longer].map((path) => ({
          path,
          reason: "not-an-image",
        })),
      ]);
      expect(inlined.html).not.toContain("data:");
    }).pipe(Effect.scoped),
  );

  it.effect("reads only images whose real location is inside an allowed root", () =>
    Effect.gen(function* () {
      const { fs, path, root, outside } = yield* workspace;
      const inside = path.join(root, "inside.png");
      const elsewhere = path.join(outside, "elsewhere.png");
      yield* fs.writeFile(inside, PNG_BYTES);
      yield* fs.writeFile(elsewhere, PNG_BYTES);
      // A relative climb out of the root resolves outside it too.
      const climbing = `${root}${path.sep}..${path.sep}outside${path.sep}elsewhere.png`;

      const inlined = yield* inlineLocalImages(
        `<img src="${inside}"><img src="${elsewhere}"><img src="${climbing}">`,
        [root],
      );

      expect(inlined.missing).toEqual([
        { path: elsewhere, reason: "outside-roots" },
        { path: climbing, reason: "outside-roots" },
      ]);
      expect(inlined.html).toContain(`<img src="data:image/png;base64,${base64(PNG_BYTES)}">`);
      const outsideRoots = [{ path: inside, reason: "outside-roots" }];
      // No roots, no images.
      expect((yield* inlineLocalImages(`<img src="${inside}">`, [])).missing).toEqual(outsideRoots);
      // A root that names the whole file system never counts.
      expect((yield* inlineLocalImages(`<img src="${inside}">`, ["/"])).missing).toEqual(
        outsideRoots,
      );
      // Outside every root, a missing file is refused like an existing one,
      // so refusals never tell what exists there.
      const absent = path.join(outside, "absent.png");
      expect((yield* inlineLocalImages(`<img src="${absent}">`, [root])).missing).toEqual([
        { path: absent, reason: "outside-roots" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!posix)("refuses links that lead outside every root", () =>
    Effect.gen(function* () {
      const { fs, path, root, outside } = yield* workspace;
      const target = path.join(outside, "private.png");
      yield* fs.writeFile(target, PNG_BYTES);
      const escapingLink = path.join(root, "escaping.png");
      yield* fs.symlink(target, escapingLink);
      const escapingDirectory = path.join(root, "linked-dir");
      yield* fs.symlink(outside, escapingDirectory);
      const hardLink = path.join(root, "hard.png");
      yield* fs.link(target, hardLink);
      // A link that stays inside the root is fine.
      const own = path.join(root, "own.png");
      yield* fs.writeFile(own, PNG_BYTES);
      const innerLink = path.join(root, "inner.png");
      yield* fs.symlink(own, innerLink);

      const viaDirectory = path.join(escapingDirectory, "private.png");
      const inlined = yield* inlineLocalImages(
        [escapingLink, viaDirectory, hardLink, innerLink]
          .map((src) => `<img src="${src}">`)
          .join(""),
        [root],
      );

      expect(inlined.missing).toEqual([
        { path: escapingLink, reason: "outside-roots" },
        { path: viaDirectory, reason: "outside-roots" },
        { path: hardLink, reason: "hard-link" },
      ]);
      expect(inlined.html).toContain(`<img src="data:image/png;base64,${base64(PNG_BYTES)}">`);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!posix)("accepts roots that are themselves reached through a symlink", () =>
    Effect.gen(function* () {
      const { fs, path, root, outside } = yield* workspace;
      const image = path.join(root, "shot.png");
      yield* fs.writeFile(image, PNG_BYTES);
      const linkedRoot = path.join(outside, "linked-root");
      yield* fs.symlink(root, linkedRoot);

      const inlined = yield* inlineLocalImages(`<img src="${path.join(linkedRoot, "shot.png")}">`, [
        linkedRoot,
      ]);

      expect(inlined.missing).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("fails on an image over the size limit", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const huge = path.join(root, "huge.png");
      yield* fs.writeFile(huge, PNG_BYTES);
      yield* fs.truncate(huge, HTML_RENDER_MAX_IMAGE_BYTES + 1);

      const error = yield* inlineLocalImages(`<img src="${huge}">`, [root]).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "HtmlRenderImageTooLargeError",
        path: huge,
        sizeBytes: HTML_RENDER_MAX_IMAGE_BYTES + 1,
      });
      expect(error.message).toBe(`${huge} is 10.0 MiB; each local image must be at most 10.0 MiB.`);
    }).pipe(Effect.scoped),
  );

  it.effect("fails when the inlined page would be over the page limit", () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* workspace;
      const large = path.join(root, "large.png");
      yield* fs.writeFile(large, PNG_BYTES);
      yield* fs.truncate(large, 7 * 1024 * 1024);

      // Three references to one 7 MiB image encode to about 28 MiB.
      const error = yield* inlineLocalImages(
        `<img src="${large}"><img src="${large}"><img src="${large}">`,
        [root],
      ).pipe(Effect.flip);

      expect(error._tag).toBe("HtmlRenderPageTooLargeError");
      expect(error.message).toMatch(
        /^With its images inlined the page is 28\.\d MiB; the limit is 25\.0 MiB\./,
      );
    }).pipe(Effect.scoped),
  );
});

it("recognizes image bytes", () => {
  const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  expect(imageMimeType(PNG_BYTES)).toBe("image/png");
  expect(imageMimeType(bytes("\xff\xd8\xff\xe0"))).toBe("image/jpeg");
  expect(imageMimeType(bytes("GIF89a"))).toBe("image/gif");
  expect(imageMimeType(bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageMimeType(bytes("\0\0\0\x1cftypavif"))).toBe("image/avif");
  expect(imageMimeType(bytes("\0\0\x01\0\x01\0"))).toBe("image/x-icon");
  expect(imageMimeType(bytes("BM\x36\0\0\0\0\0\0\0"))).toBe("image/bmp");
  expect(imageMimeType(bytes('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>'))).toBe(
    "image/svg+xml",
  );
  expect(imageMimeType(bytes("#!/bin/sh"))).toBeUndefined();
  expect(imageMimeType(bytes("<html><svg/></html>"))).toBeUndefined();
});
