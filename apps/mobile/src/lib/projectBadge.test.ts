import { describe, expect, it } from "vite-plus/test";

import { PROJECT_BADGE_COLORS, projectBadgeColor, projectBadgeInitial } from "./projectBadge";

describe("project badge", () => {
  it("keeps one color per project", () => {
    expect(projectBadgeColor("project-a")).toBe(projectBadgeColor("project-a"));
    expect(PROJECT_BADGE_COLORS).toContain(projectBadgeColor("project-a"));
  });

  it("spreads projects over the palette", () => {
    const colors = new Set(
      Array.from({ length: 40 }, (_, index) => projectBadgeColor(`p${index}`)),
    );
    expect(colors.size).toBeGreaterThan(5);
  });

  it("takes the first letter or digit", () => {
    expect(projectBadgeInitial("web-app")).toBe("W");
    expect(projectBadgeInitial("  .dotfiles")).toBe("D");
    expect(projectBadgeInitial("2fa")).toBe("2");
    expect(projectBadgeInitial("über")).toBe("Ü");
    expect(projectBadgeInitial("---")).toBe("#");
  });
});
