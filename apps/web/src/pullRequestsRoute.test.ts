import { describe, expect, it, vi } from "vite-plus/test";

import { handleInAppLinkClick, prefersExternalPullRequestLink } from "./pullRequestsRoute";

function click(overrides: { metaKey?: boolean; ctrlKey?: boolean; button?: number } = {}) {
  return {
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    button: overrides.button ?? 0,
    preventDefault: vi.fn(),
  };
}

describe("prefersExternalPullRequestLink", () => {
  it("keeps the host link for ⌘, Ctrl and middle clicks", () => {
    expect(prefersExternalPullRequestLink(click())).toBe(false);
    expect(prefersExternalPullRequestLink(click({ metaKey: true }))).toBe(true);
    expect(prefersExternalPullRequestLink(click({ ctrlKey: true }))).toBe(true);
    expect(prefersExternalPullRequestLink(click({ button: 1 }))).toBe(true);
  });
});

describe("handleInAppLinkClick", () => {
  it("opens a plain click in the app instead of following the link", () => {
    const event = click();
    const openInApp = vi.fn();

    handleInAppLinkClick(event, openInApp);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(openInApp).toHaveBeenCalledOnce();
  });

  it("lets ⌘, Ctrl and middle clicks follow the host link", () => {
    for (const event of [
      click({ metaKey: true }),
      click({ ctrlKey: true }),
      click({ button: 1 }),
    ]) {
      const openInApp = vi.fn();

      handleInAppLinkClick(event, openInApp);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(openInApp).not.toHaveBeenCalled();
    }
  });

  it("follows the link when there is no in-app opener", () => {
    const event = click();

    handleInAppLinkClick(event, undefined);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
