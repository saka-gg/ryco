import { describe, expect, it, vi } from "vite-plus/test";

import { createFaviconBadge, threadBadgeLabel, type FaviconBadgeHost } from "./threadAlertBadge";

/** Just enough of a `<link>` in `<head>` for the favicon badge. */
interface FakeLink {
  rel: string;
  type: string;
  href: string;
  readonly attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

/**
 * A head holding the icons index.html adds on load, and the badge's host
 * around it: the page load and the favicon image are released by the test.
 */
function page(input: { readonly loaded?: boolean; readonly canDraw?: boolean } = {}) {
  let children: FakeLink[] = [];
  const link = (init: Partial<Pick<FakeLink, "rel" | "type" | "href">> = {}): FakeLink => {
    const created: FakeLink = {
      rel: "",
      type: "",
      href: "",
      ...init,
      attributes: new Map(),
      setAttribute: (name, value) => created.attributes.set(name, value),
      remove: () => {
        children = children.filter((child) => child !== created);
      },
    };
    return created;
  };
  const isIcon = (child: FakeLink) => child.rel.split(/\s+/).includes("icon");
  const icon = link({
    rel: "icon",
    type: "image/png",
    href: "https://ryco.test/favicon-96x96.png",
  });
  const shortcutIcon = link({ rel: "shortcut icon", href: "https://ryco.test/favicon.ico" });
  const touchIcon = link({ rel: "apple-touch-icon", href: "https://ryco.test/touch.png" });
  children = [icon, shortcutIcon, touchIcon];
  const head = {
    querySelectorAll: () => children.filter(isIcon),
    querySelector: (selector: string) =>
      children.find(
        (child) => isIcon(child) && (!selector.includes("image/png") || child.type === "image/png"),
      ) ?? null,
    append: (...nodes: FakeLink[]) => {
      children.push(...nodes);
    },
  };

  let loaded = input.loaded ?? true;
  const onLoad: Array<() => void> = [];
  let resolveImage: (image: CanvasImageSource | null) => void = () => undefined;
  const baseImage = { width: 96 } as unknown as CanvasImageSource;
  const host: FaviconBadgeHost = {
    document: { head, createElement: () => link() } as unknown as FaviconBadgeHost["document"],
    whenLoaded: (apply) => (loaded ? apply() : onLoad.push(apply)),
    loadImage: vi.fn(
      () =>
        new Promise<CanvasImageSource | null>((resolve) => {
          resolveImage = resolve;
        }),
    ),
    draw: vi.fn((count: number, _base: CanvasImageSource | null) =>
      input.canDraw === false ? null : `data:image/png;base64,badge${count}`,
    ),
  };

  return {
    host,
    icon,
    shortcutIcon,
    touchIcon,
    children: () => children,
    load: () => {
      loaded = true;
      for (const apply of onLoad.splice(0)) apply();
    },
    loadFavicon: async () => {
      resolveImage(baseImage);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    baseImage,
  };
}

describe("threadBadgeLabel", () => {
  it("counts to nine", () => {
    expect([1, 9, 10, 42].map(threadBadgeLabel)).toEqual(["1", "9", "9+", "9+"]);
  });
});

describe("favicon badge", () => {
  it("stands in for every page icon while it shows, then gives them back", async () => {
    const test = page();
    const badge = createFaviconBadge(test.host);

    badge.set(2);
    await test.loadFavicon();
    expect(test.host.loadImage).toHaveBeenCalledWith("https://ryco.test/favicon-96x96.png");
    expect(test.host.draw).toHaveBeenLastCalledWith(2, test.baseImage);
    const [touchIcon, badgeLink, ...rest] = test.children();
    expect(touchIcon).toBe(test.touchIcon);
    expect(rest).toEqual([]);
    expect(badgeLink).toMatchObject({
      rel: "icon",
      type: "image/png",
      href: "data:image/png;base64,badge2",
    });
    expect(badgeLink?.attributes.has("data-ryco-badge")).toBe(true);

    badge.set(3);
    await test.loadFavicon();
    expect(test.children()).toEqual([test.touchIcon, badgeLink]);
    expect(badgeLink?.href).toBe("data:image/png;base64,badge3");
    expect(test.host.loadImage).toHaveBeenCalledTimes(1);

    badge.set(0);
    expect(test.children()).toEqual([test.touchIcon, test.icon, test.shortcutIcon]);
  });

  it("waits for the icons the page adds on load", async () => {
    const test = page({ loaded: false });
    const badge = createFaviconBadge(test.host);

    badge.set(1);
    expect(test.host.loadImage).not.toHaveBeenCalled();

    test.load();
    await test.loadFavicon();
    expect(test.children().map((child) => child.href)).toEqual([
      "https://ryco.test/touch.png",
      "data:image/png;base64,badge1",
    ]);
  });

  it("drops a count cleared while the favicon was loading", async () => {
    const test = page();
    const badge = createFaviconBadge(test.host);

    badge.set(1);
    badge.set(0);
    await test.loadFavicon();
    expect(test.host.draw).not.toHaveBeenCalled();
    expect(test.children()).toEqual([test.icon, test.shortcutIcon, test.touchIcon]);
  });

  it("keeps the page icons where the badge cannot be drawn", async () => {
    const test = page({ canDraw: false });
    const badge = createFaviconBadge(test.host);

    badge.set(1);
    await test.loadFavicon();
    expect(test.children()).toEqual([test.icon, test.shortcutIcon, test.touchIcon]);
  });
});
