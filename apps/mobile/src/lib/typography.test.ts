import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "./typography";

describe("mobile typography", () => {
  it("uses the intentional mobile font scale anchored at a 16pt body", () => {
    expect(Object.values(MOBILE_TYPOGRAPHY).map(({ fontSize }) => fontSize)).toEqual([
      11, 12, 13, 14, 16, 18, 21, 26, 30,
    ]);
    expect(MOBILE_TYPOGRAPHY.body).toEqual({ fontSize: 16, lineHeight: 23 });
  });

  it("uses caption-sized code with a compact readable row height", () => {
    expect(MOBILE_CODE_SURFACE).toMatchObject({
      fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
      lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
      rowHeight: 22,
    });
  });
});

describe("monospace font", () => {
  // `font-mono` resolves through `--font-mono`. Tailwind's default is a CSS
  // font stack, which React Native reads as a single family name that exists
  // on neither platform, so every `font-mono` text rendered proportional.
  const css = readFileSync(join(import.meta.dirname, "..", "..", "global.css"), "utf8");
  const platformVariables = (platform: "ios" | "android") =>
    css.match(new RegExp(`@variant ${platform} \\{([^}]*)\\}`))?.[1] ?? "";

  it("names a family each platform resolves to its system mono font", () => {
    // iOS maps `ui-monospace` to SF Mono; Android's generic `monospace` family.
    expect(platformVariables("ios")).toMatch(/--font-mono:\s*"ui-monospace";/);
    expect(platformVariables("android")).toMatch(/--font-mono:\s*"monospace";/);
  });
});
