import { describe, expect, it } from "vitest";

import { PROJECT_SECTIONS } from "../projectsSearch";
import { PROJECT_SECTION_GROUPS, visibleProjectSections } from "./projectSectionTypes";

describe("project sections", () => {
  it("groups every section once, in page order", () => {
    expect(PROJECT_SECTION_GROUPS.flatMap((group) => group.sections)).toEqual([
      ...PROJECT_SECTIONS,
    ]);
  });

  it("leaves node-owned editors out for anyone but the device owner", () => {
    expect(visibleProjectSections({ canManageNode: true })).toEqual([...PROJECT_SECTIONS]);
    const visitor = visibleProjectSections({ canManageNode: false });
    expect(visitor).not.toContain("defaults");
    expect(visitor).not.toContain("integrations");
    expect(visitor).toContain("location");
    expect(visitor.at(-1)).toBe("danger");
  });
});
