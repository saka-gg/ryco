import { describe, expect, it } from "vite-plus/test";

import { isAppWindowNavigationAllowed } from "./appWindowNavigation.ts";

const isDesktopDocumentUrl = (url: string) => url.startsWith("ryco://app/");
const backend = "http://127.0.0.1:7926";

function allowed(url: string, appUrls: readonly string[], desktopDocument = isDesktopDocumentUrl) {
  return isAppWindowNavigationAllowed({ url, appUrls, isDesktopDocumentUrl: desktopDocument });
}

describe("isAppWindowNavigationAllowed", () => {
  it("allows pages on the backend origin", () => {
    expect(allowed("http://127.0.0.1:7926/settings?x=1", [backend])).toBe(true);
  });

  it("rejects another port on the same host", () => {
    expect(allowed("http://127.0.0.1:7927/", [backend])).toBe(false);
  });

  it("rejects a foreign origin", () => {
    expect(allowed("https://evil.example/", [backend])).toBe(false);
  });

  it("allows the dev server origin when it is an app URL", () => {
    expect(allowed("http://localhost:5733/thread/a", [backend, "http://localhost:5733"])).toBe(
      true,
    );
  });

  it("allows desktop documents", () => {
    expect(allowed("ryco://app/boot.html", [backend])).toBe(true);
  });

  it("never matches an empty app URL", () => {
    expect(allowed("about:blank", [""])).toBe(false);
  });

  it("never matches opaque origins", () => {
    expect(allowed("file:///tmp/x.html", ["file:///tmp/y.html"], () => false)).toBe(false);
  });

  it("rejects text that is not a URL", () => {
    expect(allowed("not a url", [backend])).toBe(false);
  });
});
