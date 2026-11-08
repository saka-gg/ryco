import { describe, expect, it, vi } from "vite-plus/test";

import { goBackOrHome } from "./goBackOrHome";

function navigation(canGoBack: boolean) {
  return { canGoBack: () => canGoBack, goBack: vi.fn(), dispatch: vi.fn() };
}

describe("goBackOrHome", () => {
  it("goes back when there is a screen beneath", () => {
    const nav = navigation(true);
    goBackOrHome(nav);
    expect(nav.goBack).toHaveBeenCalled();
    expect(nav.dispatch).not.toHaveBeenCalled();
  });

  it("replaces a cold-opened screen with the tabs", () => {
    const nav = navigation(false);
    goBackOrHome(nav);
    expect(nav.goBack).not.toHaveBeenCalled();
    expect(nav.dispatch).toHaveBeenCalledWith({ type: "REPLACE", payload: { name: "Home" } });
  });
});
