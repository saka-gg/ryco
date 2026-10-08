import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_THUMBNAIL_CHARS,
  readHtmlRenderMetadata,
} from "@ryco/shared/htmlRender";
import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { encodeHtmlRenderThumbnail, HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT } from "./thumbnails.ts";

const pngOf = async (image: Sharp) => (await image.png().toBuffer()).toString("base64");

/** A page screenshot: a header band in `top` above a body in `body`. */
const screenshot = (height: number, top: string, body: string) =>
  pngOf(
    sharp({
      create: { width: HTML_RENDER_COLUMN_WIDTH, height, channels: 3, background: body },
    }).composite([
      {
        input: {
          create: { width: HTML_RENDER_COLUMN_WIDTH, height: 40, channels: 3, background: top },
        },
        top: 0,
        left: 0,
      },
    ]),
  );

/** Busy, incompressible pixels, like a photo collage. */
const noise = (width: number, height: number) =>
  pngOf(
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#202020",
        noise: { type: "gaussian", mean: 128, sigma: 90 },
      },
    }),
  );

const decode = async (url: string) => {
  const [, format, data] = /^data:image\/(\w+);base64,(.+)$/.exec(url)!;
  const { data: pixels, info } = await sharp(Buffer.from(data!, "base64"))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
  };
  return { format, width: info.width, height: info.height, at };
};

const near = (actual: ReadonlyArray<number>, expected: ReadonlyArray<number>) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]!) <= 12);

describe("encodeHtmlRenderThumbnail", () => {
  it("captures exactly the thumbnail's shape of the page's top", () => {
    // 240 × 150 CSS pixels at the reply column's 760.
    expect(HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT).toBe(475);
  });

  it("scales the top of the page to twice the thumbnail size as a small WebP", async () => {
    const url = await encodeHtmlRenderThumbnail(
      await screenshot(HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT, "#d03030", "#202020"),
    );

    expect(url).toMatch(/^data:image\/webp;base64,/);
    expect(url!.length).toBeLessThan(HTML_RENDER_MAX_THUMBNAIL_CHARS / 4);
    // Clients accept it as a thumbnail.
    expect(readHtmlRenderMetadata({ title: "t", height: 300, thumbnails: { dark: url } })).toEqual({
      title: "t",
      height: 300,
      thumbnails: { dark: url },
    });
    const image = await decode(url!);
    expect([image.width, image.height]).toEqual([480, 300]);
    expect(near(image.at(10, 5), [0xd0, 0x30, 0x30])).toBe(true);
    expect(near(image.at(10, 200), [0x20, 0x20, 0x20])).toBe(true);
  });

  it("keeps the top of a screenshot taller than the thumbnail and scales a short one whole", async () => {
    const tall = await decode(
      (await encodeHtmlRenderThumbnail(await screenshot(1_200, "#3060d0", "#f0f0f0")))!,
    );
    expect([tall.width, tall.height]).toEqual([480, 300]);
    expect(near(tall.at(240, 5), [0x30, 0x60, 0xd0])).toBe(true);

    const short = await decode(
      (await encodeHtmlRenderThumbnail(await screenshot(190, "#3060d0", "#f0f0f0")))!,
    );
    expect([short.width, short.height]).toEqual([480, 120]);
  });

  it("lowers the quality, then falls back to JPEG, until a busy page fits", async () => {
    const busy = await noise(HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT);
    const url = await encodeHtmlRenderThumbnail(busy);
    expect(url!.length).toBeLessThanOrEqual(HTML_RENDER_MAX_THUMBNAIL_CHARS);

    // A budget only the last encodings fit.
    const webpAtLowest = (await encodeHtmlRenderThumbnail(busy, Number.MAX_SAFE_INTEGER))!;
    const tight = await encodeHtmlRenderThumbnail(busy, Math.floor(webpAtLowest.length / 3));
    expect(tight).toMatch(/^data:image\/jpeg;base64,/);
    expect(tight!.length).toBeLessThanOrEqual(Math.floor(webpAtLowest.length / 3));
  });

  it("gives up rather than store a thumbnail over budget", async () => {
    const busy = await noise(HTML_RENDER_COLUMN_WIDTH, HTML_RENDER_THUMBNAIL_CAPTURE_HEIGHT);
    expect(await encodeHtmlRenderThumbnail(busy, 1_000)).toBeUndefined();
  });

  it("rejects bytes that are not an image", async () => {
    await expect(
      encodeHtmlRenderThumbnail(Buffer.from("not a png").toString("base64")),
    ).rejects.toThrow();
  });
});
